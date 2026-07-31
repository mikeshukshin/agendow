import { Type } from "typebox";
import { type AgentTool, jsonResult, literalEnum, str } from "./tool-helpers.js";
import { TaskStore } from "./store.js";

export const ProjectParamsSchema = Type.Object({
  action: literalEnum(["list", "create", "rename", "archive", "unarchive", "switch", "current"]),
  name: Type.Optional(Type.String({ description: "Project name (for create/rename)" })),
  project: Type.Optional(
    Type.String({ description: "Target project name or id (for rename/archive/unarchive/switch)" }),
  ),
  shared: Type.Optional(
    Type.Boolean({ description: "For create: make it a shared project visible to all owners." }),
  ),
  includeArchived: Type.Optional(Type.Boolean()),
});

const DESCRIPTION = `Manage the current user's projects (named groups of tasks) and their current project. Projects are private to the user unless created as "shared".

ACTIONS (set "action"):
- list: list visible projects (yours + shared) with summary counts + which is current.
- create: create a project. Requires "name". Set "shared": true for a shared project.
- rename: rename a project. Requires "project" + "name".
- archive: hide a project. Requires "project".
- unarchive: restore an archived project. Requires "project".
- switch: set your current project. Requires "project".
- current: show your current project + its summary.`;

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
      try {
        switch (action) {
          case "list":
            return jsonResult(
              p.includeArchived
                ? {
                    active: store.activeProject(userId).id,
                    projects: store.listProjects(userId, { includeArchived: true }),
                  }
                : store.overview(userId),
            );
          case "create": {
            const name = str(p.name);
            if (!name) throw new Error("name required for create");
            return jsonResult(store.createProject({ userId, name, shared: p.shared === true }));
          }
          case "rename": {
            const target = str(p.project);
            const name = str(p.name);
            if (!target) throw new Error("project required for rename");
            if (!name) throw new Error("name required for rename");
            return jsonResult(store.renameProject({ userId, idOrName: target, name }));
          }
          case "archive": {
            const target = str(p.project);
            if (!target) throw new Error("project required for archive");
            return jsonResult(store.archiveProject({ userId, idOrName: target }));
          }
          case "unarchive": {
            const target = str(p.project);
            if (!target) throw new Error("project required for unarchive");
            return jsonResult(store.unarchiveProject({ userId, idOrName: target }));
          }
          case "switch": {
            const target = str(p.project);
            if (!target) throw new Error("project required for switch");
            const proj = store.setActiveProject(userId, target);
            return jsonResult({ switched: true, current: { id: proj.id, name: proj.name } });
          }
          case "current": {
            const proj = store.activeProject(userId);
            return jsonResult({
              current: { id: proj.id, name: proj.name, shared: proj.ownerId === "shared" },
              summary: store.summary(userId, proj.id),
            });
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
