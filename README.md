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
- `create` — `name` (+ `status`, `type`, `shared`). `update` — `name`, `status` and/or `type`.
- `set_param` — `key` + `value` (empty value removes).
- `add_section` — `title` (+ `body`). `update_section` — `section` + `title`/`body`.
  `remove_section` — `section`.
- `render` — render the project (its type's views, incl. live `api` views) to text.
- `types` — list config-defined project types.
- `archive` / `unarchive` / `switch`.

## Project types & views (configurable)

A **project type** (declared in a local config file) gives a project a set of
**views** — pluggable renderers that turn the project into text. Assign a type
with `create`/`update` (`type`), then `render` (tool) or the Mini App's ▷ Render
button assembles the views into text.

**Building dashboards from chat:** see [docs/dashboards.md](docs/dashboards.md) —
define a dashboard type once in `config.json`, then spin up one project per
subject from chat and `render`.

Config lives next to the store at `<stateDir>/agendow/config.json`
(hand-editable; re-read on each render — no restart). See `config.example.json`:

```json
{
  "projectTypes": {
    "polymarket-bot": {
      "label": "Polymarket Bot",
      "params": [{ "key": "market", "label": "Market id" }],
      "views": [
        { "kind": "text", "title": "Notes", "section": "Notes" },
        { "kind": "params", "title": "Parameters" },
        { "kind": "api", "title": "Market",
          "request": { "url": "https://api.example.com/markets/{market}" },
          "render": "{question} — {outcomePrices}" }
      ]
    }
  }
}
```

Built-in view `kind`s:

- `params` — the project's params as a list.
- `sections` — all sections as text.
- `text` — one section's body (`section`) or static `text`.
- `api` — an HTTP request with `{param}` interpolation into url/headers/body,
  then the JSON response rendered via a `{dotted.path}` template. (http(s) only,
  10s timeout, 256 KB cap.)

### Custom view kinds (code)

For cases the built-in kinds can't express (auth flows, multi-request
orchestration, non-HTTP sources), implement the `ProjectViewKind` interface and
register it — it then becomes usable as a `kind` in config:

```ts
// src/kinds/index.ts (imported for side effects at plugin load)
import { registerViewKind } from "../views.js";

registerViewKind({
  kind: "hello",
  async render({ project, view, fetchJson }) {
    // project.params / project.sections; view.* config; fetchJson() helper.
    return `Hello, ${project.name}!`;
  },
});
```

The `project` tool's `types` action lists the registered `kinds` (built-in +
custom) so config authors know what's available.

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

- `src/store.ts` — per-user project store (name/status/type/params/sections + shared, atomic write, migration).
- `src/project-tool.ts` — the `project` agent tool (scoped to the requesting user).
- `src/config.ts` — load the local `config.json` (project types).
- `src/views.ts` — the `ProjectViewKind` interface, the kind registry (`registerViewKind`), built-in kinds (params/sections/text/api), and `renderProject`.
- `src/kinds/index.ts` — where custom view kinds are registered (empty by default).
- `src/tool-helpers.ts` — shared tool result/schema helpers.
- `src/board.ts` — Mini App page + `/projects` JSON API (scoped by the initData user).
- `src/telegram-auth.ts` — Telegram `initData` HMAC validation.
- `src/index.ts` — `definePluginEntry`: registers the tool + HTTP routes.
- `config.example.json` — sample project-types config.
- `openclaw.plugin.json` — manifest (`contracts.tools: ["project"]`).

## Security notes

- Each user only sees their own projects (+ shared); the store enforces
  visibility on every resolution, so one user can't read or mutate another's.
- The Mini App API requires valid Telegram `initData`; the chat tool requires an
  identifiable owner (`requesterSenderId`). Non-owners get neither.
- Serve `/plugins/agendow/*` (routed to plugins), not `/agenda` (falls through
  to the Control UI). Expose only that path publicly.

## Roadmap

- Browser (non-Telegram) access via Telegram Login Widget.
- Render views inline in the Mini App (not just on demand).
- Load custom kinds from an external directory (today they live in `src/kinds`).
