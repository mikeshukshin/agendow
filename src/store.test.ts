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

describe("TaskStore per-user project records", () => {
  it("seeds a personal Main per user, isolated from other users", () => {
    const s = tmpStore();
    expect(s.listProjects(A).map((p) => p.name)).toEqual(["Main"]);
    expect(s.activeProject(A).ownerId).toBe(A);
    s.createProject({ userId: B, name: "B thing" });
    expect(s.listProjects(A).map((p) => p.ownerId)).toEqual([A]); // A can't see B's
    expect(s.listProjects(B).some((p) => p.name === "B thing")).toBe(true);
  });

  it("stores and updates status + info", () => {
    const s = tmpStore();
    const p = s.createProject({ userId: A, name: "Cancore", status: "Active", info: "cross-chain swap" });
    expect(p.status).toBe("Active");
    expect(p.info).toBe("cross-chain swap");
    const upd = s.updateProject({ userId: A, idOrName: "Cancore", patch: { status: "Paused — waiting for hardware", info: "next: KYC" } });
    expect(upd.status).toBe("Paused — waiting for hardware");
    expect(upd.info).toBe("next: KYC");
    expect(s.getProject(A, "cancore")?.info).toBe("next: KYC");
  });

  it("keeps projects private and refuses cross-user access", () => {
    const s = tmpStore();
    const groc = s.createProject({ userId: A, name: "Groceries" });
    expect(s.listProjects(B).some((x) => x.id === groc.id)).toBe(false);
    expect(() => s.updateProject({ userId: B, idOrName: groc.id, patch: { status: "hax" } })).toThrow();
    expect(s.activeProject(B).ownerId).toBe(B);
  });

  it("shows shared projects to every user", () => {
    const s = tmpStore();
    const team = s.createProject({ userId: A, name: "Team", shared: true });
    expect(team.shared).toBe(true);
    expect(s.listProjects(B).some((p) => p.id === team.id)).toBe(true);
    // either owner can update the shared record
    s.updateProject({ userId: B, idOrName: team.id, patch: { status: "shipping" } });
    expect(s.getProject(A, team.id)?.status).toBe("shipping");
  });

  it("renames and archives within the user's visible set", () => {
    const s = tmpStore();
    s.createProject({ userId: A, name: "Work" });
    s.setActiveProject(A, "work");
    s.updateProject({ userId: A, idOrName: "work", patch: { name: "Job" } });
    expect(s.getProject(A, "work")?.name).toBe("Job");
    s.archiveProject({ userId: A, idOrName: "work" });
    expect(s.activeProject(A).ownerId).toBe(A); // fell back to Main
    expect(s.listProjects(A).map((p) => p.id)).not.toContain("work");
  });

  it("migrates old global projects (v2/v3) into shared with status/info fields", () => {
    const f = tmpFile();
    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 2,
        activeProjectId: "old",
        projects: [{ id: "old", name: "Old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
        tasks: [{ id: "t1", projectId: "old", title: "gone", status: "todo" }],
      }),
    );
    const s = new TaskStore(f);
    const p = s.getProject(A, "old");
    expect(p?.shared).toBe(true);
    expect(p?.status).toBe("");
    expect(p?.info).toBe("");
  });
});
