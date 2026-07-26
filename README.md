# AgendaClo

An OpenClaw plugin that gives every **project** its own to-do list.

In OpenClaw a project *is* an agent — each agent already owns its own workspace,
sessions, crons, memory and model. AgendaClo adds the one missing primitive:
per-project **tasks**. Tasks are automatically scoped to the current agent, so a
task created while working in project A is invisible to project B.

## Status

Phase 1 (this repo): the `task` tool + a persisted, project-scoped store.
Next: a self-served project board via `api.registerHttpRoute` (the "alternative
interface besides chat"), and a scheduled summary cron. See the roadmap below.

## The `task` tool

The agent gets one tool, `task`, with an `action`:

| action  | requires        | does                                              |
| ------- | --------------- | ------------------------------------------------- |
| `add`   | `title`         | create a task (optional `notes`)                  |
| `list`  | —               | list this project's tasks (optional `status`) + summary counts |
| `update`| `id`            | change `title` / `notes` / `status`               |
| `done`  | `id`            | mark done                                          |
| `remove`| `id`            | delete                                             |

`status` is one of `todo | doing | done`. Every call is scoped to the current
project; cross-project reads/writes are refused by the store.

## Install (dev)

Point OpenClaw at this repo and restart the gateway:

```json5
// openclaw config
{
  plugins: {
    load: { paths: ["/Users/mike/projects/ai/AgendaClo"] },
    entries: { "agenda-clo": { enabled: true } },
  },
}
```

Or link it into the extensions dir:

```bash
openclaw plugins install -l /Users/mike/projects/ai/AgendaClo
```

The plugin imports one npm dep (`@sinclair/typebox`), so install it in this
directory once (`pnpm install`) — OpenClaw loads the `.ts` directly via jiti.

## Config

Under `plugins.entries.agenda-clo.config`:

- `storePath` (optional) — where `tasks.json` lives. Defaults to the plugin
  state dir, falling back to `~/.openclaw/agenda-clo/tasks.json`.

## Develop

The store holds all the real logic and has zero dependencies, so its self-check
runs with plain Node (v22.18+/v24 run TypeScript natively). The tool layer is
smoke-tested through **jiti** — the same loader the gateway uses — so `.js`
import specifiers resolve exactly as they will in production:

```bash
node store.ts        # store self-check     -> "... store self-check: OK"
pnpm smoke           # tool via jiti loader -> "... tool smoke (via jiti): OK"
pnpm test            # runs both
pnpm typecheck       # optional, needs @types/node
```

## Layout

- `store.ts` — pure, dependency-free task store (persistence, project scoping, status). Self-checks on `node store.ts`.
- `task-tool.ts` — the `task` agent tool (TypeBox schema + dispatch).
- `index.ts` — plugin entry: builds the store, registers the tool scoped to `ctx.agentId`.
- `openclaw-types.ts` — minimal local subset of `openclaw/plugin-sdk` (no build coupling).
- `openclaw.plugin.json` — manifest (id + config schema).

## Roadmap

- **Board UI** — serve a project board (HTML/JSON) via `api.registerHttpRoute`; no core UI fork.
- **Status / summary** — a read-model over tasks + crons, and an on-demand or scheduled summary.
- **RPC** — `task.*` gateway methods for the Control UI / other operators (note: plugin RPC requires an `operator.admin`-scoped client).
