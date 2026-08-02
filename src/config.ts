// Local declarative config: project types with declared params and views.
// Lives next to the store (e.g. ~/.openclaw/agendow/config.json), hand-editable.
// Read fresh on each use so edits apply without a restart.
// ponytail: small file, personal scale — re-read per render; cache if it grows.

import fs from "node:fs";

export interface ViewConfig {
  kind: string; // "params" | "sections" | "text" | "api" | <custom>
  title?: string;
  // text kind
  section?: string; // render this section's body
  text?: string; // or static text
  // api kind
  request?: { url: string; method?: string; headers?: Record<string, string>; body?: string };
  render?: string; // template over the JSON response ("{data.price}$")
}

export interface ProjectType {
  label?: string;
  params?: Array<{ key: string; label?: string }>;
  views?: ViewConfig[];
}

export interface AgendowConfig {
  projectTypes: Record<string, ProjectType>;
}

const EMPTY: AgendowConfig = { projectTypes: {} };

export function loadConfig(configPath: string): AgendowConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const pt = (raw as { projectTypes?: unknown }).projectTypes;
      if (pt && typeof pt === "object" && !Array.isArray(pt)) {
        return { projectTypes: pt as Record<string, ProjectType> };
      }
    }
  } catch {
    // missing/malformed -> no types
  }
  return EMPTY;
}

// Types offered to the Mini App / agent (id + label).
export function listTypes(cfg: AgendowConfig): Array<{ id: string; label: string }> {
  return Object.entries(cfg.projectTypes).map(([id, t]) => ({ id, label: t.label || id }));
}
