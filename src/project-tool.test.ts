import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectTool } from "./project-tool.js";
import { TaskStore } from "./store.js";

function setup(userId = "111") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-proj-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    projectTypes: { bot: { label: "Bot", views: [{ kind: "api", title: "Market", request: { url: "https://api.x/{market}" }, render: "{price}$" }] } },
  }));
  const tool = createProjectTool({ store, userId, configPath, fetchJson: async () => ({ price: 7 }) });
  const run = async (p: Record<string, unknown>) => (await tool.execute("c", p)).details as any;
  const runFull = async (p: Record<string, unknown>) => await tool.execute("c", p);
  return { store, run, runFull };
}

describe("project tool", () => {
  it("create + status + params + sections lifecycle", async () => {
    const { run } = setup();
    const created = await run({ action: "create", name: "Cancore", status: "Active" });
    expect(created.id).toBe("cancore");
    await run({ action: "switch", project: "Cancore" });

    await run({ action: "set_param", key: "chain", value: "Canton" });
    await run({ action: "add_section", title: "Goal", body: "cross-chain swap" });
    await run({ action: "update_section", section: "Goal", body: "swap + bridge" });

    const got = await run({ action: "get" });
    expect(got.params).toEqual({ chain: "Canton" });
    expect(got.sections[0]).toMatchObject({ title: "Goal", body: "swap + bridge" });

    expect((await run({ action: "remove_section", section: "Goal" })).removed).toBe(true);
    await run({ action: "set_param", key: "chain", value: "" });
    expect((await run({ action: "get" })).params).toEqual({});
  });

  it("lists projects with status", async () => {
    const { run } = setup();
    await run({ action: "create", name: "Poly", status: "On hold" });
    const list = await run({ action: "list" });
    expect(list.projects.some((p: any) => p.name === "Poly" && p.status === "On hold")).toBe(true);
  });

  it("lists config types and renders a typed project via its api view", async () => {
    const { run, runFull } = setup();
    const t = await run({ action: "types" });
    expect(t.types).toEqual([{ id: "bot", label: "Bot" }]);
    expect(t.kinds).toEqual(expect.arrayContaining(["api", "params", "sections", "text"]));
    await run({ action: "create", name: "Cancore", type: "bot" });
    await run({ action: "switch", project: "Cancore" });
    await run({ action: "set_param", key: "market", value: "42" });
    const res = await runFull({ action: "render" });
    expect(res.content[0].text).toContain("# Cancore");
    expect(res.content[0].text).toContain("### Market");
    expect(res.content[0].text).toContain("7$"); // api view rendered via injected fetch
  });

  it("errors on missing fields / unknown targets", async () => {
    const { run } = setup();
    expect((await run({ action: "create" })).error).toMatch(/name required/);
    expect((await run({ action: "set_param", value: "v" })).error).toMatch(/key required/);
    expect((await run({ action: "update_section", section: "ghost", body: "x" })).error).toMatch(/no such section/);
  });
});
