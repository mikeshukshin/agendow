import { Type } from "typebox";
import { type AgentTool, jsonResult, literalEnum, str } from "./tool-helpers.js";
import { TaskStore } from "./store.js";

export const ProjectParamsSchema = Type.Object({
  action: literalEnum(["list", "create", "rename", "archive", "unarchive", "switch", "current"]),
  name: Type.Optional(Type.String({ description: "Project name (for create/rename)" })),
  project: Type.Optional(
    Type.String({ description: "Target project name or id (for rename/archive/unarchive/switch)" }),
  ),
  includeArchived: Type.Optional(Type.Boolean()),
});

const DESCRIPTION = `Manage projects (named groups of tasks) and the current project.

ACTIONS (set "action"):
- list: list projects with task summary counts + which one is current.
- create: create a project. Requires "name".
- rename: rename a project. Requires "project" (current name/id) + "name" (new name).
- archive: hide a project. Requires "project".
- unarchive: restore an archived project. Requires "project".
- switch: set the current project (subsequent task ops default to it). Requires "project".
- current: show the current project + its summary.`;

export function createProjectTool(opts: { store: TaskStore }): AgentTool {
  const { store } = opts;
  return {
    name: "project",
    label: "Project",
    description: DESCRIPTION,
    parameters: ProjectParamsSchema,
    async execute(_toolCallId, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      const action = str(p.action);
      try {
        switch (action) {
          case "list":
            return jsonResult(
              p.includeArchived
                ? { active: store.activeProject().id, projects: store.listProjects({ includeArchived: true }) }
                : store.overview(),
            );
          case "create": {
            const name = str(p.name);
            if (!name) throw new Error("name required for create");
            return jsonResult(store.createProject({ name }));
          }
          case "rename": {
            const target = str(p.project);
            const name = str(p.name);
            if (!target) throw new Error("project required for rename");
            if (!name) throw new Error("name required for rename");
            return jsonResult(store.renameProject({ idOrName: target, name }));
          }
          case "archive": {
            const target = str(p.project);
            if (!target) throw new Error("project required for archive");
            return jsonResult(store.archiveProject({ idOrName: target }));
          }
          case "unarchive": {
            const target = str(p.project);
            if (!target) throw new Error("project required for unarchive");
            return jsonResult(store.unarchiveProject({ idOrName: target }));
          }
          case "switch": {
            const target = str(p.project);
            if (!target) throw new Error("project required for switch");
            const proj = store.setActiveProject(target);
            return jsonResult({ switched: true, current: { id: proj.id, name: proj.name } });
          }
          case "current": {
            const proj = store.activeProject();
            return jsonResult({ current: { id: proj.id, name: proj.name }, summary: store.summary(proj.id) });
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
