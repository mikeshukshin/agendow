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
  it("creates, switches, renames, archives for the user", async () => {
    const { store, run } = setup();
    expect((await run({ action: "create", name: "Work" })).id).toBe("work");
    expect((await run({ action: "switch", project: "Work" })).current.id).toBe("work");
    expect(store.activeProject("111").id).toBe("work");
    await run({ action: "rename", project: "work", name: "Job" });
    expect(store.getProject("111", "work")?.name).toBe("Job");
    await run({ action: "archive", project: "work" });
    const list = await run({ action: "list" });
    expect(list.projects.map((p: any) => p.id)).not.toContain("work");
  });

  it("creates shared projects visible to others", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-shared-"));
    const store = new TaskStore(path.join(dir, "tasks.json"));
    const a = createProjectTool({ store, userId: "111" });
    const b = createProjectTool({ store, userId: "222" });
    const created = (await a.execute("c", { action: "create", name: "Team", shared: true })).details as any;
    expect(created.ownerId).toBe("shared");
    const bList = (await b.execute("c", { action: "list" })).details as any;
    expect(bList.projects.some((p: any) => p.id === created.id && p.shared)).toBe(true);
  });

  it("errors on missing name", async () => {
    const { run } = setup();
    expect((await run({ action: "create" })).error).toMatch(/name required/);
  });
});
