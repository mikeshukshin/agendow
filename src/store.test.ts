import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "./store.js";

function tmpStore(): TaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-clo-"));
  return new TaskStore(path.join(dir, "tasks.json"));
}

describe("TaskStore", () => {
  it("adds tasks as todo and scopes them per project", () => {
    const store = tmpStore();
    const a = store.add({ agentId: "proj-a", title: "write spec" });
    expect(a.status).toBe("todo");
    expect(a.id).toBeTruthy();
    store.add({ agentId: "proj-a", title: "review", notes: "later" });
    store.add({ agentId: "proj-b", title: "belongs to another project" });

    expect(store.list({ agentId: "proj-a" })).toHaveLength(2);
    expect(store.list({ agentId: "proj-b" })).toHaveLength(1);
  });

  it("lists every project for the board view", () => {
    const store = tmpStore();
    store.add({ agentId: "proj-a", title: "x" });
    store.add({ agentId: "proj-a", title: "y" });
    store.add({ agentId: "proj-b", title: "z" });
    const projects = store.projects();
    expect(projects.map((p) => p.agentId)).toEqual(["proj-a", "proj-b"]);
    expect(projects.find((p) => p.agentId === "proj-a")?.summary.total).toBe(2);
  });

  it("marks done with a timestamp and updates the summary", () => {
    const store = tmpStore();
    const a = store.add({ agentId: "proj-a", title: "task" });
    const done = store.update({ agentId: "proj-a", id: a.id, patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.doneAt).toBeTruthy();
    expect(store.summary("proj-a")).toEqual({ total: 1, todo: 0, doing: 0, done: 1 });
    expect(store.list({ agentId: "proj-a", status: "done" })).toHaveLength(1);
  });

  it("refuses cross-project writes", () => {
    const store = tmpStore();
    const a = store.add({ agentId: "proj-a", title: "task" });
    expect(() => store.update({ agentId: "proj-b", id: a.id, patch: { status: "todo" } })).toThrow();
    // a remove scoped to the wrong project is a no-op
    expect(store.remove({ agentId: "proj-b", id: a.id })).toBe(false);
    expect(store.list({ agentId: "proj-a" })).toHaveLength(1);
  });

  it("persists across instances", () => {
    const store = tmpStore();
    store.add({ agentId: "proj-a", title: "persisted" });
    const reopened = new TaskStore(store.filePath);
    expect(reopened.list({ agentId: "proj-a" })).toHaveLength(1);
  });
});
