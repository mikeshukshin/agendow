import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskTool } from "./task-tool.js";
import { TaskStore } from "./store.js";

function setup(userId = "111") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-tool-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  const tool = createTaskTool({ store, userId });
  const run = async (p: Record<string, unknown>) => (await tool.execute("c", p)).details as any;
  return { store, run };
}

describe("task tool", () => {
  it("runs add -> list -> done -> remove in the user's current project", async () => {
    const { run } = setup();
    const added = await run({ action: "add", title: "write spec" });
    expect(added.status).toBe("todo");
    expect(added.projectId).toBeTruthy();

    const listed = await run({ action: "list" });
    expect(listed.tasks).toHaveLength(1);
    expect((await run({ action: "done", id: added.id })).status).toBe("done");
    expect((await run({ action: "remove", id: added.id })).removed).toBe(true);
    expect((await run({ action: "list" })).summary.total).toBe(0);
  });

  it("targets a named project", async () => {
    const { store, run } = setup("111");
    store.createProject({ userId: "111", name: "Groceries" });
    await run({ action: "add", project: "Groceries", title: "milk" });
    expect((await run({ action: "list", project: "groceries" })).tasks).toHaveLength(1);
    expect((await run({ action: "list" })).tasks).toHaveLength(0); // current is still Main
  });

  it("errors on bad input or another user's project", async () => {
    const { store, run } = setup("111");
    store.createProject({ userId: "222", name: "Theirs" }); // belongs to user 222
    expect((await run({ action: "add" })).error).toMatch(/title required/);
    expect((await run({ action: "add", project: "Theirs", title: "x" })).error).toMatch(/no such project/);
  });
});
