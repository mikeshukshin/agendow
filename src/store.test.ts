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
const A = "111";
const B = "222";

describe("TaskStore per-user projects", () => {
  it("seeds a personal Main per user, isolated from other users", () => {
    const s = tmpStore();
    expect(s.listProjects(A).map((p) => p.name)).toEqual(["Main"]);
    const aMain = s.activeProject(A);
    expect(aMain.ownerId).toBe(A);
    // B gets its own Main; A cannot see it and vice-versa
    s.add({ userId: B, title: "b task" });
    expect(s.listProjects(A).map((p) => p.ownerId)).toEqual([A]);
    expect(s.listProjects(B).map((p) => p.ownerId)).toEqual([B]);
  });

  it("keeps each user's projects and current project separate", () => {
    const s = tmpStore();
    const groc = s.createProject({ userId: A, name: "Groceries" });
    s.setActiveProject(A, "Groceries");
    s.add({ userId: A, title: "milk" });
    expect(s.list({ userId: A }).map((t) => t.title)).toEqual(["milk"]);
    // B cannot see or resolve A's project
    expect(s.listProjects(B).some((p) => p.id === groc.id)).toBe(false);
    expect(() => s.list({ userId: B, project: "Groceries" })).toThrow(/no such project/);
    expect(() => s.renameProject({ userId: B, idOrName: groc.id, name: "hax" })).toThrow();
    // B's current project is still B's own Main
    expect(s.activeProject(B).ownerId).toBe(B);
  });

  it("shows shared projects to every user", () => {
    const s = tmpStore();
    const team = s.createProject({ userId: A, name: "Team", shared: true });
    expect(team.ownerId).toBe("shared");
    expect(s.listProjects(B).some((p) => p.id === team.id)).toBe(true); // visible to B
    // both users can add to the shared project
    s.add({ userId: A, project: "Team", title: "a" });
    s.add({ userId: B, project: team.id, title: "b" });
    expect(s.summary(A, team.id).total).toBe(2);
    expect(s.summary(B, team.id).total).toBe(2);
  });

  it("archives and renames within the user's visible set", () => {
    const s = tmpStore();
    s.createProject({ userId: A, name: "Work" });
    s.setActiveProject(A, "work");
    s.renameProject({ userId: A, idOrName: "work", name: "Job" });
    expect(s.getProject(A, "work")?.name).toBe("Job");
    s.archiveProject({ userId: A, idOrName: "work" });
    expect(s.activeProject(A).ownerId).toBe(A); // fell back to A's Main
    expect(s.listProjects(A).map((p) => p.id)).not.toContain("work");
  });

  it("rolls up an overview for one user with shared flags", () => {
    const s = tmpStore();
    s.add({ userId: A, title: "x" });
    s.createProject({ userId: A, name: "Team", shared: true });
    const ov = s.overview(A);
    expect(ov.projects.some((p) => p.shared)).toBe(true);
    expect(ov.projects.find((p) => !p.shared)?.summary.total).toBe(1);
  });

  it("migrates v2 global projects into shared", () => {
    const f = tmpFile();
    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 2,
        activeProjectId: "main",
        projects: [{ id: "old", name: "Old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
        tasks: [{ id: "t1", projectId: "old", title: "keep", status: "todo", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
      }),
    );
    const s = new TaskStore(f);
    const p = s.listProjects(A).find((x) => x.id === "old");
    expect(p?.ownerId).toBe("shared"); // old global project is now shared
    expect(s.list({ userId: A, project: "old" }).map((t) => t.title)).toEqual(["keep"]);
  });
});
