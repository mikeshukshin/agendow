import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyInitData } from "./telegram-auth.js";
import type { TaskStatus, TaskStore } from "./store.js";

export interface MiniAppOptions {
  store: TaskStore;
  getBotToken: () => string | undefined;
  project: string; // which project (agentId) the mini app manages
  ownerIds?: number[]; // optional Telegram user-id allowlist ([] = any valid initData user)
  basePath: string; // e.g. "/plugins/agenda-clo"
}

export interface MiniAppRoute {
  path: string;
  auth: "plugin";
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): true {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
  return true;
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

// Authenticate a request via Telegram initData (header or query), returning the
// project scope on success or sending the error response and returning null.
function authed(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: MiniAppOptions,
): { project: string } | null {
  const header = req.headers["x-telegram-init-data"];
  const initData =
    (typeof header === "string" ? header : "") || url.searchParams.get("tgInitData") || "";
  const result = verifyInitData(initData, opts.getBotToken() ?? "");
  if (!result.ok) {
    sendJson(res, 401, { error: `unauthorized: ${result.reason}` });
    return null;
  }
  if (opts.ownerIds && opts.ownerIds.length > 0 && !opts.ownerIds.includes(result.user.id)) {
    sendJson(res, 403, { error: "not an allowed user" });
    return null;
  }
  return { project: opts.project };
}

async function handleTasksApi(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MiniAppOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  const auth = authed(req, res, url, opts);
  if (!auth) return true;
  const project = auth.project;

  if (method === "GET") {
    return sendJson(res, 200, {
      project,
      summary: opts.store.summary(project),
      tasks: opts.store.list({ agentId: project }),
    });
  }
  if (method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    const op = str(body.op);
    try {
      switch (op) {
        case "add": {
          const title = str(body.title);
          if (!title) return sendJson(res, 400, { error: "title required" });
          return sendJson(res, 200, opts.store.add({ agentId: project, title, notes: str(body.notes) || undefined }));
        }
        case "update":
          return sendJson(res, 200, opts.store.update({
            agentId: project,
            id: str(body.id),
            patch: {
              title: str(body.title) || undefined,
              notes: typeof body.notes === "string" ? str(body.notes) : undefined,
              status: validStatus(body.status),
            },
          }));
        case "done":
          return sendJson(res, 200, opts.store.update({ agentId: project, id: str(body.id), patch: { status: "done" } }));
        case "remove":
          return sendJson(res, 200, { removed: opts.store.remove({ agentId: project, id: str(body.id) }), id: str(body.id) });
        default:
          return sendJson(res, 400, { error: `unknown op: ${op || "(none)"}` });
      }
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  res.statusCode = 405;
  res.setHeader("Allow", "GET, POST");
  res.end("Method Not Allowed");
  return true;
}

export function createMiniAppRoutes(opts: MiniAppOptions): MiniAppRoute[] {
  const base = opts.basePath.replace(/\/$/, "");
  return [
    {
      path: `${base}/app`,
      auth: "plugin",
      handler: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(renderMiniAppHtml(`${base}/tasks`, opts.project));
        return true;
      },
    },
    {
      path: `${base}/tasks`,
      auth: "plugin",
      handler: (req, res) => handleTasksApi(req, res, opts),
    },
  ];
}

// Self-contained Telegram Mini App page (inline CSS/JS, no build). Uses the
// Telegram WebApp SDK for initData + theme; sends initData on every API call.
export function renderMiniAppHtml(apiPath: string, project: string): string {
  const cfg = JSON.stringify({ apiPath, project });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>AgendaClo</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark;
    --bg: var(--tg-theme-bg-color, #0f1115);
    --card: var(--tg-theme-secondary-bg-color, #181b22);
    --fg: var(--tg-theme-text-color, #e6e8ee);
    --muted: var(--tg-theme-hint-color, #8b93a7);
    --accent: var(--tg-theme-button-color, #4c8bf5);
    --accent-fg: var(--tg-theme-button-text-color, #fff);
    --line: rgba(128,138,160,.25);
    --todo:#6b7280; --doing:#d29922; --done:#2ea043; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; }
  header { padding:14px 16px; display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .proj { color:var(--muted); font-size:13px; }
  .counts { margin-left:auto; color:var(--muted); font-size:12px; }
  main { padding:12px 16px 96px; }
  ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  li { display:flex; gap:10px; align-items:flex-start; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--card); }
  li .dot { width:9px; height:9px; border-radius:50%; margin-top:6px; flex:0 0 auto; }
  .s-todo .dot{background:var(--todo)} .s-doing .dot{background:var(--doing)} .s-done .dot{background:var(--done)}
  li .body { flex:1; min-width:0; }
  li .title { word-break:break-word; }
  .s-done .title { text-decoration:line-through; color:var(--muted); }
  li .notes { color:var(--muted); font-size:13px; margin-top:2px; word-break:break-word; }
  li button { font:inherit; color:var(--fg); background:transparent; border:1px solid var(--line); border-radius:8px; padding:4px 10px; cursor:pointer; }
  .addbar { position:fixed; left:0; right:0; bottom:0; display:flex; gap:8px; padding:12px 16px; background:var(--bg); border-top:1px solid var(--line); }
  .addbar input { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; }
  .addbar button { background:var(--accent); color:var(--accent-fg); border:0; border-radius:10px; padding:0 18px; font:inherit; font-weight:600; cursor:pointer; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }
  .err { color:#f85149; padding:10px 16px; font-size:13px; }
</style>
</head>
<body>
<header><h1>AgendaClo</h1><span class="proj" id="proj"></span><span class="counts" id="counts"></span></header>
<div id="err" class="err" hidden></div>
<main id="list"><div class="empty">Loading…</div></main>
<div class="addbar"><input id="new" placeholder="New task…" enterkeyhint="done" /><button id="add">Add</button></div>
<script>
const CFG = ${cfg};
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const INIT = (tg && tg.initData) || "";
document.getElementById("proj").textContent = CFG.project;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(method, body) {
  const res = await fetch(CFG.apiPath, {
    method,
    headers: Object.assign({ "X-Telegram-Init-Data": INIT }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
function showErr(m){ const e=document.getElementById("err"); if(!m){e.hidden=true;return;} e.textContent=m; e.hidden=false; }

function row(t) {
  const act = t.status === "done"
    ? '<button data-op="update" data-status="todo">undo</button>'
    : '<button data-op="done">done</button>';
  return '<li class="s-' + t.status + '" data-id="' + esc(t.id) + '">' +
    '<span class="dot"></span><div class="body"><div class="title">' + esc(t.title) + '</div>' +
    (t.notes ? '<div class="notes">' + esc(t.notes) + '</div>' : '') +
    '</div>' + act + '<button data-op="remove">✕</button></li>';
}

async function load() {
  try {
    showErr("");
    const d = await api("GET");
    const s = d.summary;
    document.getElementById("counts").textContent = s.todo + " todo · " + s.doing + " doing · " + s.done + " done";
    const list = document.getElementById("list");
    list.innerHTML = d.tasks.length ? '<ul>' + d.tasks.map(row).join("") + '</ul>' : '<div class="empty">No tasks yet</div>';
  } catch (e) { showErr(e.message); }
}

async function addTask() {
  const input = document.getElementById("new");
  const title = input.value.trim();
  if (!title) return;
  try { await api("POST", { op: "add", title }); input.value = ""; await load(); }
  catch (e) { showErr(e.message); }
}
document.getElementById("add").addEventListener("click", addTask);
document.getElementById("new").addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(); });
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-op]"); if (!b) return;
  const li = b.closest("li"); if (!li) return;
  const id = li.dataset.id, op = b.dataset.op;
  try {
    if (op === "done") await api("POST", { op: "done", id });
    else if (op === "update") await api("POST", { op: "update", id, status: b.dataset.status });
    else if (op === "remove") await api("POST", { op: "remove", id });
    await load();
  } catch (e) { showErr(e.message); }
});

function showNoTelegram() {
  const plat = tg ? (tg.platform + " " + tg.version) : "no Telegram SDK";
  const unsafeUser = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user)
    ? ("id " + tg.initDataUnsafe.user.id) : "none";
  const bar = document.querySelector(".addbar"); if (bar) bar.style.display = "none";
  document.getElementById("counts").textContent = "";
  document.getElementById("list").innerHTML =
    '<div class="empty">Open this from the <b>Tasks</b> button in @clawmerqbot.<br>' +
    'A Mini App only receives your Telegram identity when launched from inside Telegram.' +
    '<br><br><small>Telegram: ' + esc(plat) + ' · initData: empty · user(unsafe): ' + esc(unsafeUser) + '</small></div>';
}

if (INIT) { load(); } else { showNoTelegram(); }
</script>
</body>
</html>`;
}
