import { Type, type TSchema } from "typebox";

// Local structural shape of a core agent tool (what definePluginEntry's
// registerTool accepts) — kept local so these files avoid a deep openclaw import.
export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<AgentToolResult>;
}

export const literalEnum = (values: readonly string[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export function jsonResult(payload: unknown): AgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
