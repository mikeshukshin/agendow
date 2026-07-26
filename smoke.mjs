// Tool-level smoke test. Loads the plugin graph through jiti — the SAME loader
// the OpenClaw gateway uses — so `.js` import specifiers resolve to `.ts` just
// like they will in production. Run: `node smoke.mjs` (or `pnpm smoke`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const { createTaskTool } = await jiti.import("./task-tool.ts");
const { TaskStore } = await jiti.import("./store.ts");
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
plugin.register({
  pluginConfig: { storePath: path.join(dir, "viaRegister.json") },
  runtime: {},
  logger: {},
  resolvePath: (p) => (path.isAbsolute(p) ? p : path.join(here, p)),
  registerTool: (factory) => {
    captured = factory({ agentId: "proj-y" });
  },
});
assert.equal(typeof captured?.execute, "function");
const y = parse(await captured.execute("c8", { action: "add", title: "in project y" }));
assert.equal(y.agentId, "proj-y");

fs.rmSync(dir, { recursive: true, force: true });
console.log("agenda-clo tool smoke (via jiti): OK");
