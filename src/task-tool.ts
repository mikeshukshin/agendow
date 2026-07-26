import { Type, type TSchema } from "typebox";
import { TaskStore, type TaskStatus } from "./store.js";

// Local structural shape of a core agent tool (what a tool-plugin `factory`
// returns). Kept local so this file has no deep openclaw import; it is
// structurally compatible with the SDK's AnyAgentTool.
export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown; // required to match the SDK's AgentToolResult<unknown>
}
export interface AgentTool {
  name: string;
  label: string; // required to match the SDK's AnyAgentTool
  description: string;
  parameters: TSchema;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<AgentToolResult>;
}

const literalEnum = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));

// Shared TypeBox schema — used both for static manifest metadata (in index.ts)
// and for the runtime tool's `parameters`.
export const TaskParamsSchema = Type.Object({
  action: literalEnum(["add", "list", "update", "done", "remove"]),
  id: Type.Optional(Type.String({ description: "Task id (for update/done/remove)" })),
  title: Type.Optional(Type.String({ description: "Task title (for add/update)" })),
  notes: Type.Optional(Type.String({ description: "Freeform notes (for add/update)" })),
  status: Type.Optional(literalEnum(["todo", "doing", "done"])),
});

export const TASK_TOOL_DESCRIPTION = (agentId: string) =>
  `Per-project to-do list. Tasks are automatically scoped to the current project (agent "${agentId}") — you only ever see and change this project's tasks.

ACTIONS (set "action"):
- add: create a task. Requires "title". Optional "notes".
- list: list this project's tasks. Optional "status" filter (todo|doing|done). Returns tasks + summary counts.
- update: modify a task. Requires "id". Optional "title", "notes", "status".
- done: mark a task done. Requires "id".
- remove: delete a task. Requires "id".`;

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
    description: TASK_TOOL_DESCRIPTION(agentId),
    parameters: TaskParamsSchema,
    // async so the return type is always Promise<AgentToolResult> (SDK requirement),
    // even though the store operations are synchronous.
    async execute(_toolCallId, params) {
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
            return jsonResult({
              project: agentId,
              summary: store.summary(agentId),
              tasks: store.list({ agentId, status }),
            });
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
