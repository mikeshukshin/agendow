import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyInitData } from "./telegram-auth.js";
import type { TaskStore } from "./store.js";

export interface MiniAppOptions {
  store: TaskStore;
  getBotToken: () => string | undefined;
  ownerIds?: number[]; // Telegram user-id allowlist; [] / undefined = any valid user of the bot
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

// Authenticate via Telegram initData; returns the Telegram user id (string) or
// null after sending the error response.
function auth(req: IncomingMessage, url: URL, res: ServerResponse, opts: MiniAppOptions): string | null {
  const header = req.headers["x-telegram-init-data"];
  const initData =
    (typeof header === "string" ? header : "") || url.searchParams.get("tgInitData") || "";
  const r = verifyInitData(initData, opts.getBotToken() ?? "");
  if (!r.ok) {
    sendJson(res, 401, { error: `unauthorized: ${r.reason}` });
    return null;
  }
  if (opts.ownerIds && opts.ownerIds.length > 0 && !opts.ownerIds.includes(r.user.id)) {
    sendJson(res, 403, { error: "not an allowed user" });
    return null;
  }
  return String(r.user.id);
}

async function handleProjects(req: IncomingMessage, res: ServerResponse, opts: MiniAppOptions): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const userId = auth(req, url, res, opts);
  if (!userId) return true;
  const method = (req.method ?? "GET").toUpperCase();
  const { store } = opts;

  if (method === "GET") return sendJson(res, 200, store.overview(userId));
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
          return sendJson(res, 200, store.createProject({ userId, name, shared: body.shared === true }));
        }
        case "update":
          return sendJson(res, 200, store.updateProject({
            userId,
            idOrName: target,
            patch: {
              name: str(body.name) || undefined,
              status: typeof body.status === "string" ? str(body.status) : undefined,
              info: typeof body.info === "string" ? body.info : undefined,
            },
          }));
        case "archive":
          if (!target) return sendJson(res, 400, { error: "project required" });
          return sendJson(res, 200, store.archiveProject({ userId, idOrName: target }));
        case "unarchive":
          if (!target) return sendJson(res, 400, { error: "project required" });
          return sendJson(res, 200, store.unarchiveProject({ userId, idOrName: target }));
        case "switch":
          if (!target) return sendJson(res, 400, { error: "project required" });
          return sendJson(res, 200, store.setActiveProject(userId, target));
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
    { path: `${base}/projects`, auth: "plugin", handler: (req, res) => handleProjects(req, res, opts) },
  ];
}

// Self-contained Telegram Mini App: project switcher (yours + shared) + a
// status line and free-form info editor for the selected project.
export function renderMiniAppHtml(base: string): string {
  const cfg = JSON.stringify({ projectsPath: `${base}/projects` });
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
    --line: rgba(128,138,160,.25); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; }
  header { padding:12px 14px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
  .bar { display:flex; gap:8px; align-items:center; }
  select#proj { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 10px; font:inherit; }
  header button { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 12px; font:inherit; cursor:pointer; }
  header button.on { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
  .editor { display:none; gap:8px; margin-top:8px; }
  .editor.on { display:flex; }
  .editor input { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 10px; font:inherit; }
  .editor button#editorSave { background:var(--accent); color:var(--accent-fg); border:0; }
  main { padding:14px; display:flex; flex-direction:column; gap:10px; }
  label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  #status { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; }
  #info { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font:inherit; min-height:200px; resize:vertical; }
  #save { align-self:flex-start; background:var(--accent); color:var(--accent-fg); border:0; border-radius:10px; padding:11px 22px; font:inherit; font-weight:600; cursor:pointer; }
  #save:disabled { opacity:.5; }
  .saved { color:var(--muted); font-size:12px; align-self:center; }
  .err { color:#f85149; padding:10px 14px; font-size:13px; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <select id="proj"></select>
    <button id="new" title="New project">＋</button>
    <button id="edit" title="Rename (double-tap: archive)">⋯</button>
  </div>
  <div class="editor" id="editor">
    <input id="editorInput" />
    <button id="sharedToggle" title="Shared project">👥</button>
    <button id="editorSave">Save</button>
    <button id="editorCancel">✕</button>
  </div>
</header>
<div id="err" class="err" hidden></div>
<main id="main">
  <label for="status">Status</label>
  <input id="status" placeholder="e.g. Active · Paused — waiting for hardware" />
  <label for="info">Info</label>
  <textarea id="info" placeholder="Goal, context, next steps, anything… (markdown)"></textarea>
  <div style="display:flex; gap:10px; align-items:center;"><button id="save">Save</button><span id="savedNote" class="saved"></span></div>
</main>
<script>
const CFG = ${cfg};
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const INIT = (tg && tg.initData) || "";
let PROJECTS = [], CUR = null;
const esc = (s) => String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(method, body) {
  const res = await fetch(CFG.projectsPath, {
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

function curProject(){ return PROJECTS.find(p => p.id === CUR); }
function fillDetail(){
  const p = curProject();
  document.getElementById("status").value = p ? (p.status||"") : "";
  document.getElementById("info").value = p ? (p.info||"") : "";
  document.getElementById("savedNote").textContent = "";
}
function renderSelector(){
  document.getElementById("proj").innerHTML = PROJECTS.map(p =>
    '<option value="'+esc(p.id)+'"'+(p.id===CUR?" selected":"")+'>'+(p.shared?"👥 ":"")+esc(p.name)+(p.status?" · "+esc(p.status):"")+'</option>'
  ).join("");
}
async function load(){
  try{ showErr("");
    const ov = await api("GET");
    PROJECTS = ov.projects; CUR = ov.activeProjectId;
    renderSelector(); fillDetail();
  }catch(e){ showErr(e.message); }
}

document.getElementById("proj").addEventListener("change", async (e)=>{
  CUR = e.target.value; fillDetail();
  try{ await api("POST",{op:"switch",project:CUR}); }catch(err){ showErr(err.message); }
});

document.getElementById("save").addEventListener("click", async ()=>{
  const status = document.getElementById("status").value;
  const info = document.getElementById("info").value;
  try{
    const updated = await api("POST",{op:"update",project:CUR,status,info});
    const i = PROJECTS.findIndex(p=>p.id===CUR); if(i>=0) PROJECTS[i]=updated;
    renderSelector();
    document.getElementById("savedNote").textContent = "Saved ✓";
  }catch(e){ showErr(e.message); }
});

// inline name editor (create + rename); shared toggle only for create
let editorMode=null, sharedMode=false;
function setShared(on){ sharedMode=on; document.getElementById("sharedToggle").classList.toggle("on",on); }
function openEditor(mode, value){
  editorMode=mode; setShared(false);
  document.getElementById("sharedToggle").style.display = mode==="create" ? "" : "none";
  const inp=document.getElementById("editorInput");
  inp.value=value||""; inp.placeholder = mode==="create"?"New project name…":"Rename project…";
  document.getElementById("editor").classList.add("on"); inp.focus();
}
function closeEditor(){ editorMode=null; document.getElementById("editor").classList.remove("on"); }
document.getElementById("new").addEventListener("click", ()=>openEditor("create",""));
document.getElementById("edit").addEventListener("click", ()=>{ const p=curProject(); openEditor("rename", p?p.name:""); });
document.getElementById("sharedToggle").addEventListener("click", ()=>setShared(!sharedMode));
document.getElementById("editorCancel").addEventListener("click", closeEditor);
document.getElementById("editorSave").addEventListener("click", saveEditor);
document.getElementById("editorInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter") saveEditor(); if(e.key==="Escape") closeEditor(); });
async function saveEditor(){
  const name=document.getElementById("editorInput").value.trim(); if(!name) return;
  try{
    if(editorMode==="create"){ const p=await api("POST",{op:"create",name,shared:sharedMode}); await api("POST",{op:"switch",project:p.id}); }
    else { await api("POST",{op:"update",project:CUR,name}); }
    closeEditor(); await load();
  }catch(e){ showErr(e.message); }
}
document.getElementById("edit").addEventListener("dblclick", async ()=>{
  if(await confirmAsync("Archive this project? It is kept but hidden.")){
    try{ await api("POST",{op:"archive",project:CUR}); await load(); }catch(e){ showErr(e.message); }
  }
});

function showNoTelegram(){
  const plat = tg ? (tg.platform+" "+tg.version) : "no Telegram SDK";
  document.querySelector("header").style.display="none";
  document.getElementById("main").innerHTML =
    '<div class="empty">Open this from the <b>Tasks</b> button in @clawmerqbot.<br>'+
    'A Mini App only receives your Telegram identity when launched from inside Telegram.'+
    '<br><br><small>Telegram: '+esc(plat)+' · initData: empty</small></div>';
}
if (INIT) load(); else showNoTelegram();
</script>
</body>
</html>`;
}
