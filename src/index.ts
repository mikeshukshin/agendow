import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createTaskTool, TASK_TOOL_DESCRIPTION, TaskParamsSchema } from "./task-tool.js";
import { TaskStore } from "./store.js";

const configSchema = Type.Object(
  {
    storePath: Type.Optional(
      Type.String({ description: "Where tasks.json lives. Defaults to the plugin state dir." }),
    ),
  },
  { additionalProperties: false },
);

// Minimal shapes we touch on the plugin api (avoids a deep openclaw import).
interface StateRuntime {
  state?: { resolveStateDir?: (name?: string) => string };
}
interface PluginApiLike {
  resolvePath?: (input: string) => string;
  runtime?: StateRuntime;
}

function resolveStorePath(api: PluginApiLike, config: { storePath?: string }): string {
  const configured = config.storePath?.trim();
  if (configured) return api.resolvePath ? api.resolvePath(configured) : configured;
  // Resolve the gateway state dir if available, else ~/.openclaw. Always write to
  // an "agenda-clo/" subdir so we never drop a bare tasks.json into the state root
  // (which could collide with core features such as TaskFlows).
  let base: string | undefined;
  try {
    const d = api.runtime?.state?.resolveStateDir?.();
    if (typeof d === "string" && d.trim()) base = d;
  } catch {
    // fall back to home
  }
  if (!base) base = path.join(os.homedir(), ".openclaw");
  return path.join(base, "agenda-clo", "tasks.json");
}

export default defineToolPlugin({
  id: "agenda-clo",
  name: "AgendaClo",
  description: "Per-project task/todo lists for OpenClaw (project = agent).",
  configSchema,
  tools: (tool) => [
    tool({
      name: "task",
      label: "Task",
      // Static description for the manifest; the runtime tool refines it with the project id.
      description: TASK_TOOL_DESCRIPTION("<current project>"),
      parameters: TaskParamsSchema,
      // Factory: we need the runtime tool context to scope tasks to the current
      // project (agentId). Returns a concrete tool bound to that project.
      factory: ({ api, config, toolContext }) => {
        const agentId = toolContext.agentId ?? "main";
        const store = new TaskStore(resolveStorePath(api as PluginApiLike, config));
        return createTaskTool({ agentId, store });
      },
    }),
  ],
});
