import os from "node:os";
import path from "node:path";
import type { PluginApi } from "./openclaw-types.js";
import { createTaskTool } from "./task-tool.js";
import { TaskStore } from "./store.js";

function resolveStorePath(api: PluginApi): string {
  const cfg = (api.pluginConfig ?? {}) as { storePath?: string };
  if (typeof cfg.storePath === "string" && cfg.storePath.trim()) {
    return api.resolvePath(cfg.storePath.trim());
  }
  let base: string | undefined;
  try {
    const d = api.runtime?.state?.resolveStateDir?.("agenda-clo");
    if (typeof d === "string" && d.trim()) base = d;
  } catch {
    // fall back to home
  }
  if (!base) base = path.join(os.homedir(), ".openclaw", "agenda-clo");
  return path.join(base, "tasks.json");
}

const plugin = {
  id: "agenda-clo",
  name: "AgendaClo",
  description: "Per-project task/todo lists for OpenClaw (project = agent).",
  register(api: PluginApi) {
    const store = new TaskStore(resolveStorePath(api));
    // Factory form: `ctx.agentId` is the current project, so each run's tool is scoped to it.
    api.registerTool((ctx) => createTaskTool({ agentId: ctx.agentId ?? "main", store }), {
      optional: true,
    });
    api.logger.info?.("[agenda-clo] task tool registered");
  },
};

export default plugin;
