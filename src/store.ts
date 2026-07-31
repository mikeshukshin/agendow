// AgendaClo store — per-user projects as living records: a short status line and
// a free-form info/notes field. A project belongs to one owner (Telegram id) or
// is SHARED (visible to all owners). Each user has their own "current project".
// Pure Node, atomic write. ponytail: whole-file read + atomic write, no lock —
// fine at personal scale; note `overview` returns full info for every project.

import fs from "node:fs";
import path from "node:path";

export const SHARED = "shared";

export interface Project {
  id: string; // globally-unique slug
  ownerId: string; // Telegram user id, or SHARED
  name: string;
  status: string; // short free-text status line
  info: string; // free-form notes (markdown)
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type ProjectPatch = { name?: string; status?: string; info?: string };

interface StoreFile {
  version: number;
  active: Record<string, string>; // userId -> current projectId
  projects: Project[];
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

  // --- persistence + migration (any older shape -> v4) ----------------------
  private read(): StoreFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return { version: 4, active: {}, projects: [] };
    }
    if (!raw || typeof raw !== "object") return { version: 4, active: {}, projects: [] };
    const data = raw as {
      active?: Record<string, string>;
      activeProjectId?: string;
      projects?: Array<Partial<Project> & { ownerId?: string }>;
      tasks?: Array<{ agentId?: string; projectId?: string }>;
    };

    // v1: no projects, tasks tagged agentId -> build shared projects.
    let projects: Array<Partial<Project> & { ownerId?: string }>;
    if (!Array.isArray(data.projects)) {
      const ids = [...new Set((data.tasks ?? []).map((t) => t.projectId || t.agentId || "main"))];
      projects = ids.map((id) => ({ id, ownerId: SHARED, name: id === "main" ? "Main" : id }));
    } else {
      projects = data.projects;
    }

    const normalized: Project[] = projects.map((p) => ({
      id: p.id ?? slugify(p.name ?? "project"),
      ownerId: p.ownerId || SHARED, // v2 global projects -> shared
      name: p.name ?? p.id ?? "Project",
      status: typeof p.status === "string" ? p.status : "",
      info: typeof p.info === "string" ? p.info : "",
      createdAt: p.createdAt ?? nowIso(),
      updatedAt: p.updatedAt ?? nowIso(),
      ...(p.archivedAt ? { archivedAt: p.archivedAt } : {}),
    }));

    return {
      version: 4,
      active: data.active && typeof data.active === "object" ? data.active : {},
      projects: normalized,
    };
  }

  private write(data: StoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

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
      data.projects.push({
        id: this.uniqueId(data, "main"),
        ownerId: userId,
        name: "Main",
        status: "",
        info: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
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

  private tx<T>(userId: string, fn: (data: StoreFile) => T, write: boolean): T {
    const data = this.read();
    const seeded = this.ensureUser(data, userId);
    const result = fn(data);
    if (write || seeded) this.write(data);
    return result;
  }

  private view(p: Project): Project & { shared: boolean } {
    return { ...p, shared: p.ownerId === SHARED };
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

  getProject(userId: string, idOrName: string): (Project & { shared: boolean }) | undefined {
    return this.tx(userId, (d) => {
      try {
        const id = this.resolveId(d, userId, idOrName);
        const p = d.projects.find((x) => x.id === id);
        return p ? this.view(p) : undefined;
      } catch {
        return undefined;
      }
    }, false);
  }

  createProject(input: {
    userId: string;
    name: string;
    shared?: boolean;
    status?: string;
    info?: string;
  }): Project & { shared: boolean } {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("project name required");
    return this.tx(input.userId, (d) => {
      const project: Project = {
        id: this.uniqueId(d, name),
        ownerId: input.shared ? SHARED : input.userId,
        name,
        status: (input.status ?? "").trim(),
        info: input.info ?? "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      d.projects.push(project);
      return this.view(project);
    }, true);
  }

  updateProject(input: {
    userId: string;
    idOrName: string;
    patch: ProjectPatch;
  }): Project & { shared: boolean } {
    return this.tx(input.userId, (d) => {
      const id = this.resolveId(d, input.userId, input.idOrName);
      const project = d.projects.find((p) => p.id === id)!;
      const patch = input.patch ?? {};
      if (typeof patch.name === "string" && patch.name.trim()) project.name = patch.name.trim();
      if (typeof patch.status === "string") project.status = patch.status.trim();
      if (typeof patch.info === "string") project.info = patch.info;
      project.updatedAt = nowIso();
      return this.view(project);
    }, true);
  }

  archiveProject(input: { userId: string; idOrName: string }): Project & { shared: boolean } {
    return this.tx(input.userId, (d) => {
      const id = this.resolveId(d, input.userId, input.idOrName);
      const project = d.projects.find((p) => p.id === id)!;
      project.archivedAt = nowIso();
      project.updatedAt = nowIso();
      for (const uid of Object.keys(d.active)) {
        if (d.active[uid] === id) this.ensureUser(d, uid);
      }
      return this.view(project);
    }, true);
  }

  unarchiveProject(input: { userId: string; idOrName: string }): Project & { shared: boolean } {
    return this.tx(input.userId, (d) => {
      const id = this.resolveId(d, input.userId, input.idOrName);
      const project = d.projects.find((p) => p.id === id)!;
      delete project.archivedAt;
      project.updatedAt = nowIso();
      return this.view(project);
    }, true);
  }

  activeProject(userId: string): Project & { shared: boolean } {
    return this.tx(userId, (d) => this.view(d.projects.find((p) => p.id === d.active[userId])!), false);
  }

  setActiveProject(userId: string, idOrName: string): Project & { shared: boolean } {
    return this.tx(userId, (d) => {
      const id = this.resolveId(d, userId, idOrName);
      d.active[userId] = id;
      return this.view(d.projects.find((p) => p.id === id)!);
    }, true);
  }

  // Dashboard roll-up for one user: current project id + visible projects (full).
  overview(userId: string): {
    activeProjectId: string;
    projects: Array<Project & { shared: boolean }>;
  } {
    return this.tx(userId, (d) => ({
      activeProjectId: d.active[userId],
      projects: this.visibleTo(d, userId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .map((p) => this.view(p)),
    }), false);
  }
}
