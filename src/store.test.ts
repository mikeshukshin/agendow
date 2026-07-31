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

describe("TaskStore per-user project workspaces", () => {
  it("seeds a personal Main and isolates users", () => {
    const s = tmpStore();
    expect(s.listProjects(A).map((p) => p.name)).toEqual(["Main"]);
    expect(s.activeProject(A).ownerId).toBe(A);
    s.createProject({ userId: B, name: "B thing" });
    expect(s.listProjects(A).map((p) => p.ownerId)).toEqual([A]);
  });

  it("sets params and manages sections", () => {
    const s = tmpStore();
    const p = s.createProject({ userId: A, name: "Cancore", status: "Active" });
    s.setParam({ userId: A, idOrName: p.id, key: "chain", value: "Canton" });
    s.setParam({ userId: A, idOrName: p.id, key: "market", value: "42" });
    expect(s.getProject(A, "cancore")?.params).toEqual({ chain: "Canton", market: "42" });
    s.setParam({ userId: A, idOrName: p.id, key: "market", value: "" }); // empty removes
    expect(s.getProject(A, "cancore")?.params).toEqual({ chain: "Canton" });

    const sec = s.addSection({ userId: A, idOrName: p.id, title: "Goal", body: "cross-chain swap" });
    expect(sec.title).toBe("Goal");
    s.updateSection({ userId: A, idOrName: p.id, section: "Goal", patch: { body: "swap + bridge" } });
    expect(s.getProject(A, p.id)?.sections[0].body).toBe("swap + bridge");
    // resolve section by id too
    expect(s.getProject(A, p.id)?.sections.find((x) => x.id === sec.id)?.title).toBe("Goal");
    expect(s.removeSection({ userId: A, idOrName: p.id, section: sec.id })).toBe(true);
    expect(s.getProject(A, p.id)?.sections).toHaveLength(0);
  });

  it("updateProject replaces params and sections wholesale (Mini App save)", () => {
    const s = tmpStore();
    const p = s.createProject({ userId: A, name: "P" });
    const u = s.updateProject({
      userId: A,
      idOrName: p.id,
      patch: { status: "Paused", params: { a: "1" }, sections: [{ title: "One", body: "x" }] },
    });
    expect(u.status).toBe("Paused");
    expect(u.params).toEqual({ a: "1" });
    expect(u.sections[0].title).toBe("One");
    expect(u.sections[0].id).toBeTruthy(); // id assigned
  });

  it("keeps projects private and shares shared ones", () => {
    const s = tmpStore();
    const mine = s.createProject({ userId: A, name: "Mine" });
    expect(() => s.setParam({ userId: B, idOrName: mine.id, key: "k", value: "v" })).toThrow();
    const team = s.createProject({ userId: A, name: "Team", shared: true });
    s.addSection({ userId: B, idOrName: team.id, title: "note" }); // B can edit shared
    expect(s.getProject(A, team.id)?.sections).toHaveLength(1);
  });

  it("migrates v4 info into a Notes section and adds params/sections fields", () => {
    const f = tmpFile();
    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 4,
        active: {},
        projects: [{ id: "old", ownerId: "111", name: "Old", status: "Active", info: "legacy notes", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
      }),
    );
    const s = new TaskStore(f);
    const p = s.getProject(A, "old");
    expect(p?.params).toEqual({});
    expect(p?.sections[0]).toMatchObject({ title: "Notes", body: "legacy notes" });
  });
});
