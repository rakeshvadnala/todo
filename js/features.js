/* ==========================================================================
   Flow — feature layer
   Sits on top of script.js through the window.Flow API. Contains: the More
   menu, quick add, command palette, CSV import/export, print, settings
   (appearance, columns, templates, reminders, security), backups, streaks,
   install/offline support. 
   ========================================================================== */
(function(){
"use strict";

const F = window.Flow;
if(!F){ console.error("Flow API missing — script.js must load first."); return; }

const $ = (id) => document.getElementById(id);
const esc = F.escapeHtml;
const pad = (n) => String(n).padStart(2, "0");
const st = () => F.state;
const ls = {
  get(k, d){ try{ const v = window.FlowStore.getItem(k); return v ? JSON.parse(v) : d; }catch(e){ return d; } },
  set(k, v){ try{ window.FlowStore.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } }
};

/* ---------- Generic: tiny modal factory ---------- */
function makeModal(id, title, extraClass){
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.id = id;
  ov.innerHTML = `<div class="modal ${extraClass || ""}" role="dialog" aria-modal="true" aria-labelledby="${id}Title">
    <div class="modal-head"><h2 id="${id}Title">${esc(title)}</h2>
      <button class="icon-btn" data-close aria-label="Close" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    </div>
    <div class="modal-body"></div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("mousedown", (e)=>{ if(e.target === ov) F.closeOverlay(id); });
  ov.querySelector("[data-close]").addEventListener("click", ()=>F.closeOverlay(id));
  return ov;
}
const click = (id) => { const el = $(id); if(el) el.click(); };

/* ==========================================================================
   MORE MENU
   ========================================================================== */
(function moreMenu(){
  const btn = $("moreBtn"), menu = $("moreMenu");
  const close = (focusBtn)=>{ menu.hidden = true; btn.setAttribute("aria-expanded","false"); if(focusBtn) btn.focus(); };
  const open = ()=>{ menu.hidden = false; btn.setAttribute("aria-expanded","true"); };
  btn.addEventListener("click", (e)=>{ e.stopPropagation(); menu.hidden ? open() : close(); });
  document.addEventListener("click", (e)=>{ if(!menu.hidden && !menu.contains(e.target)) close(); });
  menu.addEventListener("click", (e)=>{ if(e.target.closest(".menu-item")) close(); });
  menu.addEventListener("keydown", (e)=>{
    const items = [...menu.querySelectorAll(".menu-item:not([hidden])")];
    const i = items.indexOf(document.activeElement);
    if(e.key === "ArrowDown"){ e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if(e.key === "Escape"){ e.stopPropagation(); close(true); }
  });
  btn.addEventListener("keydown", (e)=>{
    if(e.key === "ArrowDown"){ e.preventDefault(); open(); menu.querySelector(".menu-item").focus(); }
  });
})();

/* ==========================================================================
   QUICK ADD — natural-language task entry
   "Send report fri !high #PowerBI every weekday @progress"
   ========================================================================== */
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const DAYS = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
const dayRe = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun";
const fmtShort = (ds) => new Date(ds + "T00:00:00").toLocaleDateString(F.locale, { weekday:"short", day:"numeric", month:"short" });

function nextWeekday(target, from){
  const d = new Date(from); d.setHours(0,0,0,0);
  let diff = (target - d.getDay() + 7) % 7;
  if(diff === 0) diff = 7;
  d.setDate(d.getDate() + diff);
  return F.localDateStr(d);
}

function parseQuick(text){
  const today = new Date(); today.setHours(0,0,0,0);
  let rest = " " + text + " ";
  const out = { title:"", priority:null, dueDate:null, project:null, recur:null, status:null };
  const take = (re, fn)=>{
    const m = rest.match(re);
    if(!m) return false;
    const ok = fn(m);
    if(ok === false) return false;
    rest = rest.replace(m[0], " ");
    return true;
  };

  take(/\s!(high|h|medium|med|m|low|l)(?=\s)/i, m=>{
    const v = m[1].toLowerCase()[0];
    out.priority = v === "h" ? "high" : v === "l" ? "low" : "medium";
  });
  take(/\s#([\p{L}\p{N}_-]+)(?=\s)/u, m=>{ out.project = m[1]; });
  take(/\s@([\p{L}\p{N}_-]+)(?=\s)/u, m=>{
    const q = m[1].toLowerCase();
    const col = F.getColumns().find(c => c.key === q || c.label.toLowerCase().replace(/\s+/g,"").includes(q));
    if(!col) return false;
    out.status = col.key;
  });

  // repetition
  take(new RegExp("\\severy\\s+(weekdays?|day|week|month|" + dayRe + ")(?=\\s)", "i"), m=>{
    const v = m[1].toLowerCase();
    out.recur = v.startsWith("weekday") ? "weekdays" : v === "day" ? "daily" : v === "week" ? "weekly" : v === "month" ? "monthly" : "weekly";
    if(DAYS[v.slice(0,3)] !== undefined && !["day","week","month"].includes(v) && !v.startsWith("weekday")){
      out.dueDate = nextWeekday(DAYS[v.slice(0,3)], today);
    }
  }) || take(/\s(daily|weekdays|weekly|monthly)(?=\s)/i, m=>{
    out.recur = { daily:"daily", weekdays:"weekdays", weekly:"weekly", monthly:"monthly" }[m[1].toLowerCase()];
  });

  // due date (first matching rule wins)
  if(!out.dueDate){
    const set = (d)=>{ out.dueDate = typeof d === "string" ? d : F.localDateStr(d); };
    const plus = (n)=>{ const d = new Date(today); d.setDate(d.getDate() + n); return d; };
    const tried =
      take(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/, m=>{ set(`${m[1]}-${m[2]}-${m[3]}`); }) ||
      take(/\s(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?(?=\s)/, m=>{
        const dd = +m[1], mm = +m[2];
        if(dd < 1 || dd > 31 || mm < 1 || mm > 12) return false;
        let yy = m[3] ? +m[3] : today.getFullYear();
        if(yy < 100) yy += 2000;
        let d = new Date(yy, mm - 1, dd);
        if(!m[3] && d < today) d = new Date(yy + 1, mm - 1, dd);
        set(d);
      }) ||
      take(new RegExp("\\s(\\d{1,2})\\s+(" + MONTHS.join("|") + ")[a-z]*(?:\\s+(\\d{4}))?(?=\\s)", "i"), m=>{
        const mm = MONTHS.indexOf(m[2].toLowerCase());
        let d = new Date(m[3] ? +m[3] : today.getFullYear(), mm, +m[1]);
        if(!m[3] && d < today) d.setFullYear(d.getFullYear() + 1);
        set(d);
      }) ||
      take(new RegExp("\\s(" + MONTHS.join("|") + ")[a-z]*\\s+(\\d{1,2})(?=\\s)", "i"), m=>{
        const mm = MONTHS.indexOf(m[1].toLowerCase());
        let d = new Date(today.getFullYear(), mm, +m[2]);
        if(d < today) d.setFullYear(d.getFullYear() + 1);
        set(d);
      }) ||
      take(/\sin\s+(\d{1,3})\s+(day|days|week|weeks)(?=\s)/i, m=>{ set(plus(+m[1] * (m[2][0].toLowerCase() === "w" ? 7 : 1))); }) ||
      take(/\s(today|tod|eod)(?=\s)/i, ()=>{ set(today); }) ||
      take(/\s(tomorrow|tmrw|tmr)(?=\s)/i, ()=>{ set(plus(1)); }) ||
      take(/\seow(?=\s)/i, ()=>{ set(nextWeekday(5, plus(-1))); }) || // end of the UAE working week = Friday
      take(/\snext\s+week(?=\s)/i, ()=>{ set(nextWeekday(1, today)); }) ||
      take(new RegExp("\\s(?:next\\s+)?(" + dayRe + ")(?=\\s)", "i"), m=>{ set(nextWeekday(DAYS[m[1].toLowerCase().slice(0,3)], today)); });
    void tried;
  }

  out.title = rest.replace(/\s+/g, " ").trim();
  return out;
}

function chipsFor(p){
  const c = [];
  if(p.dueDate) c.push(["Due " + fmtShort(p.dueDate)]);
  if(p.priority) c.push([p.priority[0].toUpperCase() + p.priority.slice(1) + " priority"]);
  if(p.project) c.push(["#" + p.project]);
  if(p.recur) c.push([F.RECUR_LABELS[p.recur]]);
  if(p.status) c.push(["→ " + F.colLabel(p.status)]);
  return c;
}

function quickCreate(text){
  if(!st()) return null;
  const p = parseQuick(text);
  if(!p.title){ return null; }
  let projectId = null;
  if(p.project){
    const q = p.project.toLowerCase();
    const list = F.sortedProjects();
    const hit = list.find(x=>x.name.toLowerCase() === q) || list.find(x=>x.name.toLowerCase().startsWith(q));
    const proj = hit || F.addProject(p.project);
    if(proj){ projectId = proj.id; F.renderProjectFilterSelect(); }
  }
  const t = F.createTask({ title:p.title, priority:p.priority || "medium", dueDate:p.dueDate, projectId, recur:p.recur, status:p.status });
  F.saveState();
  F.renderBoard();
  F.showToast(`Added "${t.title}"`, "success");
  return t;
}

(function quickAddUi(){
  const form = $("quickAddForm"), input = $("quickAddInput"), prev = $("quickAddPreview");
  const renderPreview = ()=>{
    const v = input.value.trim();
    if(!v){ prev.innerHTML = ""; form.classList.remove("has-preview"); return; }
    const p = parseQuick(v);
    const chips = chipsFor(p);
    prev.innerHTML = (p.title ? `<span class="qa-title">${esc(p.title)}</span>` : `<span class="qa-hint">Type a task title…</span>`) +
      chips.map(c=>`<span class="qa-chip">${esc(c[0])}</span>`).join("");
    form.classList.add("has-preview");
  };
  input.addEventListener("input", renderPreview);
  input.addEventListener("keydown", (e)=>{ if(e.key === "Escape"){ input.value = ""; renderPreview(); input.blur(); } });
  form.addEventListener("submit", (e)=>{
    e.preventDefault();
    if(quickCreate(input.value)){ input.value = ""; renderPreview(); }
    else if(!input.value.trim()) input.focus();
  });
  F.on("focus-quickadd", ()=>input.focus());
})();

/* ==========================================================================
   COMMAND PALETTE (Ctrl/Cmd + K)
   ========================================================================== */
const palette = (function(){
  const ov = makeModal("paletteOverlay", "Command palette", "palette");
  ov.querySelector(".modal-head").remove();
  const body = ov.querySelector(".modal-body");
  body.innerHTML = `<div class="pal-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input type="text" id="palInput" placeholder="Search tasks, run a command, or type a task to add…" autocomplete="off" aria-label="Command palette"></div>
    <ul class="pal-list" id="palList" role="listbox"></ul>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>`;
  const input = $("palInput"), list = $("palList");
  let items = [], sel = 0;

  const build = ()=>{
    const cmds = [
      ["New task", "Create", ()=>F.openTaskModal(null), "N"],
      ["Quick add…", "Create", ()=>setTimeout(()=>$("quickAddInput").focus(), 50), "Q"],
      ["Board view", "View", ()=>F.setView("board"), "1"],
      ["List view", "View", ()=>F.setView("list"), "2"],
      ["Calendar view", "View", ()=>F.setView("calendar"), "3"],
      ["Today view", "View", ()=>F.setView("today"), "4"],
      ["Cycle card density", "View", ()=>F.cycleDensity()],
      ["Toggle light / dark theme", "Appearance", ()=>click("themeBtn"), "T"],
      ["Open insights", "Go to", ()=>click("insightsBtn")],
      ["Open archive", "Go to", ()=>click("archiveBtn")],
      ["Lock application", "Security", ()=>window.FlowVault.lock(), "Ctrl Shift L"],
      ["Settings & backups", "Go to", ()=>openSettings()],
      ["GitHub sync settings", "Go to", ()=>click("syncBtn")],
      ["Switch profile", "Go to", ()=>F.openProfileSwitcher()],
      ["Export JSON", "Data", ()=>F.exportData(), "Ctrl E"],
      ["Export CSV (Excel)", "Data", ()=>exportCsv()],
      ["Import JSON / CSV", "Data", ()=>click("importBtn")],
      ["Print / save as PDF", "Data", ()=>printBoard()],
      ["Keyboard shortcuts", "Help", ()=>click("shortcutsBtn"), "?"],
      ["Show all projects", "Filter", ()=>filterProject("all")]
    ].map(([label, tag, run, key])=>({ label, tag, run, key }));
    F.sortedProjects().forEach(p=>cmds.push({ label:"Filter project: " + p.name, tag:"Filter", run:()=>filterProject(p.id) }));
    st().tasks.filter(t=>!t.archived).forEach(t=>cmds.push({
      label:t.title, tag:F.colLabel(t.status), isTask:true, run:()=>F.openTaskModal(t.id)
    }));
    return cmds;
  };
  const filterProject = (id)=>{
    st().settings.projectFilter = id; F.saveState();
    F.renderProjectFilterSelect(); F.renderBoard();
  };
  const render = ()=>{
    const q = input.value.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    let res = build();
    if(tokens.length){
      res = res.map(c=>{
        const h = c.label.toLowerCase();
        if(!tokens.every(t=>h.includes(t))) return null;
        return { c, score: (h.startsWith(tokens[0]) ? 0 : 1) + (c.isTask ? 0.5 : 0) };
      }).filter(Boolean).sort((a,b)=>a.score - b.score).map(x=>x.c);
    } else {
      res = res.filter(c=>!c.isTask).slice(0, 10).concat(res.filter(c=>c.isTask).slice(0, 4));
    }
    res = res.slice(0, 12);
    if(q.length > 1) res.push({ label:`Add task: “${input.value.trim()}”`, tag:"Quick add", run:()=>quickCreate(input.value) });
    items = res; sel = 0; draw();
  };
  const draw = ()=>{
    list.innerHTML = items.length ? items.map((c,i)=>`<li class="pal-item${i === sel ? " sel" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}">
      <span class="pal-label">${esc(c.label)}</span><span class="pal-tag">${esc(c.tag || "")}</span>${c.key ? `<kbd>${esc(c.key)}</kbd>` : ""}</li>`).join("")
      : `<li class="pal-empty">No matches.</li>`;
    const el = list.querySelector(".sel"); if(el) el.scrollIntoView({ block:"nearest" });
  };
  const run = (i)=>{
    const c = items[i]; if(!c) return;
    F.closeOverlay("paletteOverlay");
    setTimeout(()=>c.run(), 30);
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e)=>{
    if(e.key === "ArrowDown"){ e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if(e.key === "Enter"){ e.preventDefault(); run(sel); }
  });
  list.addEventListener("mousemove", (e)=>{ const li = e.target.closest(".pal-item"); if(li && +li.dataset.i !== sel){ sel = +li.dataset.i; draw(); } });
  list.addEventListener("click", (e)=>{ const li = e.target.closest(".pal-item"); if(li) run(+li.dataset.i); });
  return { open(){ if(!st()) return; input.value = ""; render(); F.openOverlay("paletteOverlay"); setTimeout(()=>input.focus(), 40); } };
})();
$("paletteBtn").addEventListener("click", ()=>palette.open());
window.addEventListener("keydown", (e)=>{
  if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k"){ e.preventDefault(); palette.open(); }
});

/* ==========================================================================
   CSV — export / import (opens cleanly in Excel)
   ========================================================================== */
const CSV_HEAD = ["Title","Description","Priority","Column","Project","Due date","Repeat","Created","Completed on","Completed by","Time spent (min)","Subtasks","Archived"];
function csvCell(v){
  v = v == null ? "" : String(v);
  return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function exportCsv(){
  if(!st()) return;
  const rows = [CSV_HEAD].concat(st().tasks.map(t=>{
    const proj = t.projectId ? F.findProject(t.projectId) : null;
    return [
      t.title, t.description || "", t.priority, F.colLabel(t.status), proj ? proj.name : "", t.dueDate || "",
      t.recur || "", t.createdAt ? F.localDateStr(new Date(t.createdAt)) : "",
      t.completedOn ? F.localDateStr(new Date(t.completedOn)) : "", t.completedBy || "",
      Math.round(F.taskElapsed(t) / 60), (t.subtasks || []).map(s=>(s.done ? "[x] " : "[ ] ") + s.text).join(" | "),
      t.archived ? "yes" : ""
    ];
  }));
  const csv = "﻿" + rows.map(r=>r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type:"text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = `flow-tasks-${F.localDateStr(new Date())}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  F.showToast("Exported tasks as CSV", "success");
}
$("exportCsvBtn").addEventListener("click", exportCsv);

function parseCsv(text){
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const count = (ch)=>first.split(ch).length - 1;
  const delim = [",", ";", "\t"].sort((a,b)=>count(b) - count(a))[0];
  const rows = []; let row = [], cell = "", q = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(q){
      if(c === '"'){ if(text[i+1] === '"'){ cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if(c === '"'){ q = true; }
    else if(c === delim){ row.push(cell); cell = ""; }
    else if(c === "\n" || c === "\r"){
      if(c === "\r" && text[i+1] === "\n") i++;
      row.push(cell); cell = "";
      if(row.some(x=>x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if(row.some(x=>x.trim() !== "")) rows.push(row);
  return rows;
}
function csvDate(v){
  v = (v || "").trim();
  if(!v) return null;
  let m;
  if((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if((m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))){ // UAE / UK order: day first
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return `${y}-${pad(m[2])}-${pad(m[1])}`;
  }
  if((m = v.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/))){
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    if(mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(m[1])}`;
  }
  if(/^\d{5}$/.test(v)){ // Excel serial date
    const d = new Date(Math.round((+v - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return null;
}
window.FlowCsv = {
  importText(text){
    if(!st()) return;
    const rows = parseCsv(text);
    if(rows.length < 2){ F.showToast("That CSV has no task rows.", "error"); return; }
    const norm = (s)=>s.toLowerCase().replace(/[^a-z]/g, "");
    const idx = {};
    const alias = {
      title:["title","task","name","summary","taskname"], description:["description","notes","details","note"],
      priority:["priority","prio"], column:["column","status","state","stage","list"], project:["project"],
      due:["duedate","due","deadline","duedateutc"], repeat:["repeat","recurrence","recurring"],
      subtasks:["subtasks","checklist"], archived:["archived"], minutes:["timespentmin","timespent","minutes"]
    };
    rows[0].forEach((h, i)=>{
      const n = norm(h);
      for(const k in alias) if(idx[k] === undefined && alias[k].includes(n)) idx[k] = i;
    });
    if(idx.title === undefined){ F.showToast('No "Title" column found in the CSV header.', "error"); return; }
    const get = (r, k)=> idx[k] === undefined ? "" : (r[idx[k]] || "").trim();
    let added = 0, skipped = 0;
    rows.slice(1).forEach(r=>{
      const title = get(r, "title");
      if(!title){ skipped++; return; }
      const pr = get(r, "priority").toLowerCase();
      const priority = /^(h|high|urgent|1|p1)/.test(pr) ? "high" : /^(l|low|3|p3)/.test(pr) ? "low" : "medium";
      const sv = get(r, "column").toLowerCase();
      let status = null;
      const cols = F.getColumns();
      const byLabel = cols.find(c=>c.label.toLowerCase() === sv || c.key === sv);
      if(byLabel) status = byLabel.key;
      else if(/^(done|complete|completed|closed|finished)/.test(sv)) status = "completed";
      else if(/^(doing|in ?progress|wip|started|active)/.test(sv)){ const c = cols.find(c=>c.key === "inprogress"); status = c ? c.key : null; }
      let projectId = null;
      const pn = get(r, "project");
      if(pn){
        const found = F.sortedProjects().find(p=>p.name.toLowerCase() === pn.toLowerCase());
        const proj = found || F.addProject(pn);
        if(proj) projectId = proj.id;
      }
      const rp = get(r, "repeat").toLowerCase();
      const recur = ["daily","weekdays","weekly","monthly"].find(x=>rp.startsWith(x.slice(0, 5))) || null;
      const subs = get(r, "subtasks").split(/\s*\|\s*|\s*;\s*/).filter(Boolean);
      const subtasks = subs.map(x=>{
        const done = /^\[x\]\s*/i.test(x);
        return { id:F.uid(), text:x.replace(/^\[( |x)\]\s*/i, "").slice(0, 200), done, createdAt:F.nowISO(), updatedAt:F.nowISO() };
      });
      const t = F.createTask({
        title, description:get(r, "description"), priority, dueDate:csvDate(get(r, "due")), status, projectId, recur,
        subtasks, timeSpent:(parseFloat(get(r, "minutes")) || 0) * 60
      });
      if(/^(y|yes|true|1)/i.test(get(r, "archived")) && t.status === "completed") t.archived = true;
      t.activity = [{ id:F.uid(), at:F.nowISO(), by:F.displayName || "Me", type:"event", text:"Imported from CSV" }];
      added++;
    });
    F.saveState();
    F.renderProjectFilterSelect();
    F.renderBoard();
    F.showToast(`Imported ${added} task${added === 1 ? "" : "s"} from CSV${skipped ? `, skipped ${skipped}` : ""}`, added ? "success" : "error");
  }
};

/* ==========================================================================
   PRINT / PDF
   ========================================================================== */
function buildPrintHeader(){
  if(!st()) return;
  const all = st().tasks.filter(t=>!t.archived);
  const todayStr = F.localDateStr(new Date());
  const done = all.filter(t=>t.status === "completed").length;
  const overdue = all.filter(t=>t.status !== "completed" && t.dueDate && t.dueDate < todayStr).length;
  const date = new Date().toLocaleDateString(F.locale, { timeZone:"Asia/Dubai", weekday:"long", day:"numeric", month:"long", year:"numeric" });
  $("printHeader").innerHTML = `<div class="ph-title">Flow — ${esc(F.displayName)}</div>
    <div class="ph-sub">${esc(date)} · ${all.length} active · ${done} completed · ${overdue} overdue</div>`;
}
function printBoard(){ buildPrintHeader(); setTimeout(()=>window.print(), 50); }
window.addEventListener("beforeprint", buildPrintHeader);
$("printBtn").addEventListener("click", printBoard);

/* ==========================================================================
   STREAKS, WEEKLY GOAL, CELEBRATION
   Weekends (Sat/Sun in the UAE) never break a streak.
   ========================================================================== */
function completionDays(){
  const set = {};
  (st() ? st().tasks : []).forEach(t=>{ if(t.completedOn) set[F.isoToLocalDay(t.completedOn)] = (set[F.isoToLocalDay(t.completedOn)] || 0) + 1; });
  return set;
}
function streakInfo(){
  const days = completionDays();
  const d = new Date(); d.setHours(0,0,0,0);
  let streak = 0, guard = 0;
  while(guard++ < 800){
    const key = F.localDateStr(d);
    if(days[key]) streak++;
    else if(streak === 0 && F.localDateStr(new Date()) === key){ /* today not done yet — keep looking back */ }
    else if(d.getDay() === 0 || d.getDay() === 6){ /* weekend gap doesn't break it */ }
    else break;
    d.setDate(d.getDate() - 1);
  }
  const mon = new Date(); mon.setHours(0,0,0,0);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  let week = 0;
  for(const k in days) if(new Date(k + "T00:00:00") >= mon) week += days[k];
  return { streak, week, goal: (st().settings.weeklyGoal || 10), days };
}
function updateStreakChip(){
  const el = $("opStreak"); if(!el || !st()) return;
  const s = streakInfo();
  el.hidden = false;
  el.textContent = `Streak ${s.streak}d · Week ${s.week}/${s.goal}`;
  el.title = "Consecutive working days with at least one completed task (weekends don't break it) · tasks completed this week vs your goal";
  el.classList.toggle("goal-met", s.week >= s.goal);
}
F.on("render", updateStreakChip);
F.on("status", ({ task })=>{
  if(task.status !== "completed" || !st()) return;
  setTimeout(()=>{
    const active = st().tasks.filter(t=>!t.archived);
    const s = streakInfo();
    const fill = $("opFill");
    if(active.length >= 2 && active.every(t=>t.status === "completed")){
      F.showToast("Board clear — everything is done.", "success");
      if(fill){ fill.classList.add("celebrate"); setTimeout(()=>fill.classList.remove("celebrate"), 1400); }
    } else if(s.week === s.goal){
      F.showToast(`Weekly goal reached — ${s.goal} tasks done.`, "success");
      if(fill){ fill.classList.add("celebrate"); setTimeout(()=>fill.classList.remove("celebrate"), 1400); }
    }
  }, 120);
});

// Insights extras (time tracking, streak, goal) injected under the KPI row.
(function insightsExtras(){
  const body = $("insightsBody"); if(!body) return;
  let busy = false;
  const inject = ()=>{
    if(busy || !st() || !body.firstElementChild || body.querySelector("#insightsFocusPanel")) return;
    busy = true;
    const s = streakInfo();
    const tasks = st().tasks;
    const weekAgo = Date.now() - 7*86400000;
    let weekSec = 0, totalSec = 0;
    tasks.forEach(t=>{
      totalSec += F.taskElapsed(t);
      (t.timeLog || []).forEach(l=>{ if(new Date(l.at).getTime() >= weekAgo) weekSec += l.sec; });
    });
    const top = tasks.filter(t=>F.taskElapsed(t) > 0).sort((a,b)=>F.taskElapsed(b) - F.taskElapsed(a)).slice(0, 3);
    const pct = Math.min(100, Math.round(s.week / s.goal * 100));
    const panel = document.createElement("div");
    panel.className = "insights-panel";
    panel.id = "insightsFocusPanel";
    panel.innerHTML = `<h3>Focus <span>Streak, weekly goal and tracked time</span></h3>
      <div class="insights-row">
        <div class="breakdown-list">
          <div class="breakdown-item"><div class="breakdown-head"><span>Current streak</span><b>${s.streak} day${s.streak === 1 ? "" : "s"}</b></div></div>
          <div class="breakdown-item">
            <div class="breakdown-head"><span>Weekly goal</span><b>${s.week} / ${s.goal}</b></div>
            <div class="breakdown-track"><div class="breakdown-fill completed" style="width:${pct}%"></div></div>
          </div>
        </div>
        <div class="breakdown-list">
          <div class="breakdown-item"><div class="breakdown-head"><span>Time tracked · last 7 days</span><b>${F.fmtDuration(weekSec)}</b></div></div>
          <div class="breakdown-item"><div class="breakdown-head"><span>Time tracked · all tasks</span><b>${F.fmtDuration(totalSec)}</b></div></div>
          ${top.length ? `<div class="focus-top">${top.map(t=>`<div class="focus-top-row"><span>${esc(t.title)}</span><b>${F.fmtDuration(F.taskElapsed(t))}</b></div>`).join("")}</div>` : ""}
        </div>
      </div>`;
    const kpis = body.querySelector(".insights-kpis");
    (kpis ? kpis.parentElement : body).insertBefore(panel, kpis ? kpis.nextSibling : null);
    busy = false;
  };
  new MutationObserver(inject).observe(body, { childList:true });
  inject();
})();

/* ==========================================================================
   BACKUPS — automatic daily snapshot (7 kept) + manual, per profile
   ========================================================================== */
const BK_KEY = "flow_backups_v1";
const backups = {
  all(){ return ls.get(BK_KEY, {}); },
  list(key){ return (this.all()[key] || []).slice().sort((a,b)=>b.at.localeCompare(a.at)); },
  create(label){
    const key = F.userKey; if(!key || !st()) return null;
    const all = this.all();
    const arr = all[key] = all[key] || [];
    const snap = { id:F.uid(), at:F.nowISO(), label, tasks:st().tasks.length,
      data: JSON.parse(JSON.stringify({ tasks:st().tasks, projects:st().projects || [], settings:Object.assign({}, st().settings) })) };
    arr.push(snap);
    const autos = arr.filter(x=>x.label === "auto").sort((a,b)=>b.at.localeCompare(a.at));
    autos.slice(7).forEach(x=>arr.splice(arr.indexOf(x), 1));
    const manual = arr.filter(x=>x.label !== "auto").sort((a,b)=>b.at.localeCompare(a.at));
    manual.slice(10).forEach(x=>arr.splice(arr.indexOf(x), 1));
    if(!ls.set(BK_KEY, all)){
      arr.splice(arr.indexOf(snap), 1);
      F.showToast("Couldn't save the backup — browser storage is full.", "error");
      return null;
    }
    return snap;
  },
  remove(key, id){
    const all = this.all();
    all[key] = (all[key] || []).filter(x=>x.id !== id);
    ls.set(BK_KEY, all);
  },
  purge(key){ const all = this.all(); delete all[key]; ls.set(BK_KEY, all); },
  restore(key, id){
    const snap = (this.all()[key] || []).find(x=>x.id === id);
    if(!snap || !st()) return false;
    st().tasks = JSON.parse(JSON.stringify(snap.data.tasks));
    st().projects = JSON.parse(JSON.stringify(snap.data.projects || []));
    st().settings = Object.assign(F.defaultUserData().settings, snap.data.settings || {});
    F.saveState();
    F.selectProfile(key);
    return true;
  }
};
// "Delete profile" erases everything, including that profile's backups.
F.on("profile-deleted", ({ key })=> backups.purge(key));

function autoBackup(){
  if(!st()) return;
  const today = F.localDateStr(new Date());
  const have = backups.list(F.userKey).some(b=>b.label === "auto" && F.isoToLocalDay(b.at) === today);
  if(!have && st().tasks.length) backups.create("auto");
}

/* ==========================================================================
   REMINDERS — browser notifications (while Flow is open or installed)
   ========================================================================== */
const PRI_RANK = { high:0, medium:1, low:2 };
const PRI_LABEL = { high:"High", medium:"Medium", low:"Low" };
// One consolidated notice per day: everything open that is due today or overdue.
function dueDigest(){
  const today = F.localDateStr(new Date());
  const open = st().tasks.filter(t=>!t.archived && t.status !== "completed" && t.dueDate);
  const byPri = (a, b)=> (PRI_RANK[a.priority] ?? 3) - (PRI_RANK[b.priority] ?? 3) || a.dueDate.localeCompare(b.dueDate);
  return {
    overdue: open.filter(t=>t.dueDate < today).sort((a, b)=>a.dueDate.localeCompare(b.dueDate) || byPri(a, b)),
    due: open.filter(t=>t.dueDate === today).sort(byPri)
  };
}
function checkReminders(){
  const s = st();
  if(!s || !s.settings.reminders) return;
  const today = F.localDateStr(new Date());
  if(s.settings.lastReminder === today) return;          // already notified today
  const { overdue, due } = dueDigest();
  if(!overdue.length && !due.length) return;              // nothing to say
  const showTitles = s.settings.notifyTitles !== false;
  const line = (t, tag)=> `${tag} ${t.title} — ${F.fmtDate(t.dueDate)} · ${PRI_LABEL[t.priority] || "Medium"}`;
  const items = [...overdue.map(t=>line(t, "Overdue:")), ...due.map(t=>line(t, "Today:"))];
  const counts = [due.length && `${due.length} due today`, overdue.length && `${overdue.length} overdue`].filter(Boolean).join(" · ");
  const body = showTitles ? items.slice(0, 6).join("\n") + (items.length > 6 ? `\n+${items.length - 6} more` : "") : "Open Flow to see them.";
  const title = `Flow — ${counts}`;
  s.settings.lastReminder = today;                        // record first so a failure can't cause a repeat
  F.saveState();
  const canNotify = "Notification" in window && Notification.permission === "granted";
  if(canNotify){
    const opts = { body, icon:"image/todo-logo.png", tag:"flow-daily-digest" };
    const fallback = ()=>{ try{ new Notification(title, opts); }catch(e){} };
    if(navigator.serviceWorker && navigator.serviceWorker.getRegistration){
      navigator.serviceWorker.getRegistration().then(r=> r ? r.showNotification(title, opts) : fallback()).catch(fallback);
    } else fallback();
  } else {
    // Notifications blocked or unsupported: still surface the digest inside the app.
    F.showToast(counts + " — open the Today view", "success", "View", ()=>F.setView("today"));
  }
}
setInterval(checkReminders, 15 * 60 * 1000);
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState === "visible") checkReminders(); });

/* ==========================================================================
   SETTINGS & BACKUPS
   ========================================================================== */
const COLUMN_COLORS = ["#8E6BBF","#C2577A","#3E9A9A","#B7791F","#5B7DB1","#6E8B3D"];
const PALETTES = [["slate","Slate (default)"],["mist","Mist — cool blue-grey"],["stone","Stone — warm neutral"],["graphite","Graphite — true grey"],["forest","Forest — green-grey"]];
const ACCENTS = [["navy","#1F4E8C"],["pine","#1B6B6A"],["blue","#3A5F8F"],["violet","#5B4B8A"],["rose","#8A3F57"],["graphite","#3A4556"]];
const settingsOv = makeModal("settingsOverlay", "Settings", "settings-modal");
const sBody = settingsOv.querySelector(".modal-body");

function seg(name, opts, cur){
  return `<div class="seg" role="group">${opts.map(([v, l])=>`<button type="button" data-set="${name}" data-val="${v}" class="${cur === v ? "active" : ""}" aria-pressed="${cur === v}">${l}</button>`).join("")}</div>`;
}
function renderSettings(){
  const s = st().settings;
  const cols = F.getColumns();
  const tpls = s.templates || [];
  const bk = backups.list(F.userKey);
  const notifSupported = "Notification" in window;
  const perm = notifSupported ? Notification.permission : "unsupported";
  sBody.innerHTML = `
  <section class="set-sec">
    <h3>Appearance</h3>
    <div class="set-row"><span>Theme</span>${seg("themeMode", [["light","Light"],["dark","Dark"],["system","System"]], s.themeMode || F.effectiveTheme())}</div>
    <div class="set-row"><label for="paletteSel">Colour theme</label><select class="select" id="paletteSel">${PALETTES.map(([k,l])=>`<option value="${k}"${(s.palette || "slate") === k ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="set-row"><span>Accent</span><div class="swatches" role="group" aria-label="Accent colour">${ACCENTS.map(([k,c])=>
      `<button type="button" class="swatch${(s.accent || "teal") === k ? " active" : ""}" data-set="accent" data-val="${k}" style="--sw:${c}" title="${k}" aria-label="${k}" aria-pressed="${(s.accent || "teal") === k}"></button>`).join("")}</div></div>
    <div class="set-row"><span>Card density</span>${seg("density", [["compact","Compact"],["comfortable","Comfortable"],["detailed","Detailed"]], s.density || "comfortable")}</div>
  </section>

  <section class="set-sec">
    <h3>Goals &amp; reminders</h3>
    <div class="set-row"><label for="goalInput">Weekly goal (tasks completed, Mon–Sun)</label>
      <input type="number" id="goalInput" min="1" max="99" value="${s.weeklyGoal || 10}"></div>
    <label class="set-check"><input type="checkbox" id="remindersInput" ${s.reminders ? "checked" : ""}>
      <span>Daily notification for tasks due today and overdue (one per day)</span></label>
    <label class="set-check"><input type="checkbox" id="notifyTitlesInput" ${s.notifyTitles !== false ? "checked" : ""}>
      <span>Show task titles, due dates and priorities in the notification</span></label>
    <p class="set-note">${!notifSupported ? "This browser doesn't support system notifications — the daily summary appears inside Flow instead." : perm === "denied" ? "Notifications are blocked for this site in your browser settings — the daily summary appears inside Flow instead." : perm === "default" ? "Your browser hasn't granted permission yet; you'll be asked when you unlock. Until then the summary shows inside Flow." : "Sent when you open or unlock Flow and while it stays open (there is no server to push to a closed browser). Completed tasks are never included; nothing is sent when nothing is due."}</p>
  </section>

  <section class="set-sec">
    <h3>Columns</h3>
    <ul class="set-list" id="colList">${cols.map((c,i)=>`
      <li class="set-item" data-i="${i}">
        <span class="col-dot ${c.dot || ""}" style="${c.color ? `background:${c.color}` : ""}"></span>
        <input type="text" class="col-name" value="${esc(c.label)}" maxlength="24" aria-label="Column name">
        <button type="button" class="icon-btn" data-col="up" ${i === 0 ? "disabled" : ""} title="Move up" aria-label="Move up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg></button>
        <button type="button" class="icon-btn" data-col="down" ${i === cols.length - 1 ? "disabled" : ""} title="Move down" aria-label="Move down"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></button>
        <button type="button" class="icon-btn danger-hover" data-col="del" ${c.key === "completed" || cols.length <= 2 ? "disabled" : ""} title="${c.key === "completed" ? "The done column can't be removed" : "Delete column"}" aria-label="Delete column"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </li>`).join("")}</ul>
    <div class="subtask-add-row"><input type="text" id="newColInput" maxlength="24" placeholder="New column, e.g. Blocked or Review"><button type="button" class="btn ghost" id="addColBtn">Add column</button></div>
    <p class="set-note">The first column is where recurring tasks and re-opened tasks land. "Completed" is the done column.
      <button type="button" class="link-btn" id="resetColsBtn">Reset to default</button></p>
  </section>

  <section class="set-sec">
    <h3>Templates</h3>
    ${tpls.length ? `<ul class="set-list">${tpls.map(tp=>`<li class="set-item"><span class="set-grow">${esc(tp.name)}</span><span class="set-meta">${tp.subtasks.length} subtask${tp.subtasks.length === 1 ? "" : "s"}</span>
      <button type="button" class="icon-btn danger-hover" data-tpl="${esc(tp.id)}" title="Delete template" aria-label="Delete template"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></li>`).join("")}</ul>`
      : `<p class="set-note">No templates yet. Fill in the New task dialog and choose “Save as template”.</p>`}
  </section>

  <section class="set-sec">
    <h3>Security &amp; encryption</h3>
    <p class="set-note">Your board is encrypted in this browser (AES-256-GCM, key derived from your master password with PBKDF2-SHA256) and only the encrypted form is saved or synced to GitHub.</p>
    <div class="set-row"><label for="autoLockSel">Lock automatically after inactivity</label>
      <select class="select" id="autoLockSel">${[1,2,5,10,15,30,60].map(m=>`<option value="${m}"${m === (window.FlowVault.getPrefs().autoLockMin || 5) ? " selected" : ""}>${m} minute${m === 1 ? "" : "s"}</option>`).join("")}</select></div>
    <div class="set-row"><span>Lock the application now</span><button type="button" class="btn ghost" id="lockNowBtn">Lock now</button></div>
    <div class="set-block"><h4>Change master password</h4>
      <div class="set-fields">
        <input type="password" id="secCur" autocomplete="current-password" placeholder="Current password" aria-label="Current password">
        <input type="password" id="secNew" autocomplete="new-password" placeholder="New password (min ${window.FlowVault.minPassword} characters)" aria-label="New password">
        <input type="password" id="secNew2" autocomplete="new-password" placeholder="Confirm new password" aria-label="Confirm new password">
        <button type="button" class="btn ghost" id="pwChangeBtn">Change password</button>
      </div></div>
    <div class="set-block"><h4>Recovery key <em>${window.FlowVault.hasRecovery() ? "· created" : "· none"}</em></h4>
      <p class="set-note">${window.FlowVault.hasRecovery() ? "A recovery key exists. Generating a new one invalidates the old key." : "You have no recovery key. If you forget the password, the data cannot be recovered."}</p>
      <div class="set-fields">
        <input type="password" id="secRecPw" autocomplete="current-password" placeholder="Current password" aria-label="Current password">
        <button type="button" class="btn ghost" id="recGenBtn">${window.FlowVault.hasRecovery() ? "Generate a new recovery key" : "Create a recovery key"}</button>
      </div></div>
    <div class="set-row"><span>Download an encrypted copy of everything (safe to store anywhere)</span><button type="button" class="btn ghost" id="exportVaultBtn">Export encrypted backup</button></div>
  </section>

  <section class="set-sec">
    <h3>Backups</h3>
    <div class="set-row"><span>A snapshot is saved automatically once a day (last 7 kept) in this browser.</span><button type="button" class="btn ghost" id="backupNowBtn">Back up now</button></div>
    ${bk.length ? `<ul class="set-list">${bk.map(b=>`<li class="set-item">
      <span class="set-grow">${F.fmtDateTime(b.at)} <em>${b.label === "auto" ? "automatic" : "manual"}</em></span>
      <span class="set-meta">${b.tasks} task${b.tasks === 1 ? "" : "s"}</span>
      <button type="button" class="btn ghost" data-bk-restore="${esc(b.id)}">Restore</button>
      <button type="button" class="icon-btn danger-hover" data-bk-del="${esc(b.id)}" title="Delete backup" aria-label="Delete backup"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button></li>`).join("")}</ul>`
      : `<p class="set-note">No backups yet.</p>`}
  </section>`;
}
function openSettings(){
  if(!st()) return;
  renderSettings();
  F.openOverlay("settingsOverlay");
}
$("settingsBtn").addEventListener("click", openSettings);

sBody.addEventListener("change", (e)=>{
  if(e.target.id !== "paletteSel") return;
  const s = st().settings; s.palette = e.target.value; F.applyPrefs(); F.saveState(); renderSettings();
});
sBody.addEventListener("click", async (e)=>{
  const s = st().settings;
  const t = e.target.closest("button");
  if(!t) return;
  if(t.dataset.set){
    const k = t.dataset.set, v = t.dataset.val;
    if(k === "themeMode"){ s.themeMode = v; s.theme = v === "system" ? s.theme : v; F.applyPrefs(); F.saveState(); }
    else if(k === "accent"){ s.accent = v; F.applyPrefs(); F.saveState(); }
    else if(k === "density"){ s.density = v; F.saveState(); F.applyPrefs(); F.renderBoard(); }
    renderSettings(); return;
  }
  if(t.dataset.col){
    const li = t.closest(".set-item"), i = +li.dataset.i;
    const cols = F.getColumns().map(c=>({ ...c }));
    if(t.dataset.col === "up" && i > 0){ [cols[i-1], cols[i]] = [cols[i], cols[i-1]]; }
    else if(t.dataset.col === "down" && i < cols.length - 1){ [cols[i+1], cols[i]] = [cols[i], cols[i+1]]; }
    else if(t.dataset.col === "del"){
      const c = cols[i];
      const n = st().tasks.filter(x=>x.status === c.key).length;
      const dest = cols.find((x, j)=>j !== i);
      if(n && !confirm(`Delete "${c.label}"? Its ${n} task${n === 1 ? "" : "s"} will move to "${dest.label}".`)) return;
      cols.splice(i, 1);
    }
    F.setColumns(cols); renderSettings(); return;
  }
  if(t.id === "addColBtn"){ addColumn(); return; }
  if(t.id === "resetColsBtn"){
    if(!confirm("Reset to Daily / In Progress / Completed? Tasks in custom columns move to Daily.")) return;
    F.setColumns([
      { key:"daily", label:"Daily", dot:"daily" }, { key:"inprogress", label:"In Progress", dot:"inprogress" }, { key:"completed", label:"Completed", dot:"completed" }
    ]);
    renderSettings(); return;
  }
  if(t.dataset.tpl){
    s.templates = (s.templates || []).filter(x=>x.id !== t.dataset.tpl); F.saveState(); renderSettings(); return;
  }
  if(t.id === "backupNowBtn"){ if(backups.create("manual")) F.showToast("Backup saved", "success"); renderSettings(); return; }
  if(t.dataset.bkRestore){
    if(!confirm("Restore this backup? It replaces this profile's current tasks, projects and settings. (A backup of the current state is saved first.)")) return;
    backups.create("manual");
    if(backups.restore(F.userKey, t.dataset.bkRestore)){ F.closeOverlay("settingsOverlay"); F.showToast("Backup restored", "success"); }
    return;
  }
  if(t.dataset.bkDel){ backups.remove(F.userKey, t.dataset.bkDel); renderSettings(); return; }
  if(t.id === "lockNowBtn"){ window.FlowVault.lock(); return; }
  if(t.id === "pwChangeBtn"){
    const cur = $("secCur").value, n1 = $("secNew").value, n2 = $("secNew2").value;
    if(!cur) { F.showToast("Enter your current password.", "error"); return; }
    if(n1.length < window.FlowVault.minPassword){ F.showToast(`Use at least ${window.FlowVault.minPassword} characters.`, "error"); return; }
    if(n1 !== n2){ F.showToast("The new passwords don't match.", "error"); return; }
    t.disabled = true;
    try{ await window.FlowVault.changePassword(cur, n1); renderSettings(); F.showToast("Master password changed. Sync once to update the GitHub copy.", "success"); }
    catch(err){ t.disabled = false; F.showToast("Current password is incorrect.", "error"); }
    return;
  }
  if(t.id === "recGenBtn"){
    const cur = $("secRecPw").value;
    if(!cur){ F.showToast("Enter your current password.", "error"); return; }
    t.disabled = true;
    try{ const key = await window.FlowVault.newRecoveryKey(cur); F.closeOverlay("settingsOverlay"); window.FlowVault.showRecoveryKey(key); }
    catch(err){ t.disabled = false; F.showToast("Current password is incorrect.", "error"); }
    return;
  }
  if(t.id === "exportVaultBtn"){
    const text = await window.FlowVault.exportBackup();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type:"application/json" }));
    a.download = "flow-encrypted-backup-" + F.localDateStr(new Date()) + ".json"; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
    F.showToast("Encrypted backup downloaded", "success");
    return;
  }
});
function addColumn(){
  const inp = $("newColInput"), label = inp.value.trim();
  if(!label) { inp.focus(); return; }
  const cols = F.getColumns().map(c=>({ ...c }));
  if(cols.some(c=>c.label.toLowerCase() === label.toLowerCase())){ F.showToast("A column with that name already exists.", "error"); return; }
  const color = COLUMN_COLORS[cols.filter(c=>c.color).length % COLUMN_COLORS.length];
  cols.splice(cols.length - 1 >= 0 && cols[cols.length-1].key === "completed" ? cols.length - 1 : cols.length, 0, { key:"c_" + F.uid(), label, dot:"", color });
  F.setColumns(cols); renderSettings();
}
sBody.addEventListener("keydown", (e)=>{ if(e.key === "Enter" && e.target.id === "newColInput"){ e.preventDefault(); addColumn(); } });
sBody.addEventListener("change", async (e)=>{
  const s = st().settings, el = e.target;
  if(el.classList.contains("col-name")){
    const i = +el.closest(".set-item").dataset.i;
    const v = el.value.trim();
    if(!v){ renderSettings(); return; }
    const cols = F.getColumns().map(c=>({ ...c })); cols[i].label = v; F.setColumns(cols); return;
  }
  if(el.id === "goalInput"){ s.weeklyGoal = Math.max(1, Math.min(99, parseInt(el.value, 10) || 10)); F.saveState(); updateStreakChip(); return; }
  if(el.id === "autoLockSel"){ window.FlowVault.setPrefs({ autoLockMin: parseInt(el.value, 10) || 5 }); F.showToast("Auto-lock updated", "success"); return; }
  if(el.id === "notifyTitlesInput"){ s.notifyTitles = el.checked; F.saveState(); return; }
  if(el.id === "remindersInput"){
    s.remindersSet = true;
    if(!el.checked){ s.reminders = false; F.saveState(); return; }
    s.reminders = true; F.saveState();
    if("Notification" in window && Notification.permission === "default"){ try{ await Notification.requestPermission(); }catch(e){} }
    renderSettings(); F.showToast("Daily notification on", "success");
    s.lastReminder = ""; F.saveState(); checkReminders();
  }
});

/* ==========================================================================
   DIALOG FOCUS — keep Tab inside an open dialog and hand focus back on close
   ========================================================================== */
(function dialogFocus(){
  const opener = new WeakMap();
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const visible = (el)=> el.offsetParent !== null || el === document.activeElement;
  document.querySelectorAll(".modal-overlay").forEach(watch);
  new MutationObserver((recs)=>recs.forEach(r=>r.addedNodes.forEach(n=>{ if(n.classList && n.classList.contains("modal-overlay")) watch(n); })))
    .observe(document.body, { childList:true });
  function watch(ov){
    if(ov.__watched) return; ov.__watched = true;
    let wasOpen = ov.classList.contains("open");
    new MutationObserver(()=>{
      const open = ov.classList.contains("open");
      if(open && !wasOpen) opener.set(ov, document.activeElement);
      if(!open && wasOpen){
        const back = opener.get(ov);
        // don't steal focus if another dialog is taking over
        if(back && document.contains(back) && !document.querySelector(".modal-overlay.open")) setTimeout(()=>{ try{ back.focus(); }catch(e){} }, 30);
      }
      wasOpen = open;
    }).observe(ov, { attributes:true, attributeFilter:["class"] });
  }
  document.addEventListener("keydown", (e)=>{
    if(e.key !== "Tab") return;
    const open = [...document.querySelectorAll(".modal-overlay.open")].pop();
    if(!open) return;
    const items = [...open.querySelectorAll(FOCUSABLE)].filter(visible);
    if(!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if(!open.contains(document.activeElement)){ e.preventDefault(); first.focus(); }
    else if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  });
})();

/* ==========================================================================
   PROFILE LIFECYCLE
   ========================================================================== */
$("lockBtn").addEventListener("click", ()=>window.FlowVault.lock());
document.addEventListener("keydown", (e)=>{
  if((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "L" || e.key === "l")){ e.preventDefault(); window.FlowVault.lock(); }
});
F.on("profile", ()=>{
  autoBackup();
  setTimeout(checkReminders, 1500);
  updateStreakChip();
});

/* ==========================================================================
   INSTALL + OFFLINE (service worker)
   ========================================================================== */
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e)=>{
  e.preventDefault(); installEvt = e;
  if(!$("installBtn")){
    const b = document.createElement("button");
    b.type = "button"; b.className = "menu-item"; b.role = "menuitem"; b.id = "installBtn"; b.textContent = "Install app";
    b.addEventListener("click", async ()=>{ if(!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; b.remove(); });
    $("moreMenu").insertBefore(b, $("settingsBtn").nextSibling);
  }
});
if("serviceWorker" in navigator && /^https?:$/.test(location.protocol)){
  // features.js loads after the unlock, i.e. possibly after the window "load" event already fired.
  const reg = ()=>navigator.serviceWorker.register("./sw.js").catch(()=>{});
  if(document.readyState === "complete") reg(); else window.addEventListener("load", reg);
}

/* ---------- Shortcut sheet additions ---------- */
(function extendShortcuts(){
  const grid = document.querySelector("#shortcutsModalOverlay .shortcut-grid");
  if(!grid) return;
  const row = (label, keys)=>`<div class="shortcut-row"><span>${label}</span><div class="keys">${keys.map(k=>`<kbd>${k}</kbd>`).join("")}</div></div>`;
  grid.insertAdjacentHTML("beforeend",
    row("Command palette", ["Ctrl","K"]) + row("Quick add", ["Q"]) + row("Switch view (board / list / calendar / today)", ["1–4"]) +
    row("Move a focused card between columns", ["Alt","←","→"]) + row("Reorder a focused card", ["Alt","↑","↓"]));
})();


F.autoLogin();

})();
