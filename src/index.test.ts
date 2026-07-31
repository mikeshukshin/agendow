import { describe, expect, it } from "vitest";
import entry from "./index.js";

describe("agendow entry", () => {
  it("is a plugin entry with id and register()", () => {
    const e = entry as unknown as { id?: string; register?: unknown };
    expect(e.id).toBe("agendow");
    expect(typeof e.register).toBe("function");
  });
});
