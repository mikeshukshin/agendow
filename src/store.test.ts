import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "./store.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agenda-")), "tasks.json");
}
function tmpStore(): TaskStore {
  return new TaskStore(tmpFile());
}

describe("TaskStore projects", () => {
  it("seeds a Main project as active", () => {
    const s = tmpStore();
    expect(s.listProjects().map((p) => p.name)).toEqual(["Main"]);
    expect(s.activeProject().id).toBe("main");
  });

  it("adds tasks to the active project by default", () => {
    const s = tmpStore();
    const t = s.add({ title: "a" });
    expect(t.projectId).toBe("main");
    expect(s.list()).toHaveLength(1);
    expect(s.summary()).toEqual({ total: 1, todo: 1, doing: 0, done: 0 });
  });

  it("creates, switches, and scopes tasks per project", () => {
    const s = tmpStore();
    const groc = s.createProject({ name: "Groceries" });
    expect(groc.id).toBe("groceries");
    s.setActiveProject("Groceries"); // resolve by name
    s.add({ title: "milk" });
    expect(s.list().map((t) => t.title)).toEqual(["milk"]); // active = groceries
    expect(s.list({ project: "main" })).toHaveLength(0);
    s.add({ project: "main", title: "in main" }); // explicit project overrides active
    expect(s.list({ project: "main" })).toHaveLength(1);
  });

  it("refuses cross-project task writes", () => {
    const s = tmpStore();
    const t = s.add({ project: "main", title: "x" });
    s.createProject({ name: "Other" });
    expect(() => s.update({ project: "other", id: t.id, patch: { status: "done" } })).toThrow();
  });

  it("keeps id on rename and moves active off an archived project", () => {
    const s = tmpStore();
    s.createProject({ name: "Work" });
    s.setActiveProject("work");
    s.renameProject({ idOrName: "work", name: "Job" });
    expect(s.getProject("work")?.name).toBe("Job"); // id stable across rename
    s.archiveProject({ idOrName: "work" });
    expect(s.activeProject().id).toBe("main"); // active fell back
    expect(s.listProjects().map((p) => p.id)).not.toContain("work"); // hidden
    expect(s.listProjects({ includeArchived: true }).map((p) => p.id)).toContain("work");
  });

  it("throws on an unknown project", () => {
    const s = tmpStore();
    expect(() => s.list({ project: "nope" })).toThrow(/no such project/);
  });

  it("rolls up an overview with per-project summaries", () => {
    const s = tmpStore();
    s.add({ title: "a" });
    s.createProject({ name: "B" });
    const ov = s.overview();
    expect(ov.activeProjectId).toBe("main");
    expect(ov.projects.find((p) => p.id === "main")?.summary.total).toBe(1);
  });

  it("migrates v1 (agentId) files into projects", () => {
    const f = tmpFile();
    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        tasks: [
          { id: "t1", agentId: "main", title: "old", status: "todo", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
          { id: "t2", agentId: "proj-x", title: "other", status: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    const s = new TaskStore(f);
    expect(s.listProjects().map((p) => p.id).sort()).toEqual(["main", "proj-x"]);
    expect(s.list({ project: "main" }).map((t) => t.title)).toEqual(["old"]);
    expect(s.list({ project: "proj-x" }).map((t) => t.title)).toEqual(["other"]);
  });
});
