// AgendaClo task store — per-project (project = agent) todo list.
// Pure Node (no external deps) so it stays runnable/self-checkable with plain `node store.ts`.
// ponytail: whole-file read+atomic-write, no lock. Fine at personal scale;
//           add per-file locking (proper-lockfile) if multiple writers ever contend.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  id: string;
  agentId: string; // the "project" — every task belongs to exactly one
  title: string;
  status: TaskStatus;
  notes?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  doneAt?: string; // ISO, set when status -> done
}

interface StoreFile {
  version: number;
  tasks: Task[];
}

type UpdatePatch = { title?: string; notes?: string; status?: TaskStatus };

function normAgent(agentId: string | undefined): string {
  const v = (agentId ?? "").trim();
  return v || "main";
}

export class TaskStore {
  filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private read(): StoreFile {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as StoreFile).tasks)) {
        return { version: 1, tasks: (parsed as StoreFile).tasks };
      }
    } catch {
      // missing/corrupt -> start empty
    }
    return { version: 1, tasks: [] };
  }

  private write(data: StoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath); // atomic: never leave a half-written file
  }

  add(input: { agentId: string; title: string; notes?: string }): Task {
    const title = (input.title ?? "").trim();
    if (!title) throw new Error("title required");
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      agentId: normAgent(input.agentId),
      title,
      status: "todo",
      createdAt: now,
      updatedAt: now,
    };
    const notes = (input.notes ?? "").trim();
    if (notes) task.notes = notes;
    const data = this.read();
    data.tasks.push(task);
    this.write(data);
    return task;
  }

  list(input: { agentId: string; status?: TaskStatus }): Task[] {
    const agentId = normAgent(input.agentId);
    return this.read()
      .tasks.filter((t) => t.agentId === agentId && (!input.status || t.status === input.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  get(input: { agentId: string; id: string }): Task | undefined {
    const agentId = normAgent(input.agentId);
    return this.read().tasks.find((t) => t.id === input.id && t.agentId === agentId);
  }

  update(input: { agentId: string; id: string; patch: UpdatePatch }): Task {
    const agentId = normAgent(input.agentId);
    const id = (input.id ?? "").trim();
    if (!id) throw new Error("id required");
    const data = this.read();
    // Scope guard: a project can only touch its own tasks.
    const task = data.tasks.find((t) => t.id === id && t.agentId === agentId);
    if (!task) throw new Error(`task not found in this project: ${id}`);
    const patch = input.patch ?? {};
    if (typeof patch.title === "string" && patch.title.trim()) task.title = patch.title.trim();
    if (typeof patch.notes === "string") {
      const n = patch.notes.trim();
      if (n) task.notes = n;
      else delete task.notes;
    }
    if (patch.status === "todo" || patch.status === "doing" || patch.status === "done") {
      task.status = patch.status;
      if (patch.status === "done") task.doneAt = new Date().toISOString();
      else delete task.doneAt;
    }
    task.updatedAt = new Date().toISOString();
    this.write(data);
    return task;
  }

  remove(input: { agentId: string; id: string }): boolean {
    const agentId = normAgent(input.agentId);
    const data = this.read();
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => !(t.id === input.id && t.agentId === agentId));
    if (data.tasks.length === before) return false;
    this.write(data);
    return true;
  }

  summary(agentId: string): { total: number; todo: number; doing: number; done: number } {
    const tasks = this.list({ agentId });
    const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
    return { total: tasks.length, todo: count("todo"), doing: count("doing"), done: count("done") };
  }

  // Cross-project view for the board: every project (agentId) that has tasks.
  projects(): Array<{ agentId: string; summary: ReturnType<TaskStore["summary"]> }> {
    const ids = [...new Set(this.read().tasks.map((t) => t.agentId))].sort();
    return ids.map((agentId) => ({ agentId, summary: this.summary(agentId) }));
  }
}

// --- self-check (runs with: `node store.ts`) -------------------------------
function demo(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-clo-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));

  const a = store.add({ agentId: "proj-a", title: "write spec" });
  assert.equal(a.status, "todo");
  assert.ok(a.id);
  store.add({ agentId: "proj-a", title: "review", notes: "later" });
  store.add({ agentId: "proj-b", title: "belongs to another project" });

  // project isolation
  assert.equal(store.list({ agentId: "proj-a" }).length, 2);
  assert.equal(store.list({ agentId: "proj-b" }).length, 1);

  // cross-project listing for the board
  const projects = store.projects();
  assert.deepEqual(
    projects.map((p) => p.agentId),
    ["proj-a", "proj-b"],
  );
  assert.equal(projects.find((p) => p.agentId === "proj-a")?.summary.total, 2);

  // done -> status + doneAt + summary
  const done = store.update({ agentId: "proj-a", id: a.id, patch: { status: "done" } });
  assert.equal(done.status, "done");
  assert.ok(done.doneAt);
  assert.deepEqual(store.summary("proj-a"), { total: 2, todo: 1, doing: 0, done: 1 });
  assert.equal(store.list({ agentId: "proj-a", status: "done" }).length, 1);

  // cross-project write is refused
  assert.throws(() => store.update({ agentId: "proj-b", id: a.id, patch: { status: "todo" } }));

  // persistence round-trip via a fresh instance
  const store2 = new TaskStore(store.filePath);
  assert.equal(store2.list({ agentId: "proj-a" }).length, 2);

  // remove is scoped
  assert.equal(store2.remove({ agentId: "proj-a", id: a.id }), true);
  assert.equal(store2.list({ agentId: "proj-a" }).length, 1);
  const bTask = store2.list({ agentId: "proj-b" })[0];
  assert.equal(store2.remove({ agentId: "proj-a", id: bTask.id }), false); // wrong project = no-op
  assert.equal(store2.list({ agentId: "proj-b" }).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("agenda-clo store self-check: OK");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  demo();
}
