import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTypes, loadConfig } from "./config.js";
import { interpolate, renderProject, renderTemplate } from "./views.js";

const proj = {
  id: "p", ownerId: "1", name: "Cancore", status: "Active", typeId: "t",
  params: { market: "42", chain: "Canton" },
  sections: [{ id: "s1", title: "Goal", body: "swap" }],
  createdAt: "", updatedAt: "",
} as any;

describe("interpolate / renderTemplate", () => {
  it("interpolates params and url-encodes when asked", () => {
    expect(interpolate("id={market}", { market: "42" })).toBe("id=42");
    expect(interpolate("q={x}", { x: "a b" }, true)).toBe("q=a%20b");
  });
  it("renders dotted response paths", () => {
    expect(renderTemplate("{data.price}$", { data: { price: 5 } })).toBe("5$");
    expect(renderTemplate("{missing}", {})).toBe("");
  });
});

describe("renderProject", () => {
  it("uses default views (params + sections) without a type", async () => {
    const text = await renderProject(proj, undefined, async () => ({}));
    expect(text).toContain("# Cancore — Active");
    expect(text).toContain("- market: 42");
    expect(text).toContain("Goal");
  });

  it("runs an api view: param interpolation + response template", async () => {
    let seen: any;
    const fetchJson = async (req: any) => { seen = req; return { price: 7 }; };
    const type = { views: [{ kind: "api", title: "Market", request: { url: "https://api.x/{market}" }, render: "{price}$" }] };
    const text = await renderProject(proj, type, fetchJson);
    expect(seen.url).toBe("https://api.x/42");
    expect(text).toContain("### Market");
    expect(text).toContain("7$");
  });

  it("reports unknown kinds and api errors instead of throwing", async () => {
    const type = { views: [{ kind: "nope", title: "X" }, { kind: "api", title: "Y", request: { url: "https://x/" } }] };
    const text = await renderProject(proj, type, async () => { throw new Error("boom"); });
    expect(text).toContain("unknown view kind: nope");
    expect(text).toContain("error: boom");
  });
});

describe("loadConfig", () => {
  it("reads projectTypes from a file", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agendow-cfg-")), "config.json");
    fs.writeFileSync(f, JSON.stringify({ projectTypes: { bot: { label: "Bot", views: [{ kind: "params" }] } } }));
    expect(listTypes(loadConfig(f))).toEqual([{ id: "bot", label: "Bot" }]);
  });
  it("returns empty on a missing/bad file", () => {
    expect(loadConfig("/nonexistent/x.json").projectTypes).toEqual({});
  });
});
