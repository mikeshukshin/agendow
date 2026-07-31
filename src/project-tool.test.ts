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
  it("creates with status/info, gets, updates, switches", async () => {
    const { store, run } = setup();
    const created = await run({ action: "create", name: "Cancore", status: "Active", info: "swap platform" });
    expect(created.id).toBe("cancore");
    expect(created.status).toBe("Active");

    await run({ action: "switch", project: "Cancore" });
    expect(store.activeProject("111").id).toBe("cancore");

    const got = await run({ action: "get" }); // current project
    expect(got.name).toBe("Cancore");
    expect(got.info).toBe("swap platform");

    const upd = await run({ action: "update", status: "Paused", info: "next: KYC" });
    expect(upd.status).toBe("Paused");
    expect(upd.info).toBe("next: KYC");
  });

  it("lists projects with status", async () => {
    const { run } = setup();
    await run({ action: "create", name: "Poly", status: "On hold" });
    const list = await run({ action: "list" });
    expect(list.projects.some((p: any) => p.name === "Poly" && p.status === "On hold")).toBe(true);
  });

  it("creates shared projects visible to others", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-shared-"));
    const store = new TaskStore(path.join(dir, "tasks.json"));
    const a = createProjectTool({ store, userId: "111" });
    const b = createProjectTool({ store, userId: "222" });
    const created = (await a.execute("c", { action: "create", name: "Team", shared: true })).details as any;
    expect(created.shared).toBe(true);
    const bList = (await b.execute("c", { action: "list" })).details as any;
    expect(bList.projects.some((p: any) => p.id === created.id && p.shared)).toBe(true);
  });

  it("errors on missing name / unknown project", async () => {
    const { run } = setup();
    expect((await run({ action: "create" })).error).toMatch(/name required/);
    expect((await run({ action: "get", project: "ghost" })).error).toMatch(/no such project/);
  });
});
