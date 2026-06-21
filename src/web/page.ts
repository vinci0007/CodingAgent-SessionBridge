#!/usr/bin/env node
/**
 * The single-page web viewer, served inline by web/server.ts.
 */
export const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>xfer — session viewer</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;
    --claude:#d97757;--codex:#10a37f;--user:#388bfd;--accent:#1f6feb;}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg);height:100vh;overflow:hidden}
  .app{display:grid;grid-template-columns:380px 1fr;height:100vh}
  .sidebar{border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0}
  .topbar{padding:12px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .topbar h1{font-size:15px;margin:0 8px 0 0;font-weight:600}
  select,input,button{background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px}
  button{cursor:pointer}
  button:hover{border-color:var(--accent)}
  .list{overflow-y:auto;flex:1;min-height:0;overscroll-behavior:contain}
  .project-group{border-bottom:1px solid var(--border)}
  .project-head{display:flex;width:100%;justify-content:space-between;gap:12px;align-items:flex-start;padding:10px 12px 8px;background:rgba(255,255,255,.02);border:0;border-radius:0;text-align:left}
  .project-head:hover{background:var(--panel)}
  .project-main{min-width:0}
  .project-title{font-weight:700;display:flex;align-items:center;gap:5px}
  .chev{color:var(--muted);width:12px;display:inline-block}
  .project-path{color:var(--muted);font-size:11px;word-break:break-all}
  .project-count{color:var(--muted);font-size:11px;white-space:nowrap;padding-top:2px}
  .project-items{display:flex;flex-direction:column}
  .item{display:block;width:100%;text-align:left;padding:10px 12px;border:0;border-top:1px solid var(--border);border-radius:0;background:transparent}
  .item:hover{background:var(--panel)}
  .item.active{background:#1c2333;border-left:3px solid var(--accent);padding-left:9px}
  .badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
  .badge.claude{background:rgba(217,119,87,.18);color:var(--claude)}
  .badge.codex{background:rgba(16,163,127,.18);color:var(--codex)}
  .item .title{margin-top:4px;color:var(--fg);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .item .meta{color:var(--muted);font-size:11px;margin-top:2px}
  .main{display:flex;flex-direction:column;min-height:0}
  .mainhead{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .mainhead .info{flex:1;min-width:200px}
  .mainhead .info .t{font-weight:600}
  .mainhead .info .s{color:var(--muted);font-size:12px}
  .timeline{overflow-y:auto;flex:1;min-height:0;padding:16px 20px}
  .turn{margin-bottom:18px;max-width:980px}
  .turn .role{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:4px;font-weight:600}
  .turn.user .role{color:var(--user)}
  .turn.assistant .role{color:var(--claude)}
  .block{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;white-space:pre-wrap;word-break:break-word}
  .block.thinking{border-style:dashed;color:var(--muted);font-style:italic}
  .block.tool_call{border-color:#3b2f5e;background:#1a1530}
  .block.tool_call .tname{color:#bc8cff;font-weight:600}
  .block.tool_result{border-color:#234;background:#0f1a17;color:#9fb}
  .block pre{margin:0;white-space:pre-wrap;font:12px/1.45 ui-monospace,Menlo,monospace}
  .empty{color:var(--muted);padding:40px;text-align:center}
  .spin{color:var(--muted);padding:20px}
  dialog{background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:10px;padding:20px;width:440px}
  dialog::backdrop{background:rgba(0,0,0,.6)}
  dialog h3{margin:0 0 12px}
  dialog label{display:block;margin:10px 0 4px;font-size:12px;color:var(--muted)}
  dialog .row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  code{background:#0008;padding:1px 5px;border-radius:4px;font-family:ui-monospace,monospace}
  .pill{font-size:11px;color:var(--muted)}
  .sync-icon{margin-left:6px;font-size:12px;color:#3fb950;cursor:help}
  .ctx-menu{position:fixed;z-index:50;display:flex;flex-direction:column;min-width:180px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.45)}
  .ctx-menu button{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:5px;padding:7px 10px;font-size:12px}
  .ctx-menu button:hover{background:var(--bg)}
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <div class="topbar">
      <h1>xfer</h1>
      <select id="agentFilter">
        <option value="">All agents</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <input id="cwdFilter" placeholder="filter by cwd…" style="flex:1;min-width:120px"/>
      <button id="refresh">↻ <span id="refreshCountdown">3</span>s</button>
    </div>
    <div class="list" id="list"><div class="spin">Loading…</div></div>
  </div>
  <div class="main">
    <div class="mainhead">
      <div class="info" id="info"><div class="t">Select a session</div><div class="s">—</div></div>
      <button id="syncBtn">Sync Status</button>
      <button id="switchClaude">Switch → Claude</button>
      <button id="switchCodex">Switch → Codex</button>
      <button id="migrateBtn" disabled>Migrate →</button>
    </div>
    <div class="timeline" id="timeline"><div class="empty">Pick a session on the left to view its full history.</div></div>
  </div>
</div>
<div id="ctxMenu" class="ctx-menu" hidden></div>

<dialog id="migrateDlg">
  <h3>Migrate session</h3>
  <div class="pill" id="mgFrom"></div>
  <label>Target agent</label>
  <select id="mgTo"><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
  <label>Mode</label>
  <select id="mgMode">
    <option value="faithful">faithful (native records)</option>
    <option value="replay">replay (robust transcript)</option>
  </select>
  <label>Destination cwd (blank = keep original)</label>
  <input id="mgCwd" placeholder="leave blank to keep original cwd"/>
  <div id="mgResult" style="margin-top:12px;font-size:12px"></div>
  <div class="row">
    <button id="mgCancel">Cancel</button>
    <button id="mgGo">Migrate</button>
  </div>
</dialog>

<script>
const $=s=>document.querySelector(s);
let sessions=[], current=null;
const COLLAPSED_PROJECTS_KEY='xfer.collapsedProjects.v1';
const AUTOSYNC_KEY='xfer.autoSync.v1';
const REFRESH_INTERVAL_SECONDS=3;
const collapsedProjects=loadCollapsedProjects();
const autoSyncOn=loadAutoSync();
const autoSyncSeen=new Map();
let refreshCountdown=REFRESH_INTERVAL_SECONDS;
let refreshTimer;

function loadCollapsedProjects(){
  try{return new Set(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY)||'[]'));}
  catch{return new Set();}
}
function saveCollapsedProjects(){localStorage.setItem(COLLAPSED_PROJECTS_KEY,JSON.stringify([...collapsedProjects]));}
function loadAutoSync(){try{return new Set(JSON.parse(localStorage.getItem(AUTOSYNC_KEY)||'[]'));}catch{return new Set();}}
function saveAutoSync(){localStorage.setItem(AUTOSYNC_KEY,JSON.stringify([...autoSyncOn]));}
function isAutoSync(id){return autoSyncOn.has(id);}
function sessionSig(s){return s.sessionId+':'+(s.updatedAt||'')+'/'+(s.turnCount||0);}
function toggleAutoSync(id){
  if(autoSyncOn.has(id)){autoSyncOn.delete(id);autoSyncSeen.delete(id);}
  else{autoSyncOn.add(id);const s=sessions.find(it=>it.sessionId===id); if(s)autoSyncSeen.set(id,sessionSig(s));}
  saveAutoSync(); renderList();
}
function runAutoSyncStep(){
  if(!autoSyncOn.size)return;
  const tasks=[];
  for(const s of sessions){
    if(!isAutoSync(s.sessionId))continue;
    const sig=sessionSig(s);
    if(autoSyncSeen.get(s.sessionId)===sig)continue;
    autoSyncSeen.set(s.sessionId,sig);
    const to=s.agent==='claude'?'codex':'claude';
    tasks.push(fetch('/api/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to,cwd:s.cwd,sourceSessionId:s.sessionId,mode:'faithful'})}).catch(()=>{}));
  }
  return Promise.all(tasks);
}
function updateRefreshCountdown(){const el=$('#refreshCountdown'); if(el)el.textContent=String(refreshCountdown);}
function resetRefreshCountdown(){refreshCountdown=REFRESH_INTERVAL_SECONDS; updateRefreshCountdown();}
function startAutoRefresh(){
  if(refreshTimer)clearInterval(refreshTimer);
  updateRefreshCountdown();
  refreshTimer=setInterval(()=>{
    refreshCountdown-=1;
    if(refreshCountdown<=0){refreshCountdown=REFRESH_INTERVAL_SECONDS; loadList({silent:true}).then(()=>runAutoSyncStep());}
    updateRefreshCountdown();
  },1000);
}

function projectLabel(cwd){
  const clean=(cwd||'').trim();
  if(!clean)return '(no cwd)';
  return clean.split(/[\\/]/).filter(Boolean).pop()||clean||'(no cwd)';
}

function groupSessions(list){
  const groups=new Map();
  for(const session of list){
    const cwd=(session.cwd||'').trim();
    const key=cwd||'(no cwd)';
    const group=groups.get(key)||{cwd:key,label:projectLabel(cwd),latest:session.updatedAt||session.createdAt||'',sessions:[]};
    group.sessions.push(session);
    if((session.updatedAt||session.createdAt||'')>group.latest) group.latest=session.updatedAt||session.createdAt||'';
    groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>b.latest.localeCompare(a.latest)||a.label.localeCompare(b.label));
}

function loadList(opts={}){
  const agent=$('#agentFilter').value;
  const cwd=$('#cwdFilter').value.trim();
  const q=new URLSearchParams();
  if(agent)q.set('agent',agent);
  if(cwd)q.set('cwd',cwd);
  if(!opts.silent) $('#list').innerHTML='<div class="spin">Loading…</div>';
  return fetch('/api/sessions?'+q).then(r=>r.json().then(d=>({ok:r.ok,d}))).then(({ok,d})=>{
    if(!ok){if(!opts.silent)$('#list').innerHTML='<div class="empty">'+esc(d.error||'Failed to load sessions.')+'</div>';return;}
    sessions=d;
    renderList();
    resetRefreshCountdown();
  }).catch(e=>{if(!opts.silent)$('#list').innerHTML='<div class="empty">'+esc(e.message||e)+'</div>';});
}
function renderList(){
  const groups=groupSessions(sessions);
  if(!groups.length){$('#list').innerHTML='<div class="empty">No sessions.</div>';return;}
  $('#list').innerHTML=groups.map(group=>{
    const items=group.sessions.map(s=>{
      const loc=(s.cwd||'').split(/[\\/]/).filter(Boolean).pop()||group.label;
      const date=(s.updatedAt||s.createdAt||'').slice(0,16).replace('T',' ');
      const syncIcon=isAutoSync(s.sessionId)?' <span class="sync-icon" title="Auto-sync on">🔁</span>':'';
      return '<div class="item" data-id="'+s.sessionId+'">'+
        '<span class="badge '+s.agent+'">'+s.agent+'</span> '+
        '<span class="pill">'+date+' · '+(s.turnCount||0)+' turns</span>'+syncIcon+
        '<div class="title">'+esc(s.title||'(no title)')+'</div>'+
        '<div class="meta">'+esc(loc)+' · '+s.sessionId.slice(0,8)+'</div></div>';
    }).join('');
    const collapsed=collapsedProjects.has(group.cwd);
    return '<section class="project-group'+(collapsed?' collapsed':'')+'">'+
      '<button class="project-head" data-project="'+esc(group.cwd)+'">'+
        '<div class="project-main"><div class="project-title"><span class="chev">'+(collapsed?'▸':'▾')+'</span>'+esc(group.label)+'</div><div class="project-path">'+esc(group.cwd)+'</div></div>'+
        '<div class="project-count">'+group.sessions.length+' session'+(group.sessions.length===1?'':'s')+'</div>'+
      '</button>'+
      '<div class="project-items">'+items+'</div>'+
    '</section>';
  }).join('');
  document.querySelectorAll('.project-head').forEach(el=>el.onclick=()=>{const key=el.dataset.project||''; if(collapsedProjects.has(key))collapsedProjects.delete(key); else collapsedProjects.add(key); saveCollapsedProjects(); renderList();});
  document.querySelectorAll('.item').forEach(el=>{
    el.onclick=()=>openSession(el.dataset.id,el);
    el.oncontextmenu=e=>{e.preventDefault();openCtx(el.dataset.id,e.clientX,e.clientY);};
  });
}
function sessionCwd(id){return (sessions.find(it=>it.sessionId===id)||{}).cwd||($('#cwdFilter').value.trim()||(current&&current.meta&&current.meta.cwd)||undefined);}
function closeCtx(){const m=$('#ctxMenu'); if(m){m.hidden=true;m.innerHTML='';}}
function openCtx(id,x,y){
  const s=sessions.find(it=>it.sessionId===id); if(!s)return;
  const to=s.agent==='claude'?'codex':'claude';
  const on=isAutoSync(id);
  const m=$('#ctxMenu');
  m.innerHTML='<button data-act="migrate" data-id="'+id+'" data-to="'+to+'">Migrate → '+to+'</button>'+
    '<button data-act="switch" data-id="'+id+'" data-to="'+to+'">Switch → '+to+'</button>'+
    '<button data-act="autosync" data-id="'+id+'">'+(on?'Auto-sync: On ✓':'Auto-sync: Off')+'</button>';
  m.hidden=false;
  const r=m.getBoundingClientRect();
  m.style.left=Math.min(x,window.innerWidth-r.width-8)+'px';
  m.style.top=Math.min(y,window.innerHeight-r.height-8)+'px';
  m.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
    const act=btn.dataset.act,id=btn.dataset.id,to=btn.dataset.to;
    closeCtx();
    if(act==='migrate')migrateId(id,to);
    else if(act==='switch')switchTo(to,sessionCwd(id));
    else if(act==='autosync')toggleAutoSync(id);
  });
}
function migrateId(id,to){
  $('#timeline').innerHTML='<div class="spin">Migrating…</div>';
  fetch('/api/migrate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:id,to,mode:'faithful',cwd:sessionCwd(id)})})
    .then(r=>r.json().then(d=>({ok:r.ok,d}))).then(({ok,d})=>{
      if(!ok){$('#timeline').innerHTML='<div class="empty">'+esc(d.error||'Migrate failed.')+'</div>';return;}
      $('#timeline').innerHTML='<div class="block">✓ Migrated to '+d.to+'<br>New session: <code>'+esc(d.sessionId)+'</code><br>Resume: <code>'+esc(d.resumeCommand)+'</code></div>';
      loadList();
    });
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

async function openSession(id,el){
  document.querySelectorAll('.item').forEach(e=>e.classList.remove('active'));
  if(el)el.classList.add('active');
  $('#timeline').innerHTML='<div class="spin">Loading…</div>';
  const r=await fetch('/api/session/'+encodeURIComponent(id));
  if(!r.ok){$('#timeline').innerHTML='<div class="empty">Failed to load.</div>';return;}
  const data=await r.json();
  current=data;
  const m=data.meta;
  $('#info').innerHTML='<div class="t">'+esc(m.title||m.sessionId)+'</div>'+
    '<div class="s"><span class="badge '+m.agent+'">'+m.agent+'</span> '+
    esc(m.model||'?')+' · '+m.turnCount+' turns · '+esc(m.cwd||'')+'</div>';
  $('#migrateBtn').disabled=false;
  renderTimeline(data);
}
function renderTimeline(data){
  const tl=data.turns.map(t=>{
    const blocks=t.blocks.map(b=>{
      if(b.kind==='text')return '<div class="block">'+esc(b.text)+'</div>';
      if(b.kind==='thinking')return '<div class="block thinking">'+esc(b.text)+'</div>';
      if(b.kind==='tool_call')return '<div class="block tool_call"><span class="tname">🔧 '+esc(b.name)+'</span><pre>'+esc(typeof b.input==='string'?b.input:JSON.stringify(b.input,null,2))+'</pre></div>';
      if(b.kind==='tool_result')return '<div class="block tool_result"><pre>'+esc(b.output)+'</pre></div>';
      return '';
    }).join('');
    if(!blocks)return '';
    return '<div class="turn '+t.role+'"><div class="role">'+t.role+'</div>'+blocks+'</div>';
  }).join('');
  $('#timeline').innerHTML=tl||'<div class="empty">No displayable content.</div>';
}

// migrate dialog
$('#migrateBtn').onclick=()=>{
  if(!current)return;
  $('#mgFrom').textContent='From: '+current.meta.agent+' · '+current.meta.sessionId;
  $('#mgTo').value=current.meta.agent==='claude'?'codex':'claude';
  $('#mgCwd').value='';
  $('#mgResult').innerHTML='';
  $('#migrateDlg').showModal();
};
$('#mgCancel').onclick=()=>$('#migrateDlg').close();
$('#mgGo').onclick=async()=>{
  $('#mgResult').textContent='Migrating…';
  const r=await fetch('/api/migrate',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({sessionId:current.meta.sessionId,to:$('#mgTo').value,mode:$('#mgMode').value,cwd:$('#mgCwd').value.trim()||current.meta.cwd||undefined})});
  const d=await r.json();
  if(!r.ok){$('#mgResult').innerHTML='<span style="color:#f85">'+esc(d.error)+'</span>';return;}
  $('#mgResult').innerHTML='✓ New '+d.to+' session created.<br>Resume:<br><code>'+esc(d.resumeCommand)+'</code>';
  loadList();
};

function selectedProjectCwd(){return $('#cwdFilter').value.trim()||(current&&current.meta.cwd)||undefined;}
async function switchTo(to,cwd){
  $('#timeline').innerHTML='<div class="spin">Switching to '+to+'…</div>';
  const r=await fetch('/api/switch',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({to,cwd:cwd||selectedProjectCwd()})});
  const d=await r.json();
  if(!r.ok){$('#timeline').innerHTML='<div class="empty">'+esc(d.error||'Switch failed.')+'</div>';return;}
  $('#timeline').innerHTML='<div class="block">'+(d.reused?'Existing mapping':'Created mapping')+'<br>'+esc(d.sourceAgent)+' → '+esc(d.targetAgent)+'<br><br>Resume:<br><code>'+esc(d.resumeCommand)+'</code>'+(d.note?'<br><br>'+esc(d.note):'')+'</div>';
  loadList();
}
async function showSync(){
  const q=new URLSearchParams();
  const cwd=selectedProjectCwd();
  if(cwd)q.set('cwd',cwd);
  const r=await fetch('/api/sync-status?'+q);
  const d=await r.json();
  if(!r.ok){$('#timeline').innerHTML='<div class="empty">'+esc(d.error||'Sync status failed.')+'</div>';return;}
  $('#timeline').innerHTML='<div class="block"><pre>'+esc(d.text)+'</pre></div>';
}

$('#refresh').onclick=()=>{resetRefreshCountdown();loadList();};
$('#agentFilter').onchange=()=>{resetRefreshCountdown();loadList();};
$('#cwdFilter').addEventListener('keydown',e=>{if(e.key==='Enter'){resetRefreshCountdown();loadList();}});
$('#switchClaude').onclick=()=>switchTo('claude');
$('#switchCodex').onclick=()=>switchTo('codex');
$('#syncBtn').onclick=showSync;
document.addEventListener('click',e=>{const m=$('#ctxMenu');if(m&&!m.hidden&&!m.contains(e.target))closeCtx();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeCtx();});
$('#list').addEventListener('scroll',closeCtx,{passive:true});
startAutoRefresh();
loadList();
</script>
</body>
</html>`;
