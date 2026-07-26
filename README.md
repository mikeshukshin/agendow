# AgendaClo

An OpenClaw plugin that gives every **project** its own to-do list.

In OpenClaw a project *is* an agent — each agent already owns its own workspace,
sessions, crons, memory and model. AgendaClo adds the one missing primitive:
per-project **tasks**. Tasks are automatically scoped to the current agent, so a
task created while working in project A is invisible to project B.

Built as a **tool plugin** on the modern OpenClaw SDK (`defineToolPlugin`), so
`openclaw plugins build` writes the tool metadata into the manifest and the
agent sees the `task` tool without OpenClaw loading plugin code first.

Requires `openclaw >= 2026.5.17`.

## The `task` tool

The agent gets one tool, `task`, with an `action`:

| action   | requires | does                                                             |
| -------- | -------- | ---------------------------------------------------------------- |
| `add`    | `title`  | create a task (optional `notes`)                                 |
| `list`   | —        | list this project's tasks (optional `status`) + summary counts   |
| `update` | `id`     | change `title` / `notes` / `status`                              |
| `done`   | `id`     | mark done                                                        |
| `remove` | `id`     | delete                                                           |

`status` is one of `todo | doing | done`. Every call is scoped to the current
project (`ctx.agentId`); cross-project reads/writes are refused by the store.

## Develop

```bash
npm install
npm run plugin:build      # tsc -> dist/, then `openclaw plugins build` writes the manifest
npm run plugin:validate   # `openclaw plugins validate`
npm test                  # vitest: store + tool + metadata
```

`npm run plugin:build` regenerates `openclaw.plugin.json` — rerun it after
changing the plugin id, name, description, config schema, or tool names.

## Install (dev)

Point OpenClaw at this repo (after `npm run plugin:build`) and restart the
gateway:

```json5
// openclaw config
{
  plugins: {
    load: { paths: ["/path/to/AgendaClo"] },
    entries: { "agenda-clo": { enabled: true } },
  },
}
```

Plugins run in-process with the Gateway, which requires plugin files be owned by
the Gateway user (e.g. `root` for a root-run gateway) — `chown` after copying.

## Config

Under `plugins.entries.agenda-clo.config`:

- `storePath` (optional) — where `tasks.json` lives. Defaults to the plugin
  state dir, falling back to `~/.openclaw/agenda-clo/tasks.json`.

## Layout

- `src/store.ts` — pure, dependency-free task store (persistence, project scoping, status). All real logic lives here.
- `src/task-tool.ts` — builds the `task` agent tool (TypeBox schema + dispatch) scoped to one project.
- `src/index.ts` — `defineToolPlugin` entry; a `factory` reads the runtime `toolContext.agentId` and binds the tool to that project.
- `openclaw.plugin.json` — generated manifest (`contracts.tools: ["task"]`).
- `src/*.test.ts` — vitest: store behavior, tool dispatch + project isolation, and the declared tool metadata.

## Roadmap

- **Board / summary** — a per-project view of tasks + status. On this OpenClaw
  version the bundled **Workboard** plugin already provides a Control-UI Kanban
  board (`openclaw plugins enable workboard`); a custom board (if wanted) would
  be a separate full-SDK plugin, since a tool plugin can't serve HTTP routes.
- **Model / subscription per project** — configured natively via each agent's
  `model` + `auth.order`; not part of this plugin.
