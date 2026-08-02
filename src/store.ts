// Agendow store — per-user project records. A project has a name, a short
// status, typed params (key/value), and sections ("topics": named text blocks).
// Belongs to one owner (Telegram id) or is SHARED. Pure Node, atomic write.
// ponytail: whole-file read + atomic write, no lock; `overview` returns full
// projects (params + sections) — fine at personal scale, paginate if it grows.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SHARED = "shared";

export interface Section {
  id: string;
  title: string;
  body: string;
}

export interface Project {
  id: string; // globally-unique slug
  ownerId: string; // Telegram user id, or SHARED
  name: string;
  status: string; // short free-text status line
  typeId?: string; // optional config-defined project type (drives views)
  params: Record<string, string>; // typed key/value parameters
  sections: Section[]; // "topics": named text blocks
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type SectionInput = { id?: string; title: string; body?: string };
export type ProjectPatch = {
  name?: string;
  status?: string;
  typeId?: string;
  params?: Record<string, string>; // full replace
  sections?: SectionInput[]; // full replace (ids preserved / assigned)
};

interface StoreFile {
  version: number;
  active: Record<string, string>;
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

  // --- persistence + migration (any older shape -> v5) ----------------------
  private read(): StoreFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return { version: 5, active: {}, projects: [] };
    }
    if (!raw || typeof raw !== "object") return { version: 5, active: {}, projects: [] };
    const data = raw as {
      active?: Record<string, string>;
      activeProjectId?: string;
      projects?: Array<Record<string, unknown>>;
      tasks?: Array<{ agentId?: string; projectId?: string }>;
    };

    let rawProjects: Array<Record<string, unknown>>;
    if (!Array.isArray(data.projects)) {
      // v1: build shared projects from task agentIds.
      const ids = [...new Set((data.tasks ?? []).map((t) => t.projectId || t.agentId || "main"))];
      rawProjects = ids.map((id) => ({ id, ownerId: SHARED, name: id === "main" ? "Main" : id }));
    } else {
      rawProjects = data.projects;
    }

    const projects: Project[] = rawProjects.map((p) => {
      const sections: Section[] = Array.isArray(p.sections)
        ? (p.sections as SectionInput[]).map((s) => ({
            id: s.id ?? randomUUID(),
            title: String(s.title ?? "Section"),
            body: typeof s.body === "string" ? s.body : "",
          }))
        : [];
      // v4 `info` string -> a "Notes" section.
      if (typeof p.info === "string" && p.info.trim() && sections.length === 0) {
        sections.push({ id: randomUUID(), title: "Notes", body: p.info as string });
      }
      return {
        id: (p.id as string) ?? slugify((p.name as string) ?? "project"),
        ownerId: (p.ownerId as string) || SHARED, // v2 global -> shared
        name: (p.name as string) ?? (p.id as string) ?? "Project",
        status: typeof p.status === "string" ? p.status : "",
        ...(typeof p.typeId === "string" && p.typeId ? { typeId: p.typeId } : {}),
        params: p.params && typeof p.params === "object" ? (p.params as Record<string, string>) : {},
        sections,
        createdAt: (p.createdAt as string) ?? nowIso(),
        updatedAt: (p.updatedAt as string) ?? nowIso(),
        ...(p.archivedAt ? { archivedAt: p.archivedAt as string } : {}),
      };
    });

    return {
      version: 5,
      active: data.active && typeof data.active === "object" ? data.active : {},
      projects,
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

  private ensureUser(data: StoreFile, userId: string): boolean {
    let changed = false;
    const personal = data.projects.filter((p) => p.ownerId === userId && !p.archivedAt);
    if (personal.length === 0) {
      data.projects.push({
        id: this.uniqueId(data, "main"),
        ownerId: userId,
        name: "Main",
        status: "",
        params: {},
        sections: [],
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

  private resolveSection(project: Project, key: string): Section {
    const k = (key ?? "").trim();
    const lower = k.toLowerCase();
    const found =
      project.sections.find((s) => s.id === k) ??
      project.sections.find((s) => s.title.toLowerCase() === lower);
    if (!found) throw new Error(`no such section: ${key}`);
    return found;
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
  private project(data: StoreFile, userId: string, idOrName: string): Project {
    const id = this.resolveId(data, userId, idOrName);
    return data.projects.find((p) => p.id === id)!;
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
        return this.view(this.project(d, userId, idOrName));
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
    typeId?: string;
  }): Project & { shared: boolean } {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("project name required");
    return this.tx(input.userId, (d) => {
      const project: Project = {
        id: this.uniqueId(d, name),
        ownerId: input.shared ? SHARED : input.userId,
        name,
        status: (input.status ?? "").trim(),
        params: {},
        sections: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      if (input.typeId && input.typeId.trim()) project.typeId = input.typeId.trim();
      d.projects.push(project);
      return this.view(project);
    }, true);
  }

  updateProject(input: { userId: string; idOrName: string; patch: ProjectPatch }): Project & { shared: boolean } {
    return this.tx(input.userId, (d) => {
      const p = this.project(d, input.userId, input.idOrName);
      const patch = input.patch ?? {};
      if (typeof patch.name === "string" && patch.name.trim()) p.name = patch.name.trim();
      if (typeof patch.status === "string") p.status = patch.status.trim();
      if (typeof patch.typeId === "string") {
        const t = patch.typeId.trim();
        if (t) p.typeId = t;
        else delete p.typeId;
      }
      if (patch.params && typeof patch.params === "object") p.params = { ...patch.params };
      if (Array.isArray(patch.sections)) {
        p.sections = patch.sections.map((s) => ({
          id: s.id ?? randomUUID(),
          title: String(s.title ?? "").trim() || "Section",
          body: typeof s.body === "string" ? s.body : "",
        }));
      }
      p.updatedAt = nowIso();
      return this.view(p);
    }, true);
  }

  setParam(input: { userId: string; idOrName: string; key: string; value: string }): Project & { shared: boolean } {
    const key = (input.key ?? "").trim();
    if (!key) throw new Error("param key required");
    return this.tx(input.userId, (d) => {
      const p = this.project(d, input.userId, input.idOrName);
      const value = input.value ?? "";
      if (value.trim() === "") delete p.params[key];
      else p.params[key] = value;
      p.updatedAt = nowIso();
      return this.view(p);
    }, true);
  }

  addSection(input: { userId: string; idOrName: string; title: string; body?: string }): Section {
    const title = (input.title ?? "").trim();
    if (!title) throw new Error("section title required");
    return this.tx(input.userId, (d) => {
      const p = this.project(d, input.userId, input.idOrName);
      const section: Section = { id: randomUUID(), title, body: input.body ?? "" };
      p.sections.push(section);
      p.updatedAt = nowIso();
      return section;
    }, true);
  }

  updateSection(input: {
    userId: string;
    idOrName: string;
    section: string;
    patch: { title?: string; body?: string };
  }): Section {
    return this.tx(input.userId, (d) => {
      const p = this.project(d, input.userId, input.idOrName);
      const s = this.resolveSection(p, input.section);
      if (typeof input.patch.title === "string" && input.patch.title.trim()) s.title = input.patch.title.trim();
      if (typeof input.patch.body === "string") s.body = input.patch.body;
      p.updatedAt = nowIso();
      return s;
    }, true);
  }

  removeSection(input: { userId: string; idOrName: string; section: string }): boolean {
    return this.tx(input.userId, (d) => {
      const p = this.project(d, input.userId, input.idOrName);
      const before = p.sections.length;
      const s = this.resolveSection(p, input.section);
      p.sections = p.sections.filter((x) => x.id !== s.id);
      p.updatedAt = nowIso();
      return p.sections.length !== before;
    }, true);
  }

  archiveProject(input: { userId: string; idOrName: string }): Project & { shared: boolean } {
    return this.tx(input.userId, (d) => {
      const p = this.project(d, input.userId, input.idOrName);
      p.archivedAt = nowIso();
      p.updatedAt = nowIso();
      for (const uid of Object.keys(d.active)) {
        if (d.active[uid] === p.id) this.ensureUser(d, uid);
      }
      return this.view(p);
    }, true);
  }

  unarchiveProject(input: { userId: string; idOrName: string }): Project & { shared: boolean } {
    return this.tx(input.userId, (d) => {
      const p = this.project(d, input.userId, input.idOrName);
      delete p.archivedAt;
      p.updatedAt = nowIso();
      return this.view(p);
    }, true);
  }

  activeProject(userId: string): Project & { shared: boolean } {
    return this.tx(userId, (d) => this.view(d.projects.find((p) => p.id === d.active[userId])!), false);
  }

  setActiveProject(userId: string, idOrName: string): Project & { shared: boolean } {
    return this.tx(userId, (d) => {
      const p = this.project(d, userId, idOrName);
      d.active[userId] = p.id;
      return this.view(p);
    }, true);
  }

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
