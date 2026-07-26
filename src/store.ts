// AgendaClo task store — per-project (project = agent) todo list.
// Pure Node, no external deps. All the real logic lives here; the tool and the
// plugin entry are thin wrappers. Covered by store.test.ts.
// ponytail: whole-file read + atomic write, no lock. Fine at personal scale;
//           add per-file locking (proper-lockfile) if writers ever contend.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

export type TaskPatch = { title?: string; notes?: string; status?: TaskStatus };

function normAgent(agentId: string | undefined): string {
  const v = (agentId ?? "").trim();
  return v || "main";
}

export class TaskStore {
  readonly filePath: string;

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

  update(input: { agentId: string; id: string; patch: TaskPatch }): Task {
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

  // Cross-project roll-up (for a future summary / board): every project with tasks.
  projects(): Array<{ agentId: string; summary: ReturnType<TaskStore["summary"]> }> {
    const ids = [...new Set(this.read().tasks.map((t) => t.agentId))].sort();
    return ids.map((agentId) => ({ agentId, summary: this.summary(agentId) }));
  }
}
