// View kinds + project rendering. A "view" turns part of a project into text.
// Built-in kinds: params, sections, text, api. The api kind interpolates the
// project's params into an HTTP request and renders the JSON response via a
// template. `fetchJson` is injectable so tests run without network.

import type { ViewConfig, ProjectType } from "./config.js";
import type { Project } from "./store.js";

export type FetchReq = { url: string; method?: string; headers?: Record<string, string>; body?: string };
export type FetchJson = (req: FetchReq) => Promise<unknown>;

export interface RenderCtx {
  project: Project;
  view: ViewConfig;
  fetchJson: FetchJson;
}

// The interface a view kind implements (Phase 3 will let plugins register more).
export interface ProjectViewKind {
  kind: string;
  render(ctx: RenderCtx): Promise<string>;
}

// --- template helpers ------------------------------------------------------
function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function scalar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Interpolate {key} from a flat map. `encode` for URL-safe substitution.
export function interpolate(template: string, vars: Record<string, string>, encode = false): string {
  return template.replace(/\{([^}]+)\}/g, (_m, k) => {
    const v = vars[k.trim()] ?? "";
    return encode ? encodeURIComponent(v) : v;
  });
}

// Render {a.b.c} paths from a JSON response object.
export function renderTemplate(template: string, obj: unknown): string {
  return template.replace(/\{([^}]+)\}/g, (_m, p) => scalar(getPath(obj, p.trim())));
}

// --- built-in kinds --------------------------------------------------------
const paramsKind: ProjectViewKind = {
  kind: "params",
  async render({ project }) {
    const entries = Object.entries(project.params);
    return entries.length ? entries.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "(no parameters)";
  },
};

const sectionsKind: ProjectViewKind = {
  kind: "sections",
  async render({ project }) {
    return project.sections.length
      ? project.sections.map((s) => `#### ${s.title}\n${s.body}`).join("\n\n")
      : "(no sections)";
  },
};

const textKind: ProjectViewKind = {
  kind: "text",
  async render({ project, view }) {
    if (view.section) {
      const s = project.sections.find((x) => x.title.toLowerCase() === view.section!.toLowerCase());
      return s ? s.body : `(no section "${view.section}")`;
    }
    return view.text ?? "";
  },
};

const apiKind: ProjectViewKind = {
  kind: "api",
  async render({ project, view, fetchJson }) {
    const req = view.request;
    if (!req?.url) return "(api view has no request.url)";
    const p = project.params;
    const headers = req.headers
      ? Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, interpolate(v, p)]))
      : undefined;
    const json = await fetchJson({
      url: interpolate(req.url, p, true),
      method: req.method,
      headers,
      body: req.body ? interpolate(req.body, p) : undefined,
    });
    if (view.render) return renderTemplate(view.render, json);
    return typeof json === "string" ? json : JSON.stringify(json, null, 2);
  },
};

const BUILTIN: Record<string, ProjectViewKind> = {
  params: paramsKind,
  sections: sectionsKind,
  text: textKind,
  api: apiKind,
};

const DEFAULT_VIEWS: ViewConfig[] = [
  { kind: "params", title: "Parameters" },
  { kind: "sections", title: "Sections" },
];

// Render a whole project (its type's views, or a sensible default) to text.
export async function renderProject(
  project: Project & { status: string },
  type: ProjectType | undefined,
  fetchJson: FetchJson,
): Promise<string> {
  const views = type?.views?.length ? type.views : DEFAULT_VIEWS;
  const head = `# ${project.name}${project.status ? ` — ${project.status}` : ""}`;
  const blocks: string[] = [head];
  for (const view of views) {
    const kind = BUILTIN[view.kind];
    const title = view.title ? `### ${view.title}\n` : "";
    if (!kind) {
      blocks.push(`${title}(unknown view kind: ${view.kind})`);
      continue;
    }
    try {
      blocks.push(title + (await kind.render({ project, view, fetchJson })));
    } catch (err) {
      blocks.push(`${title}(error: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return blocks.join("\n\n");
}

// Default fetch: http(s) only, 10s timeout, 256 KB cap, JSON-or-text.
export const defaultFetchJson: FetchJson = async (req) => {
  const u = new URL(req.url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) urls allowed");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (text.length > 256 * 1024) throw new Error("response too large");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
};
