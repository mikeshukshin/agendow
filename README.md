# AgendaClo

An OpenClaw plugin for **per-user project records** — each project is a living
note with a short **status** and free-form **info** (goal, context, next steps,
anything). Managed both by the agent (from chat) and by you (a **Telegram Mini
App**). No task checklists — just projects, their status, and what you've
written down.

Each owner (identified by Telegram id) has their own projects; nobody sees
anyone else's. Projects can also be **shared** — visible to all owners. Only
owners (`ownerIds`) get the tool and the Mini App.

Built on the full plugin SDK (`definePluginEntry`, requires `openclaw >= 2026.5.17`).

## What a project holds

- `name`
- `status` — a short free-text line, e.g. `Active` or `Paused — waiting for hardware`.
- `info` — free-form notes / recorded information (markdown): goal, context,
  next steps, whatever you want to keep.

## Two surfaces, one store

- **Agent tool** (`project`) — the bot lists/creates/updates your project
  records from chat. The requester is identified via `ctx.requesterSenderId`
  (set for real Telegram messages), so the tool is only offered to owners.
- **Telegram Mini App** — a board served under `/plugins/agenda-clo/*`: pick a
  project, edit its status and info. Authenticated with Telegram `initData`.

Each user has their own projects (+ shared ones) and their own current project.

## Tool

`project` — `list | get | create | update | archive | unarchive | switch | current`.

- `create` takes `name` and optional `status`, `info`, `shared: true`.
- `update` takes optional `project` (defaults to current) + any of `name`,
  `status`, `info` (info replaces the whole notes field).
- `get` / `current` return a project in full (status + info).
- `list` returns your visible projects with their status.

## Config

Under `plugins.entries.agenda-clo.config`:

| Key         | Default                            | Meaning                                                        |
| ----------- | ---------------------------------- | -------------------------------------------------------------- |
| `storePath` | `<stateDir>/agenda-clo/tasks.json` | Where the project store lives.                                 |
| `ownerIds`  | — (any valid Telegram bot user)    | Telegram user ids that get their own project space (and the Mini App). **Set this.** |

## Develop

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest: store (per-user isolation, shared, migration), project tool, initData auth, mini-app API
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

Older stores (task-era `v1`–`v3`) migrate to the `v4` record shape on first read:
projects keep their name, gain empty `status`/`info`, tasks are dropped, and old
global projects become `shared`.

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
{ "chat_id": <owner-id>, "menu_button": { "type": "web_app", "text": "Projects",
    "web_app": { "url": "https://agenda.example.com/plugins/agenda-clo/app" } } }
```

## Layout

- `src/store.ts` — per-user project store (name/status/info + shared, atomic write, migration).
- `src/project-tool.ts` — the `project` agent tool (scoped to the requesting user).
- `src/tool-helpers.ts` — shared tool result/schema helpers.
- `src/board.ts` — Mini App page + `/projects` JSON API (scoped by the initData user).
- `src/telegram-auth.ts` — Telegram `initData` HMAC validation.
- `src/index.ts` — `definePluginEntry`: registers the tool (per-requester factory) + HTTP routes.
- `openclaw.plugin.json` — manifest (`contracts.tools: ["project"]`).

## Security notes

- Each user only sees their own projects (+ shared); the store enforces
  visibility on every resolution, so one user can't read or mutate another's.
- The Mini App API requires valid Telegram `initData`; the chat tool requires an
  identifiable owner (`requesterSenderId`). Non-owners get neither.
- Serve `/plugins/agenda-clo/*` (routed to plugins), not `/agenda` (falls through
  to the Control UI). Expose only that path publicly.

## Roadmap

- Browser (non-Telegram) access via Telegram Login Widget.
- Reminders / scheduled status nudges per project.
- Optional per-project model/subscription (bind a project to an OpenClaw agent).
