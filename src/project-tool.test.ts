import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectTool } from "./project-tool.js";
import { TaskStore } from "./store.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-proj-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const tool = createProjectTool({ store });
  const run = async (p: Record<string, unknown>) => (await tool.execute("c", p)).details as any;
  return { store, run };
}

describe("project tool", () => {
  it("creates, switches, renames, archives", async () => {
    const { store, run } = setup();
    const created = await run({ action: "create", name: "Work" });
    expect(created.id).toBe("work");

    const switched = await run({ action: "switch", project: "Work" });
    expect(switched.current.id).toBe("work");
    expect(store.activeProject().id).toBe("work");

    const cur = await run({ action: "current" });
    expect(cur.current.name).toBe("Work");

    await run({ action: "rename", project: "work", name: "Job" });
    expect(store.getProject("work")?.name).toBe("Job");

    await run({ action: "archive", project: "work" });
    expect(store.activeProject().id).toBe("main"); // fell back
    const list = await run({ action: "list" });
    expect(list.projects.map((p: any) => p.id)).not.toContain("work");
  });

  it("errors on missing name", async () => {
    const { run } = setup();
    expect((await run({ action: "create" })).error).toMatch(/name required/);
  });
});
