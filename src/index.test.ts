import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("agenda-clo", () => {
  it("declares the task tool in its static metadata", () => {
    const names = getToolPluginMetadata(entry)?.tools.map((t) => t.name);
    expect(names).toEqual(["task"]);
  });
});
