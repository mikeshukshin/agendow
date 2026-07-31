import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectTool } from "./project-tool.js";
import { TaskStore } from "./store.js";

function setup(userId = "111") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-proj-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const tool = createProjectTool({ store, userId });
  const run = async (p: Record<string, unknown>) => (await tool.execute("c", p)).details as any;
  return { store, run };
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

  it("errors on missing fields / unknown targets", async () => {
    const { run } = setup();
    expect((await run({ action: "create" })).error).toMatch(/name required/);
    expect((await run({ action: "set_param", value: "v" })).error).toMatch(/key required/);
    expect((await run({ action: "update_section", section: "ghost", body: "x" })).error).toMatch(/no such section/);
  });
});
