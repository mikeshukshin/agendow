import type { IncomingMessage, ServerResponse } from "node:http";
import { listTypes, loadConfig, resolveVars } from "./config.js";
import { verifyInitData } from "./telegram-auth.js";
import type { TaskStore } from "./store.js";
import { defaultFetchJson, type FetchJson, renderProject } from "./views.js";

export interface MiniAppOptions {
  store: TaskStore;
  getBotToken: () => string | undefined;
  ownerIds?: number[];
  basePath: string;
  configPath: string;
  fetchJson?: FetchJson;
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
    if (size > 512 * 1024) throw new Error("body too large");
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

function auth(req: IncomingMessage, url: URL, res: ServerResponse, opts: MiniAppOptions): string | null {
  const header = req.headers["x-telegram-init-data"];
  const initData = (typeof header === "string" ? header : "") || url.searchParams.get("tgInitData") || "";
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

  if (method === "GET") {
    return sendJson(res, 200, { ...store.overview(userId), types: listTypes(loadConfig(opts.configPath)) });
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
          return sendJson(res, 200, store.createProject({ userId, name, shared: body.shared === true }));
        }
        case "update":
          return sendJson(res, 200, store.updateProject({
            userId,
            idOrName: target,
            patch: {
              name: str(body.name) || undefined,
              status: typeof body.status === "string" ? str(body.status) : undefined,
              typeId: typeof body.typeId === "string" ? str(body.typeId) : undefined,
              params: body.params && typeof body.params === "object" && !Array.isArray(body.params)
                ? (body.params as Record<string, string>) : undefined,
              sections: Array.isArray(body.sections) ? (body.sections as Array<{ id?: string; title: string; body?: string }>) : undefined,
            },
          }));
        case "render": {
          const proj = store.getProject(userId, target);
          if (!proj) return sendJson(res, 400, { error: "no such project" });
          const cfg = loadConfig(opts.configPath);
          const type = proj.typeId ? cfg.projectTypes[proj.typeId] : undefined;
          const text = await renderProject(proj, type, opts.fetchJson ?? defaultFetchJson, resolveVars(cfg.vars));
          return sendJson(res, 200, { text });
        }
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

// Self-contained Telegram Mini App: render-first dashboard; editor (status/type/params/sections) behind ✎.
export function renderMiniAppHtml(base: string): string {
  const cfg = JSON.stringify({ projectsPath: `${base}/projects` });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Agendow</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
<style>
  :root { color-scheme: light dark;
    --bg: var(--tg-theme-bg-color,#0f1115); --card: var(--tg-theme-secondary-bg-color,#181b22);
    --fg: var(--tg-theme-text-color,#e6e8ee); --muted: var(--tg-theme-hint-color,#8b93a7);
    --accent: var(--tg-theme-button-color,#4c8bf5); --accent-fg: var(--tg-theme-button-text-color,#fff);
    --line: rgba(128,138,160,.25); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; }
  header { padding:8px 10px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
  .bar { display:flex; gap:6px; align-items:center; }
  select#proj { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:7px 9px; font:inherit; }
  header button { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:7px 11px; font:inherit; cursor:pointer; }
  header button.on { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
  .editor { display:none; gap:6px; margin-top:6px; }
  .editor.on { display:flex; }
  .editor input { flex:1; min-width:0; background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:7px 9px; font:inherit; }
  .editor button#editorSave { background:var(--accent); color:var(--accent-fg); border:0; }
  main { padding:10px 12px; }
  /* render-first view: the project's markdown rendered to real HTML */
  .md { font-size:13.5px; line-height:1.5; overflow-wrap:anywhere; }
  .md > :first-child { margin-top:0; }
  .md h1 { font-size:16px; margin:0 0 8px; }
  .md h2 { font-size:14px; margin:14px 0 6px; }
  .md h3 { font-size:13px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  .md h4 { font-size:13.5px; margin:10px 0 4px; }
  .md p { margin:6px 0; }
  .md ul, .md ol { margin:6px 0; padding-left:20px; }
  .md li { margin:2px 0; }
  .md a { color:var(--accent); }
  .md hr { border:0; border-top:1px solid var(--line); margin:12px 0; }
  .md code { background:var(--card); padding:1px 5px; border-radius:5px; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .md pre { background:var(--card); padding:10px; border-radius:10px; overflow-x:auto; }
  .md pre code { background:none; padding:0; }
  /* tables scroll horizontally inside the card, columns stay aligned */
  .md table { border-collapse:collapse; font-size:12.5px; display:block; overflow-x:auto; max-width:100%; }
  .md th, .md td { border:1px solid var(--line); padding:5px 8px; text-align:left; white-space:nowrap; }
  .md th { background:var(--card); }
  .md blockquote { margin:6px 0; padding-left:10px; border-left:3px solid var(--line); color:var(--muted); }
  #form { display:flex; flex-direction:column; gap:6px; }
  #form[hidden] { display:none; } /* id rule above beats UA [hidden]; restore it explicitly */
  label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-top:6px; }
  input.f, textarea.f, select.f { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:8px 10px; font:inherit; width:100%; }
  textarea.f { min-height:80px; resize:vertical; }
  .prow { display:flex; gap:6px; }
  .prow input.k { flex:0 0 38%; }
  .sec { border:1px solid var(--line); border-radius:11px; padding:9px; display:flex; flex-direction:column; gap:6px; background:var(--card); }
  .sec .top { display:flex; gap:6px; align-items:center; }
  .addbtn { align-self:flex-start; background:transparent; color:var(--accent); border:1px dashed var(--line); border-radius:9px; padding:6px 11px; font:inherit; cursor:pointer; }
  .x { background:transparent; color:var(--muted); border:1px solid var(--line); border-radius:8px; padding:6px 10px; cursor:pointer; }
  .formactions { display:flex; gap:8px; align-items:center; margin-top:10px; }
  #save { background:var(--accent); color:var(--accent-fg); border:0; border-radius:9px; padding:9px 20px; font:inherit; font-weight:600; cursor:pointer; }
  .err { color:#f85149; padding:8px 12px; font-size:13px; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <select id="proj"></select>
    <button id="new" title="New project">＋</button>
    <button id="editToggle" title="Edit">✎</button>
  </div>
  <div class="editor" id="editor">
    <input id="editorInput" placeholder="New project name…" />
    <button id="sharedToggle" title="Shared project">👥</button>
    <button id="editorSave">Save</button>
    <button id="editorCancel">✕</button>
  </div>
</header>
<div id="err" class="err" hidden></div>
<main id="main">
  <div id="renderOut" class="md"></div>
  <div id="form" hidden>
    <label>Name</label>
    <input id="name" class="f" placeholder="Project name" />
    <label>Status</label>
    <input id="status" class="f" placeholder="e.g. Active · Paused — waiting for hardware" />
    <label>Type</label>
    <select id="type" class="f"></select>
    <label>Parameters</label>
    <div id="params" style="display:flex; flex-direction:column; gap:6px;"></div>
    <button id="addParam" class="addbtn">＋ parameter</button>
    <label>Sections</label>
    <div id="sections" style="display:flex; flex-direction:column; gap:8px;"></div>
    <button id="addSection" class="addbtn">＋ section</button>
    <div class="formactions"><button id="save">Save</button><button id="archiveBtn" class="x">Archive</button></div>
  </div>
</main>
<script>
const CFG = ${cfg};
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const INIT = (tg && tg.initData) || "";
let PROJECTS = [], CUR = null, TYPES = [], MODE = "view";
const $ = (id) => document.getElementById(id);
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
function showErr(m){ const e=$("err"); if(!m){e.hidden=true;return;} e.textContent=m; e.hidden=false; }
function confirmAsync(msg){ return new Promise((r)=>{ if(tg&&tg.showConfirm) tg.showConfirm(msg,r); else r(window.confirm(msg)); }); }
function curProject(){ return PROJECTS.find(p => p.id === CUR); }

function el(tag, cls, attrs){ const e=document.createElement(tag); if(cls) e.className=cls; Object.assign(e, attrs||{}); return e; }
function paramRow(k, v){
  const row = el("div","prow");
  const ki = el("input","f k",{value:k||"", placeholder:"key"});
  const vi = el("input","f",{value:v||"", placeholder:"value"});
  const x = el("button","x",{textContent:"✕", onclick:()=>row.remove()});
  row.append(ki, vi, x); return row;
}
function sectionCard(s){
  const card = el("div","sec"); card.dataset.id = (s&&s.id)||"";
  const top = el("div","top");
  const ti = el("input","f",{value:(s&&s.title)||"", placeholder:"Section title"});
  const x = el("button","x",{textContent:"✕", onclick:()=>card.remove()});
  top.append(ti, x);
  const bi = el("textarea","f",{value:(s&&s.body)||"", placeholder:"Text… (markdown)"});
  card.append(top, bi); return card;
}
function renderSelector(){
  $("proj").innerHTML = PROJECTS.map(p =>
    '<option value="'+esc(p.id)+'"'+(p.id===CUR?" selected":"")+'>'+(p.shared?"👥 ":"")+esc(p.name)+(p.status?" · "+esc(p.status):"")+'</option>'
  ).join("");
}
function fillForm(){
  const p = curProject();
  $("name").value = p ? (p.name||"") : "";
  $("status").value = p ? (p.status||"") : "";
  const ts = $("type");
  ts.innerHTML = '<option value="">(no type)</option>' + TYPES.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.label)+'</option>').join("");
  ts.value = (p && p.typeId) || "";
  const pc = $("params"); pc.innerHTML="";
  if(p) for(const [k,v] of Object.entries(p.params||{})) pc.append(paramRow(k,v));
  const sc = $("sections"); sc.innerHTML="";
  if(p) for(const s of (p.sections||[])) sc.append(sectionCard(s));
}
// Render markdown to sanitized HTML; fall back to escaped text if the CDN libs didn't load.
function toHtml(md){
  if(window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(md));
  return "<pre style='white-space:pre-wrap'>"+esc(md)+"</pre>";
}
async function doRender(){
  const out = $("renderOut");
  if(!curProject()){ out.textContent="No project yet — tap ＋ to create one."; return; }
  out.textContent="…";
  try{
    const r = await api("POST",{op:"render",project:CUR});
    if(r.text && r.text.trim()) out.innerHTML = toHtml(r.text);
    else out.textContent = "Nothing to render yet — tap ✎ to add a type or sections.";
  }catch(e){ out.textContent=""; showErr(e.message); }
}
function applyMode(){
  const editing = MODE==="edit";
  $("form").hidden = !editing;
  $("renderOut").hidden = editing;
  $("editToggle").classList.toggle("on", editing);
  if(editing) fillForm(); else doRender();
}
function setMode(m){ MODE=m; showErr(""); applyMode(); }
async function load(){
  try{ showErr("");
    const ov = await api("GET"); PROJECTS = ov.projects; CUR = ov.activeProjectId; TYPES = ov.types || [];
    renderSelector(); applyMode();
  }catch(e){ showErr(e.message); }
}

$("proj").addEventListener("change", async (e)=>{
  CUR = e.target.value; applyMode();
  try{ await api("POST",{op:"switch",project:CUR}); }catch(err){ showErr(err.message); }
});
$("editToggle").addEventListener("click", ()=> setMode(MODE==="edit"?"view":"edit"));
$("addParam").addEventListener("click", ()=>$("params").append(paramRow("","")));
$("addSection").addEventListener("click", ()=>$("sections").append(sectionCard(null)));

$("save").addEventListener("click", async ()=>{
  const name = $("name").value.trim();
  const status = $("status").value;
  const params = {};
  for(const row of document.querySelectorAll("#params .prow")){
    const k = row.querySelector("input.k").value.trim();
    const v = row.querySelectorAll("input")[1].value;
    if(k) params[k] = v;
  }
  const sections = [];
  for(const card of document.querySelectorAll("#sections .sec")){
    const title = card.querySelector("input").value.trim();
    const body = card.querySelector("textarea").value;
    if(title) sections.push({ id: card.dataset.id || undefined, title, body });
  }
  const typeId = $("type").value;
  try{
    const updated = await api("POST",{op:"update",project:CUR,name:name||undefined,status,typeId,params,sections});
    const i = PROJECTS.findIndex(p=>p.id===CUR); if(i>=0) PROJECTS[i]=updated;
    renderSelector(); setMode("view"); // back to the fresh render
  }catch(e){ showErr(e.message); }
});
$("archiveBtn").addEventListener("click", async ()=>{
  if(await confirmAsync("Archive this project? It is kept but hidden.")){
    try{ await api("POST",{op:"archive",project:CUR}); MODE="view"; await load(); }catch(e){ showErr(e.message); }
  }
});

// create (new project) via the inline name bar
let sharedMode=false;
function setShared(on){ sharedMode=on; $("sharedToggle").classList.toggle("on",on); }
function openCreate(){ setShared(false); const inp=$("editorInput"); inp.value=""; $("editor").classList.add("on"); inp.focus(); }
function closeCreate(){ $("editor").classList.remove("on"); }
$("new").addEventListener("click", openCreate);
$("sharedToggle").addEventListener("click", ()=>setShared(!sharedMode));
$("editorCancel").addEventListener("click", closeCreate);
$("editorSave").addEventListener("click", saveCreate);
$("editorInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter") saveCreate(); if(e.key==="Escape") closeCreate(); });
async function saveCreate(){
  const name=$("editorInput").value.trim(); if(!name) return;
  try{
    const p=await api("POST",{op:"create",name,shared:sharedMode});
    await api("POST",{op:"switch",project:p.id});
    closeCreate(); MODE="edit"; await load(); // new project opens in the editor
  }catch(e){ showErr(e.message); }
}

function showNoTelegram(){
  const plat = tg ? (tg.platform+" "+tg.version) : "no Telegram SDK";
  document.querySelector("header").style.display="none";
  $("main").innerHTML =
    '<div class="empty">Open this from the <b>Projects</b> button in @clawmerqbot.<br>'+
    'A Mini App only receives your Telegram identity when launched from inside Telegram.'+
    '<br><br><small>Telegram: '+esc(plat)+' · initData: empty</small></div>';
}
if (INIT) load(); else showNoTelegram();
</script>
</body>
</html>`;
}
