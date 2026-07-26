import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "./openclaw-types.js";
import { TaskStore, type TaskStatus } from "./store.js";

const literalEnum = (values: readonly string[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));

const TaskToolSchema = Type.Object({
  action: literalEnum(["add", "list", "update", "done", "remove"]),
  id: Type.Optional(Type.String({ description: "Task id (for update/done/remove)" })),
  title: Type.Optional(Type.String({ description: "Task title (for add/update)" })),
  notes: Type.Optional(Type.String({ description: "Freeform notes (for add/update)" })),
  status: Type.Optional(literalEnum(["todo", "doing", "done"])),
});

function jsonResult(payload: unknown): AgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function validStatus(v: unknown): TaskStatus | undefined {
  return v === "todo" || v === "doing" || v === "done" ? v : undefined;
}

export function createTaskTool(opts: { agentId: string; store: TaskStore }): AgentTool {
  const { agentId, store } = opts;
  return {
    name: "task",
    label: "Task",
    description: `Per-project to-do list. Tasks are automatically scoped to the current project (agent "${agentId}") — you only ever see and change this project's tasks.

ACTIONS (set "action"):
- add: create a task. Requires "title". Optional "notes".
- list: list this project's tasks. Optional "status" filter (todo|doing|done). Returns tasks + summary counts.
- update: modify a task. Requires "id". Optional "title", "notes", "status".
- done: mark a task done. Requires "id".
- remove: delete a task. Requires "id".`,
    parameters: TaskToolSchema,
    execute(_toolCallId, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      const action = str(p.action);
      try {
        switch (action) {
          case "add": {
            const title = str(p.title);
            if (!title) throw new Error("title required for add");
            return jsonResult(store.add({ agentId, title, notes: str(p.notes) || undefined }));
          }
          case "list": {
            const status = validStatus(p.status);
            const tasks = store.list({ agentId, status });
            return jsonResult({ project: agentId, summary: store.summary(agentId), tasks });
          }
          case "update": {
            const id = str(p.id);
            if (!id) throw new Error("id required for update");
            return jsonResult(
              store.update({
                agentId,
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
            return jsonResult(store.update({ agentId, id, patch: { status: "done" } }));
          }
          case "remove": {
            const id = str(p.id);
            if (!id) throw new Error("id required for remove");
            return jsonResult({ removed: store.remove({ agentId, id }), id });
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
