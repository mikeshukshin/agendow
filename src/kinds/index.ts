// Custom view kinds (Phase 3). Register kinds here and they become usable as a
// `kind` in config.json's project-type views — for cases the built-in
// params/sections/text/api kinds can't express (auth flows, multi-request
// orchestration, non-HTTP sources, rich formatting).
//
// A kind implements ProjectViewKind { kind, render(ctx) } where ctx = { project,
// view, fetchJson }. `project` gives name/status/params/sections; `view` is the
// config entry (view.config-style fields); `fetchJson` is the guarded HTTP
// helper (or call fetch/read env/etc. yourself).
//
// This module is imported for its side effects at plugin load (see index.ts).
//
// Example — a kind that greets using the project name:
//
//   import { registerViewKind } from "../views.js";
//   registerViewKind({
//     kind: "hello",
//     async render({ project }) {
//       return `Hello, ${project.name}!`;
//     },
//   });

export {}; // no custom kinds shipped by default
