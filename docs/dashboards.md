# Building project dashboards

Agendow turns each project into a small **dashboard**: a name, a status, typed
params, free-form sections, and — via a config-defined **type** — a set of
**views** that render to text, including **live API views**. You create and
manage these dashboards from chat with the bot; the dashboard *template* (its
views) is defined once in a local config file.

## The two pieces

1. **A dashboard type** (template) — defined once in `config.json`. It declares
   the params a dashboard needs and the views to render (`params`, `sections`,
   `text`, and `api` views that call an HTTP endpoint and format the response).
2. **A project** (instance) — created from chat. Pick a type, fill in the params
   (which repo / market / service), then `render` it to get the dashboard.

One type → many projects. E.g. one `github-repo` type, one project per repo.

## Step 1 — define a dashboard type (once)

Edit `~/.openclaw/agendow/config.json` (sits next to the store; re-read on each
render, no restart). Example — a GitHub repo dashboard:

```json
{
  "projectTypes": {
    "github-repo": {
      "label": "GitHub Repo",
      "params": [{ "key": "repo", "label": "owner/name" }],
      "views": [
        { "kind": "params", "title": "Parameters" },
        { "kind": "text", "title": "Notes", "section": "Notes" },
        {
          "kind": "api",
          "title": "Repo",
          "request": {
            "url": "https://api.github.com/repos/{repo}",
            "headers": { "User-Agent": "agendow" }
          },
          "render": "⭐ {stargazers_count} · issues {open_issues_count}\n{description}"
        }
      ]
    }
  }
}
```

- `{repo}` in the URL/headers/body is filled from the project's `repo` param
  (URL-encoded in the URL).
- `render` templates the JSON response: `{stargazers_count}`, dotted paths like
  `{owner.login}`, etc. Missing paths render empty.
- View kinds: `params`, `sections`, `text`, `api` — plus your own in code (see
  the README, "Custom view kinds"). `api` is http(s) only, 10s timeout, 256 KB cap.

## Step 2 — create & manage dashboards from chat

Message the bot in natural language; the agent drives the `project` tool.

| You say (natural language) | What happens |
| --- | --- |
| "what dashboard types are there?" | lists config types (`types`) |
| "create a project OpenClaw, type github-repo" | new project of that type |
| "set repo = openclaw/openclaw" | sets the `repo` param |
| "render OpenClaw" / "show me OpenClaw" | `render`: live GitHub call → text dashboard |
| "create Grammy, type github-repo, repo grammyjs/grammy" | another repo's dashboard |
| "show my projects" | list with statuses |
| "set status: watching" · "note in Notes: …" | status / section |
| "switch to Grammy" · "archive X" | current project · archive |

Each project is a dashboard for a different subject, all sharing one template.
Add a new *kind* of dashboard by adding another type to `config.json`.

## In the Mini App

The bot's **Projects** button opens the same data: a **Type** dropdown, param
and section editors, and a **▷ Render** button that shows the rendered dashboard.

## A type renders only the views it lists

Assigning a type replaces the default view with exactly the views you declared.
So a type with only a `params` view will **not** show the project's sections —
add a `sections` view (all sections) or a `text` view (one section) if you want
them. A project with **no type** renders `params` + all `sections` by default,
i.e. everything you entered.

## Note / limitation

The dashboard *template* (a type and its API views) lives in `config.json`, not
chat. From chat you create instances of existing types and fill their params.
Defining types conversationally (from chat) would be a follow-up — a tool action
that writes config types.
