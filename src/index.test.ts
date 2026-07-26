import { describe, expect, it } from "vitest";
import entry from "./index.js";

describe("agenda-clo entry", () => {
  it("is a plugin entry with id and register()", () => {
    const e = entry as unknown as { id?: string; register?: unknown };
    expect(e.id).toBe("agenda-clo");
    expect(typeof e.register).toBe("function");
  });
});
