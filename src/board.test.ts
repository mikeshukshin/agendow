import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createMiniAppRoutes } from "./board.js";
import { signInitDataForTest } from "./telegram-auth.js";
import { TaskStore } from "./store.js";

const TOKEN = "123456:test-bot-token";

function initData(userId = 7): string {
  return signInitDataForTest(TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: "T" }),
  });
}

function mockReq(method: string, url: string, opts: { init?: string; body?: unknown } = {}) {
  const req: any = opts.body !== undefined
    ? Readable.from([Buffer.from(JSON.stringify(opts.body))])
    : Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = opts.init ? { "x-telegram-init-data": opts.init } : {};
  return req;
}
function mockRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    end(chunk?: string) { if (chunk) this.body += chunk; },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-mini-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const routes = createMiniAppRoutes({
    store, project: "main", basePath: "/plugins/agenda-clo",
    getBotToken: () => TOKEN,
  });
  const api = routes.find((r) => r.path.endsWith("/tasks"))!;
  const page = routes.find((r) => r.path.endsWith("/app"))!;
  const call = async (method: string, o: { init?: string; body?: unknown } = {}) => {
    const res = mockRes();
    await api.handler(mockReq(method, api.path, o) as any, res as any);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  };
  return { store, call, page };
}

describe("mini app API", () => {
  it("rejects requests without valid initData", async () => {
    const { call } = setup();
    expect((await call("GET")).status).toBe(401);
    expect((await call("POST", { body: { op: "add", title: "x" } })).status).toBe(401);
  });

  it("runs the task lifecycle for an authenticated user", async () => {
    const { call } = setup();
    const init = initData();
    const added = await call("POST", { init, body: { op: "add", title: "buy milk" } });
    expect(added.status).toBe(200);
    expect(added.json.title).toBe("buy milk");

    const list = await call("GET", { init });
    expect(list.status).toBe(200);
    expect(list.json.project).toBe("main");
    expect(list.json.tasks).toHaveLength(1);

    const done = await call("POST", { init, body: { op: "done", id: added.json.id } });
    expect(done.json.status).toBe("done");

    const removed = await call("POST", { init, body: { op: "remove", id: added.json.id } });
    expect(removed.json.removed).toBe(true);
    expect((await call("GET", { init })).json.summary.total).toBe(0);
  });

  it("enforces an owner allowlist when configured", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-owner-"));
    const store = new TaskStore(path.join(dir, "tasks.json"));
    const routes = createMiniAppRoutes({
      store, project: "main", basePath: "/plugins/agenda-clo",
      ownerIds: [999], getBotToken: () => TOKEN,
    });
    const api = routes.find((r) => r.path.endsWith("/tasks"))!;
    const res = mockRes();
    await api.handler(mockReq("GET", api.path, { init: initData(7) }) as any, res as any);
    expect(res.statusCode).toBe(403); // user 7 not in [999]
  });

  it("serves the mini app HTML page", async () => {
    const { page } = setup();
    const res = mockRes();
    await page.handler(mockReq("GET", page.path) as any, res as any);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toMatch(/telegram-web-app\.js/);
  });
});
