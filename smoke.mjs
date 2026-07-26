// Tool-level smoke test. Loads the plugin graph through jiti — the SAME loader
// the OpenClaw gateway uses — so `.js` import specifiers resolve to `.ts` just
// like they will in production. Run: `node smoke.mjs` (or `pnpm smoke`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const { createTaskTool } = await jiti.import("./task-tool.ts");
const { TaskStore } = await jiti.import("./store.ts");
const { createBoardRoutes } = await jiti.import("./board.ts");
const pluginMod = await jiti.import("./index.ts");
const plugin = pluginMod.default ?? pluginMod;

// plugin entry shape
assert.equal(plugin.id, "agenda-clo");
assert.equal(typeof plugin.register, "function");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-smoke-"));
const parse = (r) => r.details;

const store = new TaskStore(path.join(dir, "tasks.json"));
const tool = createTaskTool({ agentId: "proj-x", store });
assert.equal(tool.name, "task");
assert.ok(tool.parameters && typeof tool.parameters === "object"); // TypeBox schema built

const added = parse(await tool.execute("c1", { action: "add", title: "write spec", notes: "draft" }));
assert.equal(added.status, "todo");
assert.ok(added.id);

const listed = parse(await tool.execute("c2", { action: "list" }));
assert.equal(listed.project, "proj-x");
assert.equal(listed.summary.total, 1);

const upd = parse(await tool.execute("c3", { action: "update", id: added.id, status: "doing" }));
assert.equal(upd.status, "doing");

const done = parse(await tool.execute("c4", { action: "done", id: added.id }));
assert.equal(done.status, "done");
assert.ok(done.doneAt);

// error path returns a structured error, not a throw
const err = parse(await tool.execute("c5", { action: "add" }));
assert.ok(err.error && /title required/.test(err.error));

const rm = parse(await tool.execute("c6", { action: "remove", id: added.id }));
assert.equal(rm.removed, true);
assert.equal(parse(await tool.execute("c7", { action: "list" })).summary.total, 0);

// registerTool factory wiring: emulate the api and confirm the tool is scoped to ctx.agentId
let captured = null;
const registeredRoutes = [];
plugin.register({
  pluginConfig: { storePath: path.join(dir, "viaRegister.json"), board: { enabled: false } },
  runtime: {},
  logger: {},
  resolvePath: (p) => (path.isAbsolute(p) ? p : path.join(here, p)),
  registerTool: (factory) => {
    captured = factory({ agentId: "proj-y" });
  },
  registerHttpRoute: (route) => registeredRoutes.push(route),
});
assert.equal(typeof captured?.execute, "function");
const y = parse(await captured.execute("c8", { action: "add", title: "in project y" }));
assert.equal(y.agentId, "proj-y");

// register() with board enabled wires up exactly the two exact routes
const routeReg = [];
plugin.register({
  pluginConfig: { storePath: path.join(dir, "viaRegister2.json") },
  runtime: {},
  logger: {},
  resolvePath: (p) => (path.isAbsolute(p) ? p : path.join(here, p)),
  registerTool: () => {},
  registerHttpRoute: (route) => routeReg.push(route.path),
});
assert.deepEqual(routeReg.sort(), ["/agenda", "/agenda/tasks"]);

// --- board HTTP routes ------------------------------------------------------
function mockReq(method, url, body) {
  const req = body !== undefined ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { if (chunk) this.body += chunk; this.headersSent = true; },
  };
}
async function call(routes, method, url, body) {
  const isApi = url.split("?")[0].endsWith("/tasks");
  const route = routes.find((r) => (isApi ? r.path.endsWith("/tasks") : !r.path.endsWith("/tasks")));
  const res = mockRes();
  await route.handler(mockReq(method, url, body), res);
  const json = res.headers["content-type"]?.includes("json");
  return { status: res.statusCode, body: res.body, json: json && res.body ? JSON.parse(res.body) : undefined };
}

// Board store seeded across two projects.
const boardStore = new TaskStore(path.join(dir, "board.json"));
boardStore.add({ agentId: "alpha", title: "a1" });
boardStore.add({ agentId: "beta", title: "b1" });

// Read-only board (no token): GET lists all projects, page renders, POST is refused.
{
  const routes = createBoardRoutes({ store: boardStore, path: "/agenda" });
  const list = await call(routes, "GET", "/agenda/tasks");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.projects.map((p) => p.agentId), ["alpha", "beta"]);

  const page = await call(routes, "GET", "/agenda");
  assert.equal(page.status, 200);
  assert.ok(/<title>AgendaClo<\/title>/.test(page.body));
  assert.ok(!/#6[^\x00-\x7f]/.test(page.body)); // no stray non-ascii snuck into the CSS

  const blocked = await call(routes, "POST", "/agenda/tasks", { op: "add", project: "alpha", title: "nope" });
  assert.equal(blocked.status, 403);
  assert.equal(boardStore.list({ agentId: "alpha" }).length, 1); // unchanged
}

// Token board: GET/POST require the token; writes work with it.
{
  const routes = createBoardRoutes({ store: boardStore, path: "/agenda", token: "s3cret" });
  assert.equal((await call(routes, "GET", "/agenda/tasks")).status, 401); // no token
  assert.equal((await call(routes, "GET", "/agenda")).status, 401); // page gated too
  assert.equal((await call(routes, "GET", "/agenda/tasks?token=s3cret")).status, 200);

  const wrong = await call(routes, "POST", "/agenda/tasks?token=nope", { op: "add", project: "alpha", title: "x" });
  assert.equal(wrong.status, 401);

  const ok = await call(routes, "POST", "/agenda/tasks?token=s3cret", { op: "add", project: "alpha", title: "via board" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.title, "via board");
  assert.equal(boardStore.list({ agentId: "alpha" }).length, 2);

  const done = await call(routes, "POST", "/agenda/tasks?token=s3cret", { op: "done", project: "alpha", id: ok.json.id });
  assert.equal(done.json.status, "done");

  // project scoping still enforced through the board
  const cross = await call(routes, "POST", "/agenda/tasks?token=s3cret", { op: "done", project: "beta", id: ok.json.id });
  assert.equal(cross.status, 400);
  assert.ok(/not found/.test(cross.json.error));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("agenda-clo tool smoke (via jiti): OK");
