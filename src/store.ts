// AgendaClo store — lightweight projects + per-project tasks.
// Pure Node, no external deps. A "project" is a named group (id = slug); tasks
// belong to exactly one project. One global "active project" pointer is shared
// across chat and the Mini App (single-user, so a global pointer is enough).
// ponytail: whole-file read + atomic write, no lock. Fine at personal scale.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "todo" | "doing" | "done";

export interface Project {
  id: string; // slug, stable across renames
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
  activeProjectId: string;
  projects: Project[];
  tasks: Task[];
}

const DEFAULT_PROJECT_ID = "main";

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "project";
}

function titleCase(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || id;
}

export class TaskStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  // --- persistence + migration ---------------------------------------------
  private read(): StoreFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return this.seed();
    }
    if (!raw || typeof raw !== "object") return this.seed();
    const data = raw as Partial<StoreFile> & { tasks?: Array<Task & { agentId?: string }> };
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];

    // Migrate v1 (tasks tagged agentId, no projects) -> v2 (projectId + projects).
    if (!Array.isArray(data.projects)) {
      for (const t of tasks) {
        if (!t.projectId) t.projectId = t.agentId || DEFAULT_PROJECT_ID;
        delete t.agentId;
      }
      const ids = [...new Set(tasks.map((t) => t.projectId))];
      if (!ids.includes(DEFAULT_PROJECT_ID)) ids.unshift(DEFAULT_PROJECT_ID);
      const projects: Project[] = ids.map((id) => ({
        id,
        name: id === DEFAULT_PROJECT_ID ? "Main" : titleCase(id),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }));
      return this.normalize({ version: 2, activeProjectId: DEFAULT_PROJECT_ID, projects, tasks });
    }
    return this.normalize({
      version: 2,
      activeProjectId: data.activeProjectId || DEFAULT_PROJECT_ID,
      projects: data.projects,
      tasks,
    });
  }

  private seed(): StoreFile {
    return {
      version: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [
        { id: DEFAULT_PROJECT_ID, name: "Main", createdAt: nowIso(), updatedAt: nowIso() },
      ],
      tasks: [],
    };
  }

  // Guarantee there is always at least one project and a valid active pointer.
  private normalize(data: StoreFile): StoreFile {
    if (data.projects.length === 0) {
      data.projects.push({
        id: DEFAULT_PROJECT_ID,
        name: "Main",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
    const active = data.projects.find((p) => p.id === data.activeProjectId && !p.archivedAt);
    if (!active) {
      const firstOpen = data.projects.find((p) => !p.archivedAt) ?? data.projects[0];
      data.activeProjectId = firstOpen.id;
    }
    return data;
  }

  private write(data: StoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // --- project resolution ---------------------------------------------------
  private resolveId(data: StoreFile, project?: string): string {
    const key = (project ?? "").trim();
    if (!key) return data.activeProjectId;
    const lower = key.toLowerCase();
    const found =
      data.projects.find((p) => p.id === lower) ??
      data.projects.find((p) => p.name.toLowerCase() === lower);
    if (!found) throw new Error(`no such project: ${project}`);
    return found.id;
  }

  // --- projects -------------------------------------------------------------
  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    return this.read()
      .projects.filter((p) => opts.includeArchived || !p.archivedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  getProject(idOrName: string): Project | undefined {
    const data = this.read();
    try {
      const id = this.resolveId(data, idOrName);
      return data.projects.find((p) => p.id === id);
    } catch {
      return undefined;
    }
  }

  createProject(input: { name: string }): Project {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("project name required");
    const data = this.read();
    let id = slugify(name);
    if (data.projects.some((p) => p.id === id)) {
      let n = 2;
      while (data.projects.some((p) => p.id === `${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    const project: Project = { id, name, createdAt: nowIso(), updatedAt: nowIso() };
    data.projects.push(project);
    this.write(data);
    return project;
  }

  renameProject(input: { idOrName: string; name: string }): Project {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("new name required");
    const data = this.read();
    const id = this.resolveId(data, input.idOrName);
    const project = data.projects.find((p) => p.id === id)!;
    project.name = name;
    project.updatedAt = nowIso();
    this.write(data);
    return project;
  }

  archiveProject(input: { idOrName: string }): Project {
    const data = this.read();
    const id = this.resolveId(data, input.idOrName);
    const project = data.projects.find((p) => p.id === id)!;
    project.archivedAt = nowIso();
    project.updatedAt = nowIso();
    this.normalize(data); // may move the active pointer off an archived project
    this.write(data);
    return project;
  }

  unarchiveProject(input: { idOrName: string }): Project {
    const data = this.read();
    const id = this.resolveId(data, input.idOrName);
    const project = data.projects.find((p) => p.id === id)!;
    delete project.archivedAt;
    project.updatedAt = nowIso();
    this.write(data);
    return project;
  }

  activeProject(): Project {
    const data = this.read();
    return data.projects.find((p) => p.id === data.activeProjectId)!;
  }

  setActiveProject(idOrName: string): Project {
    const data = this.read();
    const id = this.resolveId(data, idOrName);
    data.activeProjectId = id;
    this.write(data);
    return data.projects.find((p) => p.id === id)!;
  }

  // --- tasks (scoped to a project; default = active) ------------------------
  add(input: { project?: string; title: string; notes?: string }): Task {
    const title = (input.title ?? "").trim();
    if (!title) throw new Error("title required");
    const data = this.read();
    const projectId = this.resolveId(data, input.project);
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
    data.tasks.push(task);
    this.write(data);
    return task;
  }

  list(input: { project?: string; status?: TaskStatus } = {}): Task[] {
    const data = this.read();
    const projectId = this.resolveId(data, input.project);
    return data.tasks
      .filter((t) => t.projectId === projectId && (!input.status || t.status === input.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  get(input: { project?: string; id: string }): Task | undefined {
    const data = this.read();
    const projectId = this.resolveId(data, input.project);
    return data.tasks.find((t) => t.id === input.id && t.projectId === projectId);
  }

  update(input: { project?: string; id: string; patch: TaskPatch }): Task {
    const id = (input.id ?? "").trim();
    if (!id) throw new Error("id required");
    const data = this.read();
    const projectId = this.resolveId(data, input.project);
    const task = data.tasks.find((t) => t.id === id && t.projectId === projectId);
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
    this.write(data);
    return task;
  }

  remove(input: { project?: string; id: string }): boolean {
    const data = this.read();
    const projectId = this.resolveId(data, input.project);
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => !(t.id === input.id && t.projectId === projectId));
    if (data.tasks.length === before) return false;
    this.write(data);
    return true;
  }

  summary(project?: string): Summary {
    const tasks = this.list({ project });
    const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
    return { total: tasks.length, todo: count("todo"), doing: count("doing"), done: count("done") };
  }

  // Dashboard roll-up: active project id + every open project with its summary.
  overview(): { activeProjectId: string; projects: Array<Project & { summary: Summary }> } {
    const data = this.read();
    return {
      activeProjectId: data.activeProjectId,
      projects: this.listProjects().map((p) => ({ ...p, summary: this.summary(p.id) })),
    };
  }
}
