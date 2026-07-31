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
function mockReq(method: string, url: string, o: { init?: string; body?: unknown } = {}) {
  const req: any = o.body !== undefined ? Readable.from([Buffer.from(JSON.stringify(o.body))]) : Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = o.init ? { "x-telegram-init-data": o.init } : {};
  return req;
}
function mockRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    end(c?: string) { if (c) this.body += c; },
  };
}

function setup(ownerIds?: number[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-mini-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const routes = createMiniAppRoutes({ store, ownerIds, basePath: "/plugins/agenda-clo", getBotToken: () => TOKEN });
  const route = (suffix: string) => routes.find((r) => r.path.endsWith(suffix))!;
  const call = async (suffix: string, method: string, o: { init?: string; body?: unknown; query?: string } = {}) => {
    const r = route(suffix);
    const res = mockRes();
    await r.handler(mockReq(method, r.path + (o.query ?? ""), o) as any, res as any);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined, res };
  };
  return { store, call, route };
}

describe("mini app API", () => {
  it("requires valid initData", async () => {
    const { call } = setup();
    expect((await call("/tasks", "GET")).status).toBe(401);
    expect((await call("/projects", "GET")).status).toBe(401);
  });

  it("enforces the owner allowlist", async () => {
    const { call } = setup([999]);
    expect((await call("/tasks", "GET", { init: initData(7) })).status).toBe(403);
  });

  it("manages projects and tasks for an authenticated owner", async () => {
    const { call } = setup();
    const init = initData();

    const ov = await call("/projects", "GET", { init });
    expect(ov.json.activeProjectId).toBe("main");

    const created = await call("/projects", "POST", { init, body: { op: "create", name: "Groceries" } });
    expect(created.json.id).toBe("groceries");
    await call("/projects", "POST", { init, body: { op: "switch", project: "groceries" } });

    const added = await call("/tasks", "POST", { init, body: { op: "add", title: "milk" } });
    expect(added.json.projectId).toBe("groceries"); // went to the active project

    const list = await call("/tasks", "GET", { init });
    expect(list.json.project.id).toBe("groceries");
    expect(list.json.tasks).toHaveLength(1);

    const done = await call("/tasks", "POST", { init, body: { op: "done", id: added.json.id } });
    expect(done.json.status).toBe("done");
  });

  it("serves the Mini App page", async () => {
    const { route } = setup();
    const res = mockRes();
    await route("/app").handler(mockReq("GET", "/plugins/agenda-clo/app") as any, res as any);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toMatch(/telegram-web-app\.js/);
  });
});
