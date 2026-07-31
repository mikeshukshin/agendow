# AgendaClo

An OpenClaw plugin for **per-user projects and their to-do lists** — managed
both by the agent (from chat) and by you (a **Telegram Mini App** board).

Each owner (identified by Telegram id) has their own projects and tasks; nobody
sees anyone else's. Projects can also be **shared** — visible to all owners, for
team work. Only owners (`ownerIds`) get the tools and the Mini App.

A *project* is a lightweight named group of tasks. Each user has their own
current project; tasks default to it. Projects are managed inside AgendaClo (no
OpenClaw agent/config per project), so you can create/switch/rename/archive them
freely.

Built on the full plugin SDK (`definePluginEntry`, requires `openclaw >= 2026.5.17`).

## Two surfaces, one store

- **Agent tools** (`task`, `project`) — the bot manages your projects/tasks from
  chat. The requester is identified via `ctx.requesterSenderId` (set for real
  Telegram messages), so the tools are only offered to owners.
- **Telegram Mini App** — a board served under `/plugins/agenda-clo/*` with a
  project switcher and per-project tasks, authenticated with Telegram `initData`
  (the user id comes from there).

Both read/write the same store; each user has their own set of projects (+ the
shared ones) and their own current project.

## Tools

`project` — `list | create | rename | archive | unarchive | switch | current`.
`create` takes `name` and an optional `shared: true` (visible to all owners);
the rest take `project` (name/id).

`task` — `add | list | update | done | remove`, each with an optional `project`
(name/id, defaults to your current project). `status` ∈ `todo | doing | done`.

## Config

Under `plugins.entries.agenda-clo.config`:

| Key         | Default                            | Meaning                                                        |
| ----------- | ---------------------------------- | -------------------------------------------------------------- |
| `storePath` | `<stateDir>/agenda-clo/tasks.json` | Where projects/tasks are stored.                               |
| `ownerIds`  | — (any valid Telegram bot user)    | Telegram user ids that get their own project space (and the Mini App). **Set this** — otherwise anyone who can reach the bot gets a space. |

## Develop

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest: store (per-user isolation, shared, v1/v2 migration), tools, initData auth, mini-app API
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
     entries: { "agenda-clo": { enabled: true, config: { ownerIds: [<owner-tg-id>, ...] } } },
   }
   ```
5. `openclaw gateway restart`.

The store auto-migrates older files (`v1` tasks tagged `agentId`, `v2` global
projects) into the `v3` per-user shape on first read; old global projects become
`shared`.

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

- `src/store.ts` — per-user projects (+ shared) + tasks store (pure, atomic write, v1/v2→v3 migration).
- `src/task-tool.ts`, `src/project-tool.ts` — the two agent tools (scoped to the requesting user).
- `src/tool-helpers.ts` — shared tool result/schema helpers.
- `src/board.ts` — Mini App page + `/tasks` and `/projects` JSON APIs (scoped by the initData user).
- `src/telegram-auth.ts` — Telegram `initData` HMAC validation.
- `src/index.ts` — `definePluginEntry`: registers the tools (per-requester factories) + HTTP routes.
- `openclaw.plugin.json` — manifest (`contracts.tools: ["task", "project"]`).

## Security notes

- Each user only sees their own projects/tasks; the store enforces visibility
  (`ownerId === user || "shared"`) on every resolution, so one user can't read or
  mutate another's project.
- The Mini App API requires valid Telegram `initData`; chat tools require an
  identifiable owner (`requesterSenderId`). Non-owners get neither.
- Serve `/plugins/agenda-clo/*` (routed to plugins), not `/agenda` (falls through
  to the Control UI). Expose only that path publicly.

## Roadmap

- Browser (non-Telegram) access via Telegram Login Widget.
- Per-project reminders/crons and summaries.
- Optional per-project model/subscription (bind a project to an OpenClaw agent).
