import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyInitData } from "./telegram-auth.js";
import type { TaskStatus, TaskStore } from "./store.js";

export interface MiniAppOptions {
  store: TaskStore;
  getBotToken: () => string | undefined;
  ownerIds?: number[]; // Telegram user-id allowlist ([] / undefined = any valid user of the bot)
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

// Authenticate via Telegram initData; on failure sends the error and returns false.
function authOk(req: IncomingMessage, url: URL, res: ServerResponse, opts: MiniAppOptions): boolean {
  const header = req.headers["x-telegram-init-data"];
  const initData =
    (typeof header === "string" ? header : "") || url.searchParams.get("tgInitData") || "";
  const r = verifyInitData(initData, opts.getBotToken() ?? "");
  if (!r.ok) {
    sendJson(res, 401, { error: `unauthorized: ${r.reason}` });
    return false;
  }
  if (opts.ownerIds && opts.ownerIds.length > 0 && !opts.ownerIds.includes(r.user.id)) {
    sendJson(res, 403, { error: "not an allowed user" });
    return false;
  }
  return true;
}

async function handleTasks(req: IncomingMessage, res: ServerResponse, opts: MiniAppOptions): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!authOk(req, url, res, opts)) return true;
  const method = (req.method ?? "GET").toUpperCase();
  const { store } = opts;

  if (method === "GET") {
    const project = str(url.searchParams.get("project")) || undefined;
    const proj = store.getProject(project ?? "");
    return sendJson(res, 200, {
      project: proj ? { id: proj.id, name: proj.name } : project,
      summary: store.summary(project),
      tasks: store.list({ project }),
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
    const project = str(body.project) || undefined;
    try {
      switch (op) {
        case "add": {
          const title = str(body.title);
          if (!title) return sendJson(res, 400, { error: "title required" });
          return sendJson(res, 200, store.add({ project, title, notes: str(body.notes) || undefined }));
        }
        case "update":
          return sendJson(res, 200, store.update({
            project,
            id: str(body.id),
            patch: {
              title: str(body.title) || undefined,
              notes: typeof body.notes === "string" ? str(body.notes) : undefined,
              status: validStatus(body.status),
            },
          }));
        case "done":
          return sendJson(res, 200, store.update({ project, id: str(body.id), patch: { status: "done" } }));
        case "remove":
          return sendJson(res, 200, { removed: store.remove({ project, id: str(body.id) }), id: str(body.id) });
        default:
          return sendJson(res, 400, { error: `unknown op: ${op || "(none)"}` });
      }
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  res.statusCode = 405;
  res.end("Method Not Allowed");
  return true;
}

async function handleProjects(req: IncomingMessage, res: ServerResponse, opts: MiniAppOptions): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!authOk(req, url, res, opts)) return true;
  const method = (req.method ?? "GET").toUpperCase();
  const { store } = opts;

  if (method === "GET") {
    return sendJson(res, 200, store.overview());
  }
  if (method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    const op = str(body.op);
    const target = str(body.project);
    try {
      switch (op) {
        case "create": {
          const name = str(body.name);
          if (!name) return sendJson(res, 400, { error: "name required" });
          return sendJson(res, 200, store.createProject({ name }));
        }
        case "rename": {
          const name = str(body.name);
          if (!target || !name) return sendJson(res, 400, { error: "project and name required" });
          return sendJson(res, 200, store.renameProject({ idOrName: target, name }));
        }
        case "archive":
          if (!target) return sendJson(res, 400, { error: "project required" });
          return sendJson(res, 200, store.archiveProject({ idOrName: target }));
        case "unarchive":
          if (!target) return sendJson(res, 400, { error: "project required" });
          return sendJson(res, 200, store.unarchiveProject({ idOrName: target }));
        case "switch":
          if (!target) return sendJson(res, 400, { error: "project required" });
          return sendJson(res, 200, store.setActiveProject(target));
        default:
          return sendJson(res, 400, { error: `unknown op: ${op || "(none)"}` });
      }
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  res.statusCode = 405;
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
        res.end(renderMiniAppHtml(base));
        return true;
      },
    },
    { path: `${base}/tasks`, auth: "plugin", handler: (req, res) => handleTasks(req, res, opts) },
    { path: `${base}/projects`, auth: "plugin", handler: (req, res) => handleProjects(req, res, opts) },
  ];
}

// Self-contained Telegram Mini App: project switcher + per-project tasks.
export function renderMiniAppHtml(base: string): string {
  const cfg = JSON.stringify({ tasksPath: `${base}/tasks`, projectsPath: `${base}/projects` });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>AgendaClo</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark;
    --bg: var(--tg-theme-bg-color,#0f1115); --card: var(--tg-theme-secondary-bg-color,#181b22);
    --fg: var(--tg-theme-text-color,#e6e8ee); --muted: var(--tg-theme-hint-color,#8b93a7);
    --accent: var(--tg-theme-button-color,#4c8bf5); --accent-fg: var(--tg-theme-button-text-color,#fff);
    --line: rgba(128,138,160,.25); --todo:#6b7280; --doing:#d29922; --done:#2ea043; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; }
  header { padding:12px 14px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
  .bar { display:flex; gap:8px; align-items:center; }
  select#proj { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 10px; font:inherit; }
  header button { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 12px; font:inherit; cursor:pointer; }
  .counts { color:var(--muted); font-size:12px; margin-top:8px; }
  main { padding:12px 14px 92px; }
  ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  li { display:flex; gap:10px; align-items:flex-start; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--card); }
  li .dot { width:9px; height:9px; border-radius:50%; margin-top:6px; flex:0 0 auto; }
  .s-todo .dot{background:var(--todo)} .s-doing .dot{background:var(--doing)} .s-done .dot{background:var(--done)}
  li .body { flex:1; min-width:0; } li .title { word-break:break-word; }
  .s-done .title { text-decoration:line-through; color:var(--muted); }
  li .notes { color:var(--muted); font-size:13px; margin-top:2px; }
  li button { background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:4px 10px; font:inherit; cursor:pointer; }
  .addbar { position:fixed; left:0; right:0; bottom:0; display:flex; gap:8px; padding:12px 14px; background:var(--bg); border-top:1px solid var(--line); }
  .addbar input { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; }
  .addbar button { background:var(--accent); color:var(--accent-fg); border:0; border-radius:10px; padding:0 18px; font:inherit; font-weight:600; cursor:pointer; }
  .editor { display:none; gap:8px; margin-top:8px; }
  .editor.on { display:flex; }
  .editor input { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 10px; font:inherit; }
  .editor button { background:var(--accent); color:var(--accent-fg); border:0; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }
  .err { color:#f85149; padding:10px 14px; font-size:13px; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <select id="proj"></select>
    <button id="new" title="New project">＋</button>
    <button id="edit" title="Rename / archive">⋯</button>
  </div>
  <div class="editor" id="editor"><input id="editorInput" /><button id="editorSave">Save</button><button id="editorCancel">✕</button></div>
  <div class="counts" id="counts"></div>
</header>
<div id="err" class="err" hidden></div>
<main id="list"><div class="empty">Loading…</div></main>
<div class="addbar"><input id="new-task" placeholder="New task…" enterkeyhint="done" /><button id="add">Add</button></div>
<script>
const CFG = ${cfg};
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const INIT = (tg && tg.initData) || "";
let CUR = null; // current project id
const esc = (s) => String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(pathKey, method, body) {
  const res = await fetch(CFG[pathKey], {
    method,
    headers: Object.assign({ "X-Telegram-Init-Data": INIT }, body ? { "Content-Type":"application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
function showErr(m){ const e=document.getElementById("err"); if(!m){e.hidden=true;return;} e.textContent=m; e.hidden=false; }
function confirmAsync(msg){ return new Promise((r)=>{ if(tg&&tg.showConfirm) tg.showConfirm(msg,r); else r(window.confirm(msg)); }); }

function taskRow(t){
  const act = t.status==="done"
    ? '<button data-op="update" data-status="todo">undo</button>'
    : '<button data-op="done">done</button>';
  return '<li class="s-'+t.status+'" data-id="'+esc(t.id)+'"><span class="dot"></span>'+
    '<div class="body"><div class="title">'+esc(t.title)+'</div>'+
    (t.notes?'<div class="notes">'+esc(t.notes)+'</div>':'')+'</div>'+act+
    '<button data-op="remove">✕</button></li>';
}

async function loadProjects(){
  const ov = await api("projectsPath","GET");
  CUR = ov.activeProjectId;
  const sel = document.getElementById("proj");
  sel.innerHTML = ov.projects.map(p =>
    '<option value="'+esc(p.id)+'"'+(p.id===CUR?" selected":"")+'>'+esc(p.name)+' ('+p.summary.total+')</option>'
  ).join("");
}
async function loadTasks(){
  const d = await api("tasksPath","GET");
  const s = d.summary;
  document.getElementById("counts").textContent = s.todo+" todo · "+s.doing+" doing · "+s.done+" done";
  const list = document.getElementById("list");
  list.innerHTML = d.tasks.length ? '<ul>'+d.tasks.map(taskRow).join("")+'</ul>' : '<div class="empty">No tasks yet</div>';
}
async function refresh(){ try{ showErr(""); await loadProjects(); await loadTasks(); }catch(e){ showErr(e.message); } }

// project selector -> switch active project
document.getElementById("proj").addEventListener("change", async (e)=>{
  try{ await api("projectsPath","POST",{op:"switch",project:e.target.value}); await refresh(); }catch(err){ showErr(err.message); }
});

// inline name editor, reused for create + rename
let editorMode = null;
function openEditor(mode, value){
  editorMode = mode;
  const ed = document.getElementById("editor"); const inp = document.getElementById("editorInput");
  inp.value = value || ""; inp.placeholder = mode==="create" ? "New project name…" : "Rename project…";
  ed.classList.add("on"); inp.focus();
}
function closeEditor(){ editorMode=null; document.getElementById("editor").classList.remove("on"); }
document.getElementById("new").addEventListener("click", ()=>openEditor("create",""));
document.getElementById("edit").addEventListener("click", ()=>{
  const sel=document.getElementById("proj"); const name=sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text.replace(/ \\(\\d+\\)$/,"") : "";
  openEditor("rename", name);
});
document.getElementById("editorCancel").addEventListener("click", closeEditor);
document.getElementById("editorSave").addEventListener("click", saveEditor);
document.getElementById("editorInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter") saveEditor(); if(e.key==="Escape") closeEditor(); });
async function saveEditor(){
  const name = document.getElementById("editorInput").value.trim(); if(!name) return;
  try{
    if(editorMode==="create"){ const p=await api("projectsPath","POST",{op:"create",name}); await api("projectsPath","POST",{op:"switch",project:p.id}); }
    else { await api("projectsPath","POST",{op:"rename",project:CUR,name}); }
    closeEditor(); await refresh();
  }catch(e){ showErr(e.message); }
}

// long-press / second tap on ⋯ archives — keep it explicit via a confirm on edit's context:
document.getElementById("edit").addEventListener("dblclick", async ()=>{
  if(await confirmAsync("Archive this project? Tasks are kept but hidden.")){
    try{ await api("projectsPath","POST",{op:"archive",project:CUR}); await refresh(); }catch(e){ showErr(e.message); }
  }
});

async function addTask(){
  const inp=document.getElementById("new-task"); const title=inp.value.trim(); if(!title) return;
  try{ await api("tasksPath","POST",{op:"add",title}); inp.value=""; await refresh(); }catch(e){ showErr(e.message); }
}
document.getElementById("add").addEventListener("click", addTask);
document.getElementById("new-task").addEventListener("keydown",(e)=>{ if(e.key==="Enter") addTask(); });
document.addEventListener("click", async (ev)=>{
  const b=ev.target.closest("li button[data-op]"); if(!b) return;
  const li=b.closest("li"); const id=li.dataset.id, op=b.dataset.op;
  try{
    if(op==="done") await api("tasksPath","POST",{op:"done",id});
    else if(op==="update") await api("tasksPath","POST",{op:"update",id,status:b.dataset.status});
    else if(op==="remove") await api("tasksPath","POST",{op:"remove",id});
    await refresh();
  }catch(e){ showErr(e.message); }
});

function showNoTelegram(){
  const plat = tg ? (tg.platform+" "+tg.version) : "no Telegram SDK";
  const bar=document.querySelector(".addbar"); if(bar) bar.style.display="none";
  document.querySelector("header").style.display="none";
  document.getElementById("list").innerHTML =
    '<div class="empty">Open this from the <b>Tasks</b> button in @clawmerqbot.<br>'+
    'A Mini App only receives your Telegram identity when launched from inside Telegram.'+
    '<br><br><small>Telegram: '+esc(plat)+' · initData: empty</small></div>';
}
if (INIT) refresh(); else showNoTelegram();
</script>
</body>
</html>`;
}
