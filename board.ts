// Self-served project board (the "alternative interface besides chat").
// Two exact gateway routes — the plugin http router matches pathname exactly,
// so there are no path params; the API multiplexes on method + query + body.
//
// Auth model (trust boundary — plugin http routes have NO gateway auth in front):
//   - no board.token configured -> READ-ONLY board (GET ok, mutations 403)
//   - board.token configured    -> PRIVATE board; every request needs the token
//     via `?token=` or `x-agenda-token`, compared with timingSafeEqual.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskStatus, TaskStore } from "./store.js";

export interface BoardRoute {
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

interface BoardOptions {
  store: TaskStore;
  path: string; // e.g. "/agenda"
  token?: string; // optional shared secret
}

function tokenOk(req: IncomingMessage, url: URL, token: string): boolean {
  const headerVal = req.headers["x-agenda-token"];
  const provided =
    (typeof headerVal === "string" ? headerVal : "") || url.searchParams.get("token") || "";
  if (provided.length !== token.length) return false; // avoid throw in timingSafeEqual; length is not the secret
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

// Returns null when authorized, or an {code,msg} to send back.
function authGate(
  req: IncomingMessage,
  url: URL,
  opts: BoardOptions,
  write: boolean,
): { code: number; msg: string } | null {
  if (!opts.token) {
    return write
      ? { code: 403, msg: "board is read-only; set plugins.entries.agenda-clo.config.board.token to enable editing" }
      : null;
  }
  return tokenOk(req, url, opts.token) ? null : { code: 401, msg: "invalid or missing token" };
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function validStatus(v: unknown): TaskStatus | undefined {
  return v === "todo" || v === "doing" || v === "done" ? v : undefined;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: BoardOptions,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET") {
    const gate = authGate(req, url, opts, false);
    if (gate) return sendJson(res, gate.code, { error: gate.msg });
    const project = str(url.searchParams.get("project"));
    if (project) {
      return sendJson(res, 200, {
        project,
        summary: opts.store.summary(project),
        tasks: opts.store.list({ agentId: project }),
      });
    }
    // all projects, each with its tasks
    const projects = opts.store.projects().map((p) => ({
      agentId: p.agentId,
      summary: p.summary,
      tasks: opts.store.list({ agentId: p.agentId }),
    }));
    return sendJson(res, 200, { projects });
  }

  if (method === "POST") {
    const gate = authGate(req, url, opts, true);
    if (gate) return sendJson(res, gate.code, { error: gate.msg });
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    const op = str(body.op);
    const project = str(body.project);
    if (!project) return sendJson(res, 400, { error: "project required" });
    try {
      switch (op) {
        case "add": {
          const title = str(body.title);
          if (!title) return sendJson(res, 400, { error: "title required" });
          return sendJson(res, 200, opts.store.add({ agentId: project, title, notes: str(body.notes) || undefined }));
        }
        case "update": {
          const id = str(body.id);
          if (!id) return sendJson(res, 400, { error: "id required" });
          return sendJson(res, 200, opts.store.update({
            agentId: project,
            id,
            patch: {
              title: str(body.title) || undefined,
              notes: typeof body.notes === "string" ? str(body.notes) : undefined,
              status: validStatus(body.status),
            },
          }));
        }
        case "done": {
          const id = str(body.id);
          if (!id) return sendJson(res, 400, { error: "id required" });
          return sendJson(res, 200, opts.store.update({ agentId: project, id, patch: { status: "done" } }));
        }
        case "remove": {
          const id = str(body.id);
          if (!id) return sendJson(res, 400, { error: "id required" });
          return sendJson(res, 200, { removed: opts.store.remove({ agentId: project, id }), id });
        }
        default:
          return sendJson(res, 400, { error: `unknown op: ${op || "(none)"} — use add|update|done|remove` });
      }
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  res.statusCode = 405;
  res.setHeader("Allow", "GET, POST");
  res.end("Method Not Allowed");
}

function handlePage(res: ServerResponse, opts: BoardOptions): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(renderBoardHtml(opts.path, !opts.token));
}

export function createBoardRoutes(opts: BoardOptions): BoardRoute[] {
  const base = opts.path;
  const apiPath = `${base.replace(/\/$/, "")}/tasks`;
  return [
    {
      path: base,
      handler: (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        // If a token is required, gate the page too so titles aren't public.
        const gate = authGate(req, url, opts, false);
        if (gate) {
          res.statusCode = gate.code;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          return res.end(gate.msg);
        }
        handlePage(res, opts);
      },
    },
    {
      path: apiPath,
      handler: (req, res) => handleApi(req, res, new URL(req.url ?? "/", "http://localhost"), opts),
    },
  ];
}

// --- HTML (self-contained: inline CSS + vanilla JS, no build step) ----------
export function renderBoardHtml(basePath: string, readOnly: boolean): string {
  const apiPath = `${basePath.replace(/\/$/, "")}/tasks`;
  // Values are injected as JSON so a stray quote can't break the script.
  const cfg = JSON.stringify({ apiPath, readOnly });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgendaClo</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0f1115; --card: #181b22; --line: #262b36; --fg: #e6e8ee; --muted: #8b93a7;
    --todo: #6b7280; --doing: #d29922; --done: #2ea043; --accent: #4c8bf5;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --card:#fff; --line:#e3e6ec; --fg:#1a1d24; --muted:#6b7280; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.2px; }
  header .ro { font-size:11px; color:var(--muted); border:1px solid var(--line); padding:2px 8px; border-radius:999px; }
  main { padding:20px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); }
  .proj { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .proj > h2 { margin:0; padding:12px 14px; font-size:13px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
  .counts { color:var(--muted); font-weight:400; font-size:12px; }
  ul { list-style:none; margin:0; padding:8px; display:flex; flex-direction:column; gap:6px; }
  li { display:flex; gap:8px; align-items:flex-start; padding:8px; border:1px solid var(--line); border-radius:8px; background:transparent; }
  li .dot { width:8px; height:8px; border-radius:50%; margin-top:6px; flex:0 0 auto; }
  .s-todo .dot{background:var(--todo)} .s-doing .dot{background:var(--doing)} .s-done .dot{background:var(--done)}
  li .body { flex:1; min-width:0; }
  li .title { word-break:break-word; }
  .s-done .title { text-decoration:line-through; color:var(--muted); }
  li .notes { color:var(--muted); font-size:12px; margin-top:2px; word-break:break-word; }
  li .acts { display:flex; gap:4px; flex:0 0 auto; }
  button { font:inherit; color:var(--fg); background:var(--card); border:1px solid var(--line); border-radius:6px; padding:3px 8px; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  .add { display:flex; gap:6px; padding:8px; border-top:1px solid var(--line); }
  .add input { flex:1; min-width:0; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  .empty { color:var(--muted); padding:24px; text-align:center; }
  .err { color:#f85149; padding:12px 20px; }
</style>
</head>
<body>
<header>
  <h1>AgendaClo</h1>
  <span id="ro" class="ro" hidden>read-only</span>
  <span style="flex:1"></span>
  <button id="reload">Reload</button>
</header>
<div id="err" class="err" hidden></div>
<main id="board"><div class="empty">Loading…</div></main>
<script>
const CFG = ${cfg};
const TOKEN = new URLSearchParams(location.search).get("token");
const qs = TOKEN ? ("?token=" + encodeURIComponent(TOKEN)) : "";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(method, body) {
  const res = await fetch(CFG.apiPath + qs, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function showErr(msg) {
  const el = document.getElementById("err");
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg; el.hidden = false;
}

function taskLi(project, t) {
  const acts = CFG.readOnly ? "" :
    (t.status === "done"
      ? '<button data-op="reopen">reopen</button>'
      : '<button data-op="done">done</button>') +
    '<button data-op="remove">×</button>';
  return '<li class="s-' + t.status + '" data-id="' + esc(t.id) + '" data-project="' + esc(project) + '">' +
    '<span class="dot"></span><div class="body"><div class="title">' + esc(t.title) + '</div>' +
    (t.notes ? '<div class="notes">' + esc(t.notes) + '</div>' : '') +
    '</div><div class="acts">' + acts + '</div></li>';
}

function projCard(p) {
  const s = p.summary;
  const addRow = CFG.readOnly ? "" :
    '<div class="add"><input placeholder="New task…" data-project="' + esc(p.agentId) + '" />' +
    '<button data-op="add" data-project="' + esc(p.agentId) + '">Add</button></div>';
  const items = p.tasks.length
    ? '<ul>' + p.tasks.map((t) => taskLi(p.agentId, t)).join("") + '</ul>'
    : '<div class="empty">No tasks</div>';
  return '<section class="proj"><h2><span>' + esc(p.agentId) + '</span>' +
    '<span class="counts">' + s.todo + ' todo · ' + s.doing + ' doing · ' + s.done + ' done</span></h2>' +
    items + addRow + '</section>';
}

async function load() {
  try {
    showErr("");
    const data = await api("GET");
    document.getElementById("ro").hidden = !CFG.readOnly;
    const board = document.getElementById("board");
    if (!data.projects || data.projects.length === 0) {
      board.innerHTML = '<div class="empty">No projects with tasks yet.</div>';
      return;
    }
    board.innerHTML = data.projects.map(projCard).join("");
  } catch (e) { showErr(e.message); }
}

document.getElementById("reload").addEventListener("click", load);

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-op]");
  if (!btn) return;
  const op = btn.dataset.op;
  try {
    if (op === "add") {
      const input = document.querySelector('input[data-project="' + btn.dataset.project.replace(/"/g,'\\\\"') + '"]');
      const title = input && input.value.trim();
      if (!title) return;
      await api("POST", { op: "add", project: btn.dataset.project, title });
    } else {
      const li = btn.closest("li");
      const project = li.dataset.project, id = li.dataset.id;
      if (op === "done") await api("POST", { op: "done", project, id });
      else if (op === "reopen") await api("POST", { op: "update", project, id, status: "todo" });
      else if (op === "remove") await api("POST", { op: "remove", project, id });
    }
    await load();
  } catch (e) { showErr(e.message); }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.matches('.add input')) {
    const btn = ev.target.parentElement.querySelector('button[data-op="add"]');
    if (btn) btn.click();
  }
});

load();
</script>
</body>
</html>`;
}
