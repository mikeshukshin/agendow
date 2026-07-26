import os from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMiniAppRoutes } from "./board.js";
import { createTaskTool } from "./task-tool.js";
import { TaskStore } from "./store.js";

// Config is validated by the loader against openclaw.plugin.json's configSchema.
const BASE_PATH = "/plugins/agenda-clo";

interface AgendaConfig {
  storePath?: string;
  webProject?: string;
  ownerIds?: number[];
}

interface StateRuntime {
  state?: { resolveStateDir?: (name?: string) => string };
}
interface PluginApiLike {
  resolvePath?: (input: string) => string;
  runtime?: StateRuntime;
}

function resolveStorePath(api: PluginApiLike, cfg: AgendaConfig): string {
  const configured = cfg.storePath?.trim();
  if (configured) return api.resolvePath ? api.resolvePath(configured) : configured;
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

function readBotToken(api: unknown): string | undefined {
  const cfg = (api as { config?: { channels?: { telegram?: { botToken?: string } } } }).config;
  const t = cfg?.channels?.telegram?.botToken;
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

export default definePluginEntry({
  id: "agenda-clo",
  name: "AgendaClo",
  description: "Per-project task/todo lists for OpenClaw (project = agent), with a Telegram Mini App board.",
  register(api) {
    const cfg = ((api as { pluginConfig?: AgendaConfig }).pluginConfig ?? {}) as AgendaConfig;
    const store = new TaskStore(resolveStorePath(api as PluginApiLike, cfg));
    const project = cfg.webProject?.trim() || "main";

    // Agent tool — factory form so the tool binds to the runtime project (agentId).
    api.registerTool((ctx: { agentId?: string }) =>
      createTaskTool({ agentId: ctx.agentId ?? "main", store }),
    );

    // Telegram Mini App: page + tasks API under /plugins/agenda-clo/*.
    const routes = createMiniAppRoutes({
      store,
      project,
      ownerIds: cfg.ownerIds,
      basePath: BASE_PATH,
      getBotToken: () => readBotToken(api),
    });
    for (const route of routes) {
      api.registerHttpRoute(route);
    }

    api.logger?.info?.(`[agenda-clo] task tool + Mini App at ${BASE_PATH}/app`);
  },
});
