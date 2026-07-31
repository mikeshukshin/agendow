import { Type } from "typebox";
import { type AgentTool, jsonResult, literalEnum, str } from "./tool-helpers.js";
import { TaskStore } from "./store.js";

export const ProjectParamsSchema = Type.Object({
  action: literalEnum(["list", "get", "create", "update", "archive", "unarchive", "switch", "current"]),
  project: Type.Optional(
    Type.String({ description: "Target project name or id. Defaults to the current project." }),
  ),
  name: Type.Optional(Type.String({ description: "Project name (create, or rename via update)" })),
  status: Type.Optional(Type.String({ description: "Short status line (create/update)" })),
  info: Type.Optional(
    Type.String({ description: "Free-form notes / recorded info, markdown (create/update). Replaces existing info." }),
  ),
  shared: Type.Optional(
    Type.Boolean({ description: "For create: make it a shared project visible to all owners." }),
  ),
  includeArchived: Type.Optional(Type.Boolean()),
});

const DESCRIPTION = `Manage the current user's projects. A project is a living record: a name, a short "status", and free-form "info" notes (goal, context, next steps, anything). Projects are private to the user unless created as "shared".

ACTIONS (set "action"):
- list: list visible projects (yours + shared) with their status. Use this for "what projects do I have".
- get: show one project in full (status + info). Optional "project" (defaults to current).
- create: create a project. Requires "name". Optional "status", "info", "shared".
- update: change a project. Optional "project" (defaults to current) + any of "name", "status", "info". "info" replaces the whole notes field.
- archive / unarchive: hide / restore a project. Requires "project".
- switch: set the current project. Requires "project".
- current: show the current project in full.`;

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
      const target = str(p.project);
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
          case "get": {
            const proj = store.getProject(userId, target);
            if (!proj) throw new Error(`no such project: ${target || "(current)"}`);
            return jsonResult(proj);
          }
          case "create": {
            const name = str(p.name);
            if (!name) throw new Error("name required for create");
            return jsonResult(
              store.createProject({
                userId,
                name,
                shared: p.shared === true,
                status: str(p.status) || undefined,
                info: typeof p.info === "string" ? p.info : undefined,
              }),
            );
          }
          case "update": {
            return jsonResult(
              store.updateProject({
                userId,
                idOrName: target,
                patch: {
                  name: str(p.name) || undefined,
                  status: typeof p.status === "string" ? str(p.status) : undefined,
                  info: typeof p.info === "string" ? p.info : undefined,
                },
              }),
            );
          }
          case "archive": {
            if (!target) throw new Error("project required for archive");
            return jsonResult(store.archiveProject({ userId, idOrName: target }));
          }
          case "unarchive": {
            if (!target) throw new Error("project required for unarchive");
            return jsonResult(store.unarchiveProject({ userId, idOrName: target }));
          }
          case "switch": {
            if (!target) throw new Error("project required for switch");
            const proj = store.setActiveProject(userId, target);
            return jsonResult({ switched: true, current: { id: proj.id, name: proj.name } });
          }
          case "current":
            return jsonResult(store.activeProject(userId));
          default:
            throw new Error(`unknown action: ${action || "(none)"}`);
        }
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
