# Agendow

An OpenClaw plugin for **per-user project workspaces** — each project holds a
short **status**, typed **params** (key/value), and **sections** (named text
blocks — the project's topics). Managed both by the agent (from chat) and by you
(a **Telegram Mini App**).

Each owner (Telegram id) has their own projects; nobody sees anyone else's.
Projects can also be **shared** — visible to all owners. Only owners
(`ownerIds`) get the tool and the Mini App.

Built on the full plugin SDK (`definePluginEntry`, requires `openclaw >= 2026.5.17`).

## What a project holds

- `name`
- `status` — a short free-text line (e.g. `Active`, `Paused — waiting for hardware`).
- `params` — typed key/value parameters (e.g. `chain: Canton`, `market: 42`).
- `sections` — named text blocks / topics, each `{ title, body }` (markdown).

## Two surfaces, one store

- **Agent tool** (`project`) — the bot manages your projects from chat. The
  requester is identified via `ctx.requesterSenderId` (real Telegram messages),
  so the tool is only offered to owners.
- **Telegram Mini App** — a board served under `/plugins/agendow/*`: pick a
  project, edit its status, params, and sections. Authenticated with `initData`.

Each user has their own projects (+ shared) and their own current project.

## Tool

`project` actions:

- `list` — visible projects with status. `get` / `current` — one project in full.
- `create` — `name` (+ `status`, `shared`). `update` — `name` and/or `status`.
- `set_param` — `key` + `value` (empty value removes).
- `add_section` — `title` (+ `body`). `update_section` — `section` + `title`/`body`.
  `remove_section` — `section`.
- `archive` / `unarchive` / `switch`.

## Config

Under `plugins.entries.agendow.config`:

| Key         | Default                            | Meaning                                                        |
| ----------- | ---------------------------------- | -------------------------------------------------------------- |
| `storePath` | `<stateDir>/agendow/tasks.json` | Where the store lives.                                         |
| `ownerIds`  | — (any valid Telegram bot user)    | Telegram user ids that get their own workspace (and the Mini App). **Set this.** |

## Develop

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest: store (isolation, shared, params, sections, migration), project tool, initData auth, mini-app API
```

## Deploy (self-hosted gateway)

1. `npm run build` → `dist/`.
2. Copy the plugin dir to `~/.openclaw/extensions/agendow` with `dist/`,
   `openclaw.plugin.json`, `package.json`, and `node_modules/typebox` (the only
   runtime dep; `openclaw` is a host-provided peer).
3. **`chown` to the gateway user** (plugins run in-process; foreign-owned files are blocked).
4. Enable:
   ```json5
   plugins: {
     load: { paths: ["/root/.openclaw/extensions/agendow"] },
     entries: { "agendow": { enabled: true, config: { ownerIds: [<owner-tg-id>, ...] } } },
   }
   ```
5. `openclaw gateway restart`.

The store auto-migrates older files (`v1`–`v4`) on first read: projects keep
their name/status, gain empty `params`/`sections`, old `info` becomes a `Notes`
section, tasks are dropped, and old global projects become `shared`.

## Expose the Mini App + launch button

Telegram Mini Apps need public HTTPS, but the gateway is loopback-only. Front it
with a tunnel/proxy exposing **only** `/plugins/agendow/*` (keep the Control
UI private) — e.g. a Cloudflare Tunnel with a path-restricted ingress:

```yaml
# /etc/cloudflared/config.yml
ingress:
  - hostname: agenda.example.com
    path: ^/plugins/agendow(/.*)?$
    service: http://localhost:18789
  - service: http_status:404
```

Then set a **per-chat** Web App menu button for each owner (per-chat avoids
clashing with OpenClaw's default commands menu):

```
POST https://api.telegram.org/bot<token>/setChatMenuButton
{ "chat_id": <owner-id>, "menu_button": { "type": "web_app", "text": "Projects",
    "web_app": { "url": "https://agenda.example.com/plugins/agendow/app" } } }
```

## Layout

- `src/store.ts` — per-user project store (name/status/params/sections + shared, atomic write, migration).
- `src/project-tool.ts` — the `project` agent tool (scoped to the requesting user).
- `src/tool-helpers.ts` — shared tool result/schema helpers.
- `src/board.ts` — Mini App page + `/projects` JSON API (scoped by the initData user).
- `src/telegram-auth.ts` — Telegram `initData` HMAC validation.
- `src/index.ts` — `definePluginEntry`: registers the tool + HTTP routes.
- `openclaw.plugin.json` — manifest (`contracts.tools: ["project"]`).

## Security notes

- Each user only sees their own projects (+ shared); the store enforces
  visibility on every resolution, so one user can't read or mutate another's.
- The Mini App API requires valid Telegram `initData`; the chat tool requires an
  identifiable owner (`requesterSenderId`). Non-owners get neither.
- Serve `/plugins/agendow/*` (routed to plugins), not `/agenda` (falls through
  to the Control UI). Expose only that path publicly.

## Roadmap

Toward a configurable, extensible workspace (hybrid: declarative config + code):

- **Config-defined project types** (local config) declaring params + views.
- **View kinds**, incl. an `api` view: a declarative HTTP request (param
  interpolation) rendered to text via a template. Plus a `render` that assembles
  a project's views into text.
- **Code interface** (`ProjectViewKind`) to register custom view kinds for
  advanced integrations (auth, non-trivial logic).
