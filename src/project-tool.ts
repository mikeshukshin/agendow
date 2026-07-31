import { Type } from "typebox";
import { type AgentTool, jsonResult, literalEnum, str } from "./tool-helpers.js";
import { TaskStore } from "./store.js";

const ACTIONS = [
  "list", "get", "create", "update", "archive", "unarchive", "switch", "current",
  "set_param", "add_section", "update_section", "remove_section",
] as const;

export const ProjectParamsSchema = Type.Object({
  action: literalEnum(ACTIONS),
  project: Type.Optional(Type.String({ description: "Target project name or id. Defaults to current." })),
  name: Type.Optional(Type.String({ description: "Project name (create, or rename via update)" })),
  status: Type.Optional(Type.String({ description: "Short status line (create/update)" })),
  shared: Type.Optional(Type.Boolean({ description: "For create: shared project visible to all owners." })),
  key: Type.Optional(Type.String({ description: "Param key (set_param). Empty value removes it." })),
  value: Type.Optional(Type.String({ description: "Param value (set_param)" })),
  section: Type.Optional(Type.String({ description: "Section title or id (update_section/remove_section)" })),
  title: Type.Optional(Type.String({ description: "Section title (add_section, or rename via update_section)" })),
  body: Type.Optional(Type.String({ description: "Section body text, markdown (add_section/update_section)" })),
  includeArchived: Type.Optional(Type.Boolean()),
});

const DESCRIPTION = `Manage the current user's projects. A project is a record: a name, a short "status", typed "params" (key/value), and "sections" (named text blocks — the project's topics). Private per user unless created "shared".

ACTIONS (set "action"):
- list: visible projects (yours + shared) with their status. For "what projects do I have".
- get / current: show one project in full (status, params, sections). Optional "project".
- create: create a project. Requires "name". Optional "status", "shared".
- update: change "name" and/or "status". Optional "project".
- set_param: set/remove a parameter. Requires "key"; "value" (empty removes). Optional "project".
- add_section: add a section/topic. Requires "title". Optional "body", "project".
- update_section: edit a section. Requires "section" (title/id) + "title" and/or "body".
- remove_section: delete a section. Requires "section".
- archive / unarchive: hide / restore. Requires "project".
- switch: set the current project. Requires "project".`;

export function createProjectTool(opts: { store: TaskStore; userId: string }): AgentTool {
  const { store, userId } = opts;
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
            return jsonResult(store.createProject({ userId, name, shared: p.shared === true, status: str(p.status) || undefined }));
          }
          case "update":
            return jsonResult(store.updateProject({
              userId,
              idOrName: project,
              patch: {
                name: str(p.name) || undefined,
                status: typeof p.status === "string" ? str(p.status) : undefined,
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
              userId,
              idOrName: project,
              section,
              patch: { title: str(p.title) || undefined, body: typeof p.body === "string" ? p.body : undefined },
            }));
          }
          case "remove_section": {
            const section = str(p.section);
            if (!section) throw new Error("section required for remove_section");
            return jsonResult({ removed: store.removeSection({ userId, idOrName: project, section }), section });
          }
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
