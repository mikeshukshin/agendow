import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createMiniAppRoutes } from "./board.js";
import { signInitDataForTest } from "./telegram-auth.js";
import { TaskStore } from "./store.js";

const TOKEN = "123456:test-bot-token";
function initData(userId: number): string {
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
  const routes = createMiniAppRoutes({ store, ownerIds, basePath: "/plugins/agendow", getBotToken: () => TOKEN });
  const route = (suffix: string) => routes.find((r) => r.path.endsWith(suffix))!;
  const call = async (suffix: string, method: string, o: { init?: string; body?: unknown } = {}) => {
    const r = route(suffix);
    const res = mockRes();
    await r.handler(mockReq(method, r.path, o) as any, res as any);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  };
  return { store, call, route };
}

describe("mini app API", () => {
  it("requires valid initData and enforces the owner allowlist", async () => {
    expect((await setup().call("/projects", "GET")).status).toBe(401);
    expect((await setup([999]).call("/projects", "GET", { init: initData(7) })).status).toBe(403);
  });

  it("saves status + params + sections wholesale for the authenticated user", async () => {
    const { call } = setup();
    const init = initData(7);
    const created = await call("/projects", "POST", { init, body: { op: "create", name: "Cancore" } });
    expect(created.status).toBe(200);
    await call("/projects", "POST", {
      init,
      body: { op: "update", project: created.json.id, status: "Active", params: { chain: "Canton" }, sections: [{ title: "Goal", body: "swap" }] },
    });
    const ov = await call("/projects", "GET", { init });
    const p = ov.json.projects.find((x: any) => x.id === created.json.id);
    expect(p.status).toBe("Active");
    expect(p.params).toEqual({ chain: "Canton" });
    expect(p.sections[0]).toMatchObject({ title: "Goal", body: "swap" });
  });

  it("isolates users and shares shared projects", async () => {
    const { call } = setup();
    const a = initData(7);
    const b = initData(8);
    const mine = await call("/projects", "POST", { init: a, body: { op: "create", name: "Mine" } });
    const bOv = await call("/projects", "GET", { init: b });
    expect(bOv.json.projects.some((p: any) => p.id === mine.json.id)).toBe(false);
    const team = await call("/projects", "POST", { init: a, body: { op: "create", name: "Team", shared: true } });
    const bOv2 = await call("/projects", "GET", { init: b });
    expect(bOv2.json.projects.some((p: any) => p.id === team.json.id && p.shared)).toBe(true);
  });

  it("serves the Mini App page", async () => {
    const { route } = setup();
    const res = mockRes();
    await route("/app").handler(mockReq("GET", "/plugins/agendow/app") as any, res as any);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toMatch(/telegram-web-app\.js/);
  });
});
