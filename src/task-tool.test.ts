import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskTool } from "./task-tool.js";
import { TaskStore } from "./store.js";

function tool(agentId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-tool-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  return { store, t: createTaskTool({ agentId, store }) };
}

describe("task tool", () => {
  it("runs add -> list -> update -> done -> remove scoped to the project", async () => {
    const { t } = tool("proj-x");
    const run = async (p: Record<string, unknown>) => (await t.execute("c", p)).details as any;

    const added = await run({ action: "add", title: "write spec", notes: "draft" });
    expect(added.status).toBe("todo");
    expect(added.id).toBeTruthy();

    const listed = await run({ action: "list" });
    expect(listed.project).toBe("proj-x");
    expect(listed.summary.total).toBe(1);
    expect(listed.tasks).toHaveLength(1);

    expect((await run({ action: "update", id: added.id, status: "doing" })).status).toBe("doing");
    const done = await run({ action: "done", id: added.id });
    expect(done.status).toBe("done");
    expect(done.doneAt).toBeTruthy();

    const removed = await run({ action: "remove", id: added.id });
    expect(removed.removed).toBe(true);
    expect((await run({ action: "list" })).summary.total).toBe(0);
  });

  it("returns a structured error instead of throwing on bad input", async () => {
    const { t } = tool("proj-x");
    const res = (await t.execute("c", { action: "add" })).details as any;
    expect(res.error).toMatch(/title required/);
  });

  it("cannot touch another project's task", async () => {
    const { store, t } = tool("proj-x");
    const other = store.add({ agentId: "proj-y", title: "theirs" });
    const res = (await t.execute("c", { action: "done", id: other.id })).details as any;
    expect(res.error).toMatch(/not found/);
    expect(store.get({ agentId: "proj-y", id: other.id })?.status).toBe("todo");
  });
});
