import os from "node:os";
import path from "node:path";
import { createBoardRoutes } from "./board.js";
import type { PluginApi } from "./openclaw-types.js";
import { createTaskTool } from "./task-tool.js";
import { TaskStore } from "./store.js";

interface AgendaConfig {
  storePath?: string;
  board?: { enabled?: boolean; path?: string; token?: string };
}

function resolveStorePath(api: PluginApi, cfg: AgendaConfig): string {
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
    const cfg = (api.pluginConfig ?? {}) as AgendaConfig;
    const store = new TaskStore(resolveStorePath(api, cfg));

    // Agent tool — factory form: `ctx.agentId` is the current project.
    api.registerTool((ctx) => createTaskTool({ agentId: ctx.agentId ?? "main", store }), {
      optional: true,
    });

    // Project board (the alternative interface besides chat).
    const board = cfg.board ?? {};
    if (board.enabled !== false) {
      const boardPath = (board.path ?? "/agenda").trim() || "/agenda";
      const token = typeof board.token === "string" && board.token.trim() ? board.token.trim() : undefined;
      for (const route of createBoardRoutes({ store, path: boardPath, token })) {
        api.registerHttpRoute(route);
      }
      api.logger.info?.(
        `[agenda-clo] board at ${boardPath}${token ? " (token-protected)" : " (read-only)"}`,
      );
    }

    api.logger.info?.("[agenda-clo] task tool registered");
  },
};

export default plugin;
