# AgendaClo

An OpenClaw plugin for **projects and their to-do lists** — managed both by the
agent (from chat) and by you (a **Telegram Mini App** board).

A *project* is a lightweight named group of tasks. There's always a current
project; tasks default to it. Projects are managed inside AgendaClo (no OpenClaw
agent/config per project), so you can create/switch/rename/archive them freely.

Built on the full plugin SDK (`definePluginEntry`, requires `openclaw >= 2026.5.17`).

## Two surfaces, one store

- **Agent tools** (`task`, `project`) — the bot manages tasks and projects from
  natural language.
- **Telegram Mini App** — a board served under `/plugins/agenda-clo/*`, with a
  project switcher and per-project tasks, authenticated with Telegram `initData`.

Both read/write the same store, and share one **current project** — switch it in
the Mini App or in chat and both surfaces follow.

## Tools

`project` — `list | create | rename | archive | unarchive | switch | current`
(`name` for create/rename, `project` = name/id for the rest).

`task` — `add | list | update | done | remove`, each takes an optional `project`
(name/id, defaults to the current project). `status` ∈ `todo | doing | done`.

## Config

Under `plugins.entries.agenda-clo.config`:

| Key         | Default                            | Meaning                                                        |
| ----------- | ---------------------------------- | -------------------------------------------------------------- |
| `storePath` | `<stateDir>/agenda-clo/tasks.json` | Where projects/tasks are stored.                               |
| `ownerIds`  | — (any valid Telegram bot user)    | Telegram user ids allowed to use the Mini App. **Set this** if the bot's `allowFrom` includes `*`. |

## Develop

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest: store (+ v1 migration), tools, initData auth, mini-app API
```

## Deploy (self-hosted gateway)

1. `npm run build` → `dist/`.
2. Copy the plugin dir to `~/.openclaw/extensions/agenda-clo` with `dist/`,
   `openclaw.plugin.json`, `package.json`, and `node_modules/typebox` (the only
   runtime dep; `openclaw` is a host-provided peer).
3. **`chown` to the gateway user** (plugins run in-process; foreign-owned files are blocked).
4. Enable:
   ```json5
   plugins: {
     load: { paths: ["/root/.openclaw/extensions/agenda-clo"] },
     entries: { "agenda-clo": { enabled: true, config: { ownerIds: [<your-tg-id>] } } },
   }
   ```
5. `openclaw gateway restart`.

The store auto-migrates an older `v1` file (tasks tagged `agentId`) into the
`v2` projects shape on first read.

## Expose the Mini App + launch button

Telegram Mini Apps need public HTTPS, but the gateway is loopback-only. Front it
with a tunnel/proxy exposing **only** `/plugins/agenda-clo/*` (keep the Control
UI private) — e.g. a Cloudflare Tunnel with a path-restricted ingress:

```yaml
# /etc/cloudflared/config.yml
ingress:
  - hostname: agenda.example.com
    path: ^/plugins/agenda-clo(/.*)?$
    service: http://localhost:18789
  - service: http_status:404
```

Then set a **per-chat** Web App menu button for each owner (per-chat avoids
clashing with OpenClaw's default commands menu):

```
POST https://api.telegram.org/bot<token>/setChatMenuButton
{ "chat_id": <owner-id>, "menu_button": { "type": "web_app", "text": "Tasks",
    "web_app": { "url": "https://agenda.example.com/plugins/agenda-clo/app" } } }
```

## Layout

- `src/store.ts` — projects + tasks store (pure, atomic write, v1→v2 migration).
- `src/task-tool.ts`, `src/project-tool.ts` — the two agent tools.
- `src/tool-helpers.ts` — shared tool result/schema helpers.
- `src/board.ts` — Mini App page + `/tasks` and `/projects` JSON APIs.
- `src/telegram-auth.ts` — Telegram `initData` HMAC validation.
- `src/index.ts` — `definePluginEntry`: registers the tools + HTTP routes.
- `openclaw.plugin.json` — manifest (`contracts.tools: ["task", "project"]`).

## Security notes

- The Mini App API requires valid Telegram `initData` and, when set, an
  `ownerIds` allowlist.
- Serve `/plugins/agenda-clo/*` (routed to plugins), not `/agenda` (falls
  through to the Control UI). Expose only that path publicly.

## Roadmap

- Browser (non-Telegram) access via Telegram Login Widget.
- Per-project reminders/crons and summaries.
- Optional per-project model/subscription (bind a project to an OpenClaw agent).
