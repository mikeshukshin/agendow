# AgendaClo

An OpenClaw plugin that gives every **project** its own to-do list — usable both
by the agent (a `task` tool) and by you (a **Telegram Mini App** board).

In OpenClaw a project *is* an agent — each agent already owns its own workspace,
sessions, crons, memory and model. AgendaClo adds the missing primitive:
per-project **tasks**, automatically scoped to the current agent. The agent
manages them via a tool; you view/manage the same tasks in a Telegram Mini App.

Built on the full plugin SDK (`definePluginEntry`, requires `openclaw >= 2026.5.17`).

## Two surfaces, one store

- **`task` agent tool** — `add | list | update | done | remove`, scoped to the
  current project (`ctx.agentId`). The bot calls it from natural language.
- **Telegram Mini App** — a web board served by the plugin under
  `/plugins/agenda-clo/*`, authenticated with Telegram `initData`.

Both read/write the same `tasks.json`, so a task added in chat shows up in the
Mini App and vice-versa.

## Config

Under `plugins.entries.agenda-clo.config`:

| Key          | Default                                | Meaning                                                            |
| ------------ | -------------------------------------- | ------------------------------------------------------------------ |
| `storePath`  | `<stateDir>/agenda-clo/tasks.json`     | Where tasks are stored.                                            |
| `webProject` | `main`                                 | Which project (agent id) the Mini App manages.                    |
| `ownerIds`   | — (any valid Telegram user of the bot) | Telegram user ids allowed to use the Mini App. **Set this** if the bot's `allowFrom` includes `*`. |

## Develop

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest: store, task tool, initData auth, mini-app API
```

## Deploy (self-hosted gateway)

1. Build: `npm run build` (produces `dist/`).
2. Copy the plugin dir to the gateway host (e.g. `~/.openclaw/extensions/agenda-clo`)
   with `dist/`, `openclaw.plugin.json`, `package.json`, and
   `node_modules/typebox` (the only runtime dep; `openclaw` is a host-provided peer).
3. **`chown` to the gateway user** (e.g. `root`) — plugins run in-process and
   files not owned by the gateway user are blocked.
4. Enable it:
   ```json5
   plugins: {
     load: { paths: ["/root/.openclaw/extensions/agenda-clo"] },
     entries: { "agenda-clo": { enabled: true, config: { ownerIds: [<your-tg-id>] } } },
   }
   ```
5. `openclaw gateway restart`.

## Expose the Mini App (public HTTPS)

Telegram Mini Apps need a public HTTPS URL, but the gateway is loopback-only.
Front it with a tunnel/proxy that exposes **only** `/plugins/agenda-clo/*`
(keep the Control UI private). Reference setup with a Cloudflare Tunnel:

```yaml
# /etc/cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: agenda.example.com
    path: ^/plugins/agenda-clo(/.*)?$
    service: http://localhost:18789
  - service: http_status:404
```

No inbound ports are opened (cloudflared dials out); Cloudflare terminates TLS.

## Launch button in Telegram

Set a **per-chat** Web App menu button for each owner (per-chat avoids clashing
with OpenClaw's default commands menu):

```
POST https://api.telegram.org/bot<token>/setChatMenuButton
{ "chat_id": <owner-id>,
  "menu_button": { "type": "web_app", "text": "Tasks",
    "web_app": { "url": "https://agenda.example.com/plugins/agenda-clo/app" } } }
```

The owner opens the bot → taps the button → the Mini App opens with `initData`,
which the plugin validates (HMAC over the bot token) and checks against `ownerIds`.

## Layout

- `src/store.ts` — pure, dependency-free task store (persist, project scope, status).
- `src/task-tool.ts` — the `task` agent tool.
- `src/board.ts` — Mini App page (Telegram WebApp SDK) + tasks JSON API.
- `src/telegram-auth.ts` — Telegram `initData` HMAC validation.
- `src/index.ts` — `definePluginEntry`: registers the tool + the HTTP routes.
- `openclaw.plugin.json` — manifest (`contracts.tools: ["task"]`).
- `src/*.test.ts` — vitest.

## Security notes

- The Mini App API requires valid Telegram `initData` (only real users of *this*
  bot can produce it) and, when set, an `ownerIds` allowlist.
- Serving `/plugins/agenda-clo/*` (not `/agenda`) matters: the gateway routes
  `/plugins/*` to plugins, while other GET paths fall through to the Control UI.
- Expose only the plugin path publicly; never the whole gateway.
