import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskTool } from "./task-tool.js";
import { TaskStore } from "./store.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-tool-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const tool = createTaskTool({ store });
  const run = async (p: Record<string, unknown>) => (await tool.execute("c", p)).details as any;
  return { store, run };
}

describe("task tool", () => {
  it("runs add -> list -> done -> remove in the active project", async () => {
    const { run } = setup();
    const added = await run({ action: "add", title: "write spec", notes: "draft" });
    expect(added.status).toBe("todo");
    expect(added.projectId).toBe("main");

    const listed = await run({ action: "list" });
    expect(listed.project.id).toBe("main");
    expect(listed.tasks).toHaveLength(1);

    expect((await run({ action: "done", id: added.id })).status).toBe("done");
    expect((await run({ action: "remove", id: added.id })).removed).toBe(true);
    expect((await run({ action: "list" })).summary.total).toBe(0);
  });

  it("targets a named project", async () => {
    const { store, run } = setup();
    store.createProject({ name: "Groceries" });
    await run({ action: "add", project: "Groceries", title: "milk" });
    expect((await run({ action: "list", project: "groceries" })).tasks).toHaveLength(1);
    expect((await run({ action: "list" })).tasks).toHaveLength(0); // active still main
  });

  it("returns a structured error on bad input or unknown project", async () => {
    const { run } = setup();
    expect((await run({ action: "add" })).error).toMatch(/title required/);
    expect((await run({ action: "add", project: "ghost", title: "x" })).error).toMatch(/no such project/);
  });
});
