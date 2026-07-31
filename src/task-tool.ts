import { Type } from "typebox";
import { type AgentTool, jsonResult, literalEnum, str } from "./tool-helpers.js";
import { TaskStore, type TaskStatus } from "./store.js";

export const TaskParamsSchema = Type.Object({
  action: literalEnum(["add", "list", "update", "done", "remove"]),
  project: Type.Optional(
    Type.String({ description: "Project name or id. Defaults to the current project." }),
  ),
  id: Type.Optional(Type.String({ description: "Task id (for update/done/remove)" })),
  title: Type.Optional(Type.String({ description: "Task title (for add/update)" })),
  notes: Type.Optional(Type.String({ description: "Freeform notes (for add/update)" })),
  status: Type.Optional(literalEnum(["todo", "doing", "done"])),
});

const DESCRIPTION = `Manage to-do tasks inside a project. Tasks live in projects; if you omit "project", the current project is used (see the "project" tool to list/switch projects).

ACTIONS (set "action"):
- add: create a task. Requires "title". Optional "notes", "project".
- list: list a project's tasks. Optional "status" filter (todo|doing|done), "project". Returns tasks + summary counts.
- update: modify a task. Requires "id". Optional "title", "notes", "status", "project".
- done: mark a task done. Requires "id".
- remove: delete a task. Requires "id".`;

function validStatus(v: unknown): TaskStatus | undefined {
  return v === "todo" || v === "doing" || v === "done" ? v : undefined;
}

export function createTaskTool(opts: { store: TaskStore }): AgentTool {
  const { store } = opts;
  return {
    name: "task",
    label: "Task",
    description: DESCRIPTION,
    parameters: TaskParamsSchema,
    async execute(_toolCallId, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      const action = str(p.action);
      const project = str(p.project) || undefined;
      try {
        switch (action) {
          case "add": {
            const title = str(p.title);
            if (!title) throw new Error("title required for add");
            return jsonResult(store.add({ project, title, notes: str(p.notes) || undefined }));
          }
          case "list": {
            const proj = store.getProject(project ?? "");
            return jsonResult({
              project: proj ? { id: proj.id, name: proj.name } : project,
              summary: store.summary(project),
              tasks: store.list({ project, status: validStatus(p.status) }),
            });
          }
          case "update": {
            const id = str(p.id);
            if (!id) throw new Error("id required for update");
            return jsonResult(
              store.update({
                project,
                id,
                patch: {
                  title: str(p.title) || undefined,
                  notes: typeof p.notes === "string" ? str(p.notes) : undefined,
                  status: validStatus(p.status),
                },
              }),
            );
          }
          case "done": {
            const id = str(p.id);
            if (!id) throw new Error("id required for done");
            return jsonResult(store.update({ project, id, patch: { status: "done" } }));
          }
          case "remove": {
            const id = str(p.id);
            if (!id) throw new Error("id required for remove");
            return jsonResult({ removed: store.remove({ project, id }), id });
          }
          default:
            throw new Error(`unknown action: ${action || "(none)"} — use add|list|update|done|remove`);
        }
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
