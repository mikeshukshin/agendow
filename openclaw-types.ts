// Minimal structural subset of `openclaw/plugin-sdk` — kept local so this plugin
// has zero build-time coupling to openclaw internals. jiti erases these types at
// runtime. Source of truth: openclaw/src/plugins/types.ts + agents/tools/common.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TSchema } from "@sinclair/typebox";

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export interface AgentTool {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<AgentToolResult> | AgentToolResult;
}

// Passed to a tool factory on each run — `agentId` is our "project" scope.
export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  agentDir?: string;
}

export interface PluginLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface PluginRuntime {
  state?: { resolveStateDir?: (name?: string) => string };
}

export interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  registerTool: (
    tool: AgentTool | ((ctx: ToolContext) => AgentTool | null | undefined),
    opts?: { optional?: boolean; name?: string; names?: string[] },
  ) => void;
  registerHttpRoute: (params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  }) => void;
}
