// AgendaClo store — per-user projects (+ shared) and per-project tasks.
// A project belongs to one owner (Telegram id) or is SHARED (visible to all
// owners). Each user has their own "current project". Pure Node, atomic write.
// ponytail: whole-file read + atomic write, no lock. Fine at personal scale.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "todo" | "doing" | "done";
export const SHARED = "shared";

export interface Project {
  id: string; // globally-unique slug
  ownerId: string; // Telegram user id, or SHARED
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}

export type TaskPatch = { title?: string; notes?: string; status?: TaskStatus };
export type Summary = { total: number; todo: number; doing: number; done: number };

interface StoreFile {
  version: number;
  active: Record<string, string>; // userId -> current projectId
  projects: Project[];
  tasks: Task[];
}

function nowIso(): string {
  return new Date().toISOString();
}
function slugify(name: string): string {
  return (
    name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
    "project"
  );
}

export class TaskStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  // --- persistence + migration (v1 agentId / v2 global projects -> v3) -------
  private read(): StoreFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return { version: 3, active: {}, projects: [], tasks: [] };
    }
    if (!raw || typeof raw !== "object") return { version: 3, active: {}, projects: [], tasks: [] };
    const data = raw as Partial<StoreFile> & {
      activeProjectId?: string;
      tasks?: Array<Task & { agentId?: string }>;
      projects?: Array<Project & { ownerId?: string }>;
    };
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];

    // v1 -> tasks tagged agentId, no projects.
    if (!Array.isArray(data.projects)) {
      for (const t of tasks) {
        if (!t.projectId) t.projectId = t.agentId || "main";
        delete t.agentId;
      }
      const ids = [...new Set(tasks.map((t) => t.projectId))];
      const projects: Project[] = ids.map((id) => ({
        id,
        ownerId: SHARED,
        name: id === "main" ? "Main" : id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }));
      return { version: 3, active: {}, projects, tasks };
    }
    // v2 -> global projects without ownerId become SHARED.
    for (const p of data.projects) {
      if (!p.ownerId) p.ownerId = SHARED;
    }
    return {
      version: 3,
      active: data.active && typeof data.active === "object" ? data.active : {},
      projects: data.projects,
      tasks,
    };
  }

  private write(data: StoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // Projects a user may see: their own + shared.
  private visibleTo(data: StoreFile, userId: string, includeArchived = false): Project[] {
    return data.projects.filter(
      (p) => (p.ownerId === userId || p.ownerId === SHARED) && (includeArchived || !p.archivedAt),
    );
  }

  private uniqueId(data: StoreFile, base: string): string {
    let id = slugify(base);
    if (data.projects.some((p) => p.id === id)) {
      let n = 2;
      while (data.projects.some((p) => p.id === `${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    return id;
  }

  // Guarantee the user has a personal "Main" and a valid current project.
  private ensureUser(data: StoreFile, userId: string): boolean {
    let changed = false;
    const personal = data.projects.filter((p) => p.ownerId === userId && !p.archivedAt);
    if (personal.length === 0) {
      const id = this.uniqueId(data, "main");
      data.projects.push({ id, ownerId: userId, name: "Main", createdAt: nowIso(), updatedAt: nowIso() });
      changed = true;
    }
    const visible = this.visibleTo(data, userId);
    if (!visible.some((p) => p.id === data.active[userId])) {
      const own = data.projects.find((p) => p.ownerId === userId && !p.archivedAt) ?? visible[0];
      data.active[userId] = own.id;
      changed = true;
    }
    return changed;
  }

  private resolveId(data: StoreFile, userId: string, project?: string): string {
    const key = (project ?? "").trim();
    if (!key) return data.active[userId];
    const lower = key.toLowerCase();
    const visible = this.visibleTo(data, userId, true);
    const found =
      visible.find((p) => p.id === lower) ?? visible.find((p) => p.name.toLowerCase() === lower);
    if (!found) throw new Error(`no such project: ${project}`);
    return found.id;
  }

  // Run fn with a seeded user; persist if fn mutated (write=true) or seeding did.
  private tx<T>(userId: string, fn: (data: StoreFile) => T, write: boolean): T {
    const data = this.read();
    const seeded = this.ensureUser(data, userId);
    const result = fn(data);
    if (write || seeded) this.write(data);
    return result;
  }

  // --- projects -------------------------------------------------------------
  listProjects(userId: string, opts: { includeArchived?: boolean } = {}): Project[] {
    return this.tx(userId, (d) =>
      this.visibleTo(d, userId, opts.includeArchived).sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      ),
      false,
    );
  }

  getProject(userId: string, idOrName: string): Project | undefined {
    return this.tx(userId, (d) => {
      try {
        const id = this.resolveId(d, userId, idOrName);
        return d.projects.find((p) => p.id === id);
      } catch {
        return undefined;
      }
    }, false);
  }

  createProject(input: { userId: string; name: string; shared?: boolean }): Project {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("project name required");
    return this.tx(input.userId, (d) => {
      const project: Project = {
        id: this.uniqueId(d, name),
        ownerId: input.shared ? SHARED : input.userId,
        name,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      d.projects.push(project);
      return project;
    }, true);
  }

  renameProject(input: { userId: string; idOrName: string; name: string }): Project {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("new name required");
    return this.tx(input.userId, (d) => {
      const id = this.resolveId(d, input.userId, input.idOrName);
      const project = d.projects.find((p) => p.id === id)!;
      project.name = name;
      project.updatedAt = nowIso();
      return project;
    }, true);
  }

  archiveProject(input: { userId: string; idOrName: string }): Project {
    return this.tx(input.userId, (d) => {
      const id = this.resolveId(d, input.userId, input.idOrName);
      const project = d.projects.find((p) => p.id === id)!;
      project.archivedAt = nowIso();
      project.updatedAt = nowIso();
      // move the pointer off an archived active project for anyone on it
      for (const uid of Object.keys(d.active)) {
        if (d.active[uid] === id) this.ensureUser(d, uid);
      }
      return project;
    }, true);
  }

  unarchiveProject(input: { userId: string; idOrName: string }): Project {
    return this.tx(input.userId, (d) => {
      const id = this.resolveId(d, input.userId, input.idOrName);
      const project = d.projects.find((p) => p.id === id)!;
      delete project.archivedAt;
      project.updatedAt = nowIso();
      return project;
    }, true);
  }

  activeProject(userId: string): Project {
    return this.tx(userId, (d) => d.projects.find((p) => p.id === d.active[userId])!, false);
  }

  setActiveProject(userId: string, idOrName: string): Project {
    return this.tx(userId, (d) => {
      const id = this.resolveId(d, userId, idOrName);
      d.active[userId] = id;
      return d.projects.find((p) => p.id === id)!;
    }, true);
  }

  // --- tasks (scoped to the user's current/visible project) -----------------
  add(input: { userId: string; project?: string; title: string; notes?: string }): Task {
    const title = (input.title ?? "").trim();
    if (!title) throw new Error("title required");
    return this.tx(input.userId, (d) => {
      const projectId = this.resolveId(d, input.userId, input.project);
      const task: Task = {
        id: randomUUID(),
        projectId,
        title,
        status: "todo",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const notes = (input.notes ?? "").trim();
      if (notes) task.notes = notes;
      d.tasks.push(task);
      return task;
    }, true);
  }

  list(input: { userId: string; project?: string; status?: TaskStatus }): Task[] {
    return this.tx(input.userId, (d) => {
      const projectId = this.resolveId(d, input.userId, input.project);
      return d.tasks
        .filter((t) => t.projectId === projectId && (!input.status || t.status === input.status))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }, false);
  }

  update(input: { userId: string; project?: string; id: string; patch: TaskPatch }): Task {
    const id = (input.id ?? "").trim();
    if (!id) throw new Error("id required");
    return this.tx(input.userId, (d) => {
      const projectId = this.resolveId(d, input.userId, input.project);
      const task = d.tasks.find((t) => t.id === id && t.projectId === projectId);
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
        if (patch.status === "done") task.doneAt = nowIso();
        else delete task.doneAt;
      }
      task.updatedAt = nowIso();
      return task;
    }, true);
  }

  remove(input: { userId: string; project?: string; id: string }): boolean {
    return this.tx(input.userId, (d) => {
      const projectId = this.resolveId(d, input.userId, input.project);
      const before = d.tasks.length;
      d.tasks = d.tasks.filter((t) => !(t.id === input.id && t.projectId === projectId));
      return d.tasks.length !== before;
    }, true);
  }

  summary(userId: string, project?: string): Summary {
    const tasks = this.list({ userId, project });
    const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
    return { total: tasks.length, todo: count("todo"), doing: count("doing"), done: count("done") };
  }

  // Dashboard roll-up for one user: their current project + visible projects.
  overview(userId: string): {
    activeProjectId: string;
    projects: Array<Project & { shared: boolean; summary: Summary }>;
  } {
    return this.tx(userId, (d) => {
      const visible = this.visibleTo(d, userId).sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
      return {
        activeProjectId: d.active[userId],
        projects: visible.map((p) => ({
          ...p,
          shared: p.ownerId === SHARED,
          summary: this.summary(userId, p.id),
        })),
      };
    }, false);
  }
}
