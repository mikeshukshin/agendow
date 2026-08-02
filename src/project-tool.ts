import { Type } from "typebox";
import { listTypes, loadConfig } from "./config.js";
import { type AgentTool, jsonResult, literalEnum, str } from "./tool-helpers.js";
import { TaskStore } from "./store.js";
import { defaultFetchJson, type FetchJson, renderProject } from "./views.js";

const ACTIONS = [
  "list", "get", "create", "update", "archive", "unarchive", "switch", "current",
  "set_param", "add_section", "update_section", "remove_section", "render", "types",
] as const;

export const ProjectParamsSchema = Type.Object({
  action: literalEnum(ACTIONS),
  project: Type.Optional(Type.String({ description: "Target project name or id. Defaults to current." })),
  name: Type.Optional(Type.String({ description: "Project name (create, or rename via update)" })),
  status: Type.Optional(Type.String({ description: "Short status line (create/update)" })),
  type: Type.Optional(Type.String({ description: "Project type id from config (create/update). Empty clears it." })),
  shared: Type.Optional(Type.Boolean({ description: "For create: shared project visible to all owners." })),
  key: Type.Optional(Type.String({ description: "Param key (set_param). Empty value removes it." })),
  value: Type.Optional(Type.String({ description: "Param value (set_param)" })),
  section: Type.Optional(Type.String({ description: "Section title or id (update_section/remove_section)" })),
  title: Type.Optional(Type.String({ description: "Section title (add_section, or rename via update_section)" })),
  body: Type.Optional(Type.String({ description: "Section body text, markdown (add_section/update_section)" })),
  includeArchived: Type.Optional(Type.Boolean()),
});

const DESCRIPTION = `Manage the current user's projects. A project is a workspace: a name, a short "status", typed "params" (key/value), "sections" (named text blocks), and an optional config-defined "type" that drives its views. Private per user unless created "shared".

ACTIONS (set "action"):
- list: visible projects with status. get / current: one project in full (status, type, params, sections).
- create: requires "name". Optional "status", "type", "shared".
- update: change "name", "status" and/or "type". Optional "project".
- set_param: "key" + "value" (empty removes). add_section: "title" (+ "body").
  update_section: "section" + "title"/"body". remove_section: "section".
- render: render the project (its type's views, incl. api views) to text. Optional "project". Use to fetch/show a project's live API-backed views.
- types: list available config-defined project types.
- archive / unarchive / switch.`;

export function createProjectTool(opts: {
  store: TaskStore;
  userId: string;
  configPath: string;
  fetchJson?: FetchJson;
}): AgentTool {
  const { store, userId, configPath } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  return {
    name: "project",
    label: "Project",
    description: DESCRIPTION,
    parameters: ProjectParamsSchema,
    async execute(_toolCallId, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      const action = str(p.action);
      const project = str(p.project);
      try {
        switch (action) {
          case "list":
            return jsonResult(
              p.includeArchived
                ? { active: store.activeProject(userId).id, projects: store.listProjects(userId, { includeArchived: true }) }
                : store.overview(userId),
            );
          case "get":
          case "current": {
            const proj = action === "current" ? store.activeProject(userId) : store.getProject(userId, project);
            if (!proj) throw new Error(`no such project: ${project || "(current)"}`);
            return jsonResult(proj);
          }
          case "create": {
            const name = str(p.name);
            if (!name) throw new Error("name required for create");
            return jsonResult(store.createProject({
              userId, name, shared: p.shared === true,
              status: str(p.status) || undefined, typeId: str(p.type) || undefined,
            }));
          }
          case "update":
            return jsonResult(store.updateProject({
              userId,
              idOrName: project,
              patch: {
                name: str(p.name) || undefined,
                status: typeof p.status === "string" ? str(p.status) : undefined,
                typeId: typeof p.type === "string" ? str(p.type) : undefined,
              },
            }));
          case "set_param": {
            const key = str(p.key);
            if (!key) throw new Error("key required for set_param");
            return jsonResult(store.setParam({ userId, idOrName: project, key, value: typeof p.value === "string" ? p.value : "" }));
          }
          case "add_section": {
            const title = str(p.title);
            if (!title) throw new Error("title required for add_section");
            return jsonResult(store.addSection({ userId, idOrName: project, title, body: typeof p.body === "string" ? p.body : "" }));
          }
          case "update_section": {
            const section = str(p.section);
            if (!section) throw new Error("section required for update_section");
            return jsonResult(store.updateSection({
              userId, idOrName: project, section,
              patch: { title: str(p.title) || undefined, body: typeof p.body === "string" ? p.body : undefined },
            }));
          }
          case "remove_section": {
            const section = str(p.section);
            if (!section) throw new Error("section required for remove_section");
            return jsonResult({ removed: store.removeSection({ userId, idOrName: project, section }), section });
          }
          case "render": {
            const proj = store.getProject(userId, project);
            if (!proj) throw new Error(`no such project: ${project || "(current)"}`);
            const cfg = loadConfig(configPath);
            const type = proj.typeId ? cfg.projectTypes[proj.typeId] : undefined;
            const text = await renderProject(proj, type, fetchJson);
            return { content: [{ type: "text", text }], details: { project: proj.id, text } };
          }
          case "types":
            return jsonResult({ types: listTypes(loadConfig(configPath)) });
          case "archive":
            if (!project) throw new Error("project required for archive");
            return jsonResult(store.archiveProject({ userId, idOrName: project }));
          case "unarchive":
            if (!project) throw new Error("project required for unarchive");
            return jsonResult(store.unarchiveProject({ userId, idOrName: project }));
          case "switch": {
            if (!project) throw new Error("project required for switch");
            const proj = store.setActiveProject(userId, project);
            return jsonResult({ switched: true, current: { id: proj.id, name: proj.name } });
          }
          default:
            throw new Error(`unknown action: ${action || "(none)"}`);
        }
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
