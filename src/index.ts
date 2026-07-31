import os from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMiniAppRoutes } from "./board.js";
import { createProjectTool } from "./project-tool.js";
import { createTaskTool } from "./task-tool.js";
import { TaskStore } from "./store.js";

// Config is validated by the loader against openclaw.plugin.json's configSchema.
const BASE_PATH = "/plugins/agenda-clo";

interface AgendaConfig {
  storePath?: string;
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

// Pull a Telegram user id out of the tool context's sender id (e.g. "88888263"
// or "telegram:88888263").
function telegramIdFromSender(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const m = raw.match(/(\d{4,})/);
  return m ? m[1] : undefined;
}

export default definePluginEntry({
  id: "agenda-clo",
  name: "AgendaClo",
  description: "Per-user projects + task lists for OpenClaw, with a Telegram Mini App board.",
  register(api) {
    const cfg = ((api as { pluginConfig?: AgendaConfig }).pluginConfig ?? {}) as AgendaConfig;
    const store = new TaskStore(resolveStorePath(api as PluginApiLike, cfg));
    const ownerSet = (cfg.ownerIds ?? []).map(String);

    // Resolve the requesting owner from the tool context; returns undefined for
    // unidentified or non-owner senders, so the tool is omitted for them.
    const toOwner = (ctx: { requesterSenderId?: string }): string | undefined => {
      const raw = ctx.requesterSenderId;
      const uid = telegramIdFromSender(raw);
      if (!uid) {
        // A sender was present but we couldn't parse a Telegram id — surface it
        // so the format can be fixed instead of silently hiding the tools.
        if (typeof raw === "string" && raw.trim()) {
          api.logger?.warn?.(`[agenda-clo] unrecognized sender id: ${raw}`);
        }
        return undefined;
      }
      if (ownerSet.length > 0 && !ownerSet.includes(uid)) return undefined;
      return uid;
    };

    api.registerTool((ctx: { requesterSenderId?: string }) => {
      const uid = toOwner(ctx);
      return uid ? createTaskTool({ store, userId: uid }) : null;
    });
    api.registerTool((ctx: { requesterSenderId?: string }) => {
      const uid = toOwner(ctx);
      return uid ? createProjectTool({ store, userId: uid }) : null;
    });

    for (const route of createMiniAppRoutes({
      store,
      ownerIds: cfg.ownerIds,
      basePath: BASE_PATH,
      getBotToken: () => readBotToken(api),
    })) {
      api.registerHttpRoute(route);
    }

    api.logger?.info?.(`[agenda-clo] per-user task+project tools + Mini App at ${BASE_PATH}/app`);
  },
});
