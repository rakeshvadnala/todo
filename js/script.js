(function(){
"use strict";

// All persistence goes through the encrypted vault (js/vault.js) — never raw LS.
const LS = window.FlowStore;

/* ============================================================
   STORAGE LAYER — multi-profile
   All profiles live together in one master object under MASTER_KEY.
   Each profile is keyed by a lowercased username and holds its own
   {tasks, settings}. No passwords — picking/creating a username is
   the entire "login."
   ============================================================ */
const MASTER_KEY = "flow_todo_master_v1";
const LAST_USER_KEY = "flow_last_user_v1"; // which profile to reopen on refresh
const LEGACY_KEY = "flow_todo_data_v1"; // pre-multi-profile single-user storage

function loadMaster(){
  try{
    const raw = LS.getItem(MASTER_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || typeof parsed.users !== "object" || parsed.users === null) return null;
    return parsed;
  }catch(e){
    console.error("Failed to load profile data:");
    return null;
  }
}

function defaultUserData(){
  return {
    tasks: [],
    projects: [],
    settings: {
      theme: (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark",
      sort: "manual",
      priorityFilter: "all",
      statusFilter: "all",
      projectFilter: "all",
      themeMode: null,        // "light" | "dark" | "system" (null = follow legacy `theme`)
      accent: "navy",
      palette: "slate",
      density: "comfortable", // compact | comfortable | detailed
      view: "board",          // board | list | calendar | today
      weeklyGoal: 10,
      reminders: true,        // daily due/overdue notification — on by default
      lastReminder: "",
      columns: null,          // null = default three columns
      templates: [],
      remindersSet: false,    // true once the user has chosen explicitly
      notifyTitles: true      // show task titles inside notifications
    }
  };
}

let masterState = loadMaster() || { users: {} };

// One-time migration: if this browser has data from the old single-user
// version and no profiles have been created yet, turn that old data into
// the first profile so nobody's existing tasks get lost on update.
(function migrateLegacyIfNeeded(){
  if(Object.keys(masterState.users).length > 0) return;
  try{
    const legacyRaw = LS.getItem(LEGACY_KEY);
    if(!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw);
    if(!legacy || !Array.isArray(legacy.tasks)) return;
    const displayName = (legacy.settings && legacy.settings.userName) ? legacy.settings.userName : "Me";
    const key = displayName.trim().toLowerCase() || "me";
    masterState.users[key] = {
      displayName,
      tasks: legacy.tasks,
      projects: [],
      settings: Object.assign(defaultUserData().settings, legacy.settings || {})
    };
    LS.setItem(MASTER_KEY, JSON.stringify(masterState));
  }catch(e){
    console.error("Legacy data migration failed:");
  }
})();

let currentUserKey = null;      // normalized (lowercased) profile key
let currentDisplayName = "";    // as-typed name, used for "Completed By" and UI
let state = null;               // active profile's {tasks, settings} — null until a profile is chosen

let saveTimer = null;
function saveState(){
  if(!currentUserKey || !state) return;
  masterState.users[currentUserKey].tasks = state.tasks;
  masterState.users[currentUserKey].settings = state.settings;
  masterState.users[currentUserKey].projects = state.projects || [];
  // Debounced auto-save; still effectively instant.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    try{
      LS.setItem(MASTER_KEY, JSON.stringify(masterState));
    }catch(e){
      console.error("Auto-save failed:");
      showToast("Couldn't save — storage may be full.", "error");
    }
  }, 60);
  scheduleGithubPush();
}

/* ============================================================
   UTIL
   ============================================================ */
function uid(){
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2,9);
}
function nowISO(){ return new Date().toISOString(); }

// ---- Regional settings: UAE (Dubai). Dates read DD Mon YYYY, the working
// week runs Mon–Fri, and "today" is the Gulf Standard Time (UTC+4) calendar day.
let LOCALE = "en-AE";
const TIME_ZONE = "Asia/Dubai";
let DOW_LABELS = ["Mo","Tu","We","Th","Fr","Sa","Su"];
// Local YYYY-MM-DD for a Date (toISOString would use UTC and be a day off
// between midnight and 04:00 in Dubai).
function localDateStr(d){
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function isoToLocalDay(iso){ return localDateStr(new Date(iso)); }
// Offset of the 1st of a month in a Monday-first grid.
function mondayOffset(year, month){ return (new Date(year, month, 1).getDay() + 6) % 7; }

function fmtDate(iso){
  if(!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(LOCALE, { timeZone:TIME_ZONE, day:"numeric", month:"short", year:"numeric" });
}
function fmtDateTime(iso){
  if(!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(LOCALE, { timeZone:TIME_ZONE, day:"numeric", month:"short" }) + ", " +
         d.toLocaleTimeString(LOCALE, { timeZone:TIME_ZONE, hour:"numeric", minute:"2-digit" });
}
function dueMeta(dueStr){
  if(!dueStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(dueStr + "T00:00:00");
  const diffDays = Math.round((due-today)/86400000);
  if(diffDays < 0) return { cls:"overdue", label:"Overdue · " + fmtDate(dueStr) };
  if(diffDays === 0) return { cls:"today", label:"Due today" };
  if(diffDays === 1) return { cls:"", label:"Due tomorrow" };
  return { cls:"", label:"Due " + fmtDate(dueStr) };
}
function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function debounce(fn, ms){
  let t;
  return (...args)=>{ clearTimeout(t); t = setTimeout(()=>fn(...args), ms); };
}

const PRIORITY_RANK = { high:3, medium:2, low:1 };


/* ============================================================
   TASK MODEL EXTRAS — activity log, time tracking, recurrence
   ============================================================ */
const listeners = {};
function on(name, fn){ (listeners[name] = listeners[name] || []).push(fn); }
function emit(name, data){ (listeners[name] || []).forEach(fn=>{ try{ fn(data); }catch(e){ console.error("Listener error"); } }); }

function logActivity(t, text, type){
  if(!t) return;
  t.activity = Array.isArray(t.activity) ? t.activity : [];
  t.activity.push({ id: uid(), at: nowISO(), by: currentDisplayName || "Me", type: type || "event", text });
  if(t.activity.length > 100) t.activity.splice(0, t.activity.length - 100);
}

function fmtDuration(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  if(h) return `${h}h ${String(m).padStart(2,"0")}m`;
  if(m) return `${m}m ${String(s).padStart(2,"0")}s`;
  return `${s}s`;
}
function taskElapsed(t){
  let sec = t.timeSpent || 0;
  if(t.timerStart) sec += (Date.now() - new Date(t.timerStart).getTime())/1000;
  return sec;
}
function stopTimer(t, silent){
  if(!t || !t.timerStart) return;
  const sec = Math.max(0, Math.round((Date.now() - new Date(t.timerStart).getTime())/1000));
  t.timeSpent = (t.timeSpent || 0) + sec;
  t.timeLog = Array.isArray(t.timeLog) ? t.timeLog : [];
  t.timeLog.push({ at: nowISO(), sec });
  if(t.timeLog.length > 200) t.timeLog.splice(0, t.timeLog.length - 200);
  t.timerStart = null;
  t.updatedAt = nowISO();
  if(!silent) logActivity(t, `Stopped timer (+${fmtDuration(sec)})`);
}
function toggleTimer(id){
  const t = findTask(id);
  if(!t) return;
  if(t.timerStart){
    stopTimer(t);
  } else {
    state.tasks.forEach(o=>{ if(o.timerStart) stopTimer(o); }); // one running timer at a time
    t.timerStart = nowISO();
    t.updatedAt = nowISO();
    logActivity(t, "Started timer");
  }
  saveState();
  renderBoard();
}
setInterval(()=>{
  if(!state) return;
  document.querySelectorAll("[data-timer-id]").forEach(el=>{
    const t = findTask(el.dataset.timerId);
    if(t) el.textContent = fmtDuration(taskElapsed(t));
  });
}, 1000);

// Recurrence follows the UAE working week: "weekdays" = Mon–Fri.
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function nextOccurrence(dueStr, rule){
  const today = new Date(); today.setHours(0,0,0,0);
  let base = dueStr ? new Date(dueStr + "T00:00:00") : new Date(today);
  if(base < today) base = new Date(today);
  let next;
  if(rule === "daily"){ next = addDays(base, 1); }
  else if(rule === "weekdays"){
    next = addDays(base, 1);
    while(next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
  }
  else if(rule === "weekly"){ next = addDays(base, 7); }
  else if(rule === "monthly"){
    next = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    const dim = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(base.getDate(), dim));
  } else return null;
  return localDateStr(next);
}
const RECUR_LABELS = { none:"Doesn't repeat", daily:"Every day", weekdays:"Every weekday (Mon–Fri)", weekly:"Every week", monthly:"Every month" };

function spawnRecurrence(t){
  const due = nextOccurrence(t.dueDate, t.recur);
  if(!due) return null;
  const n = {
    id: uid(), title: t.title, description: t.description || "", priority: t.priority,
    dueDate: due, status: firstColumnKey(), archived: false, order: Date.now(),
    subtasks: (t.subtasks || []).map(s=>({ ...s, id: uid(), done:false, createdAt: nowISO(), updatedAt: nowISO() })),
    projectId: t.projectId || null, recur: t.recur,
    createdAt: nowISO(), updatedAt: nowISO(), completedBy: null, completedOn: null
  };
  logActivity(n, `Created by repeat (${RECUR_LABELS[t.recur].toLowerCase()})`);
  state.tasks.unshift(n);
  t.recurSpawnedId = n.id;
  return n;
}

// Central hook: called after any code path changed a task's status. Returns an
// undo function so the existing "Undo" toasts can also reverse side effects.
function onStatusChange(t, prev){
  logActivity(t, `Moved ${colLabel(prev)} → ${colLabel(t.status)}`);
  let spawned = null;
  if(t.status === "completed"){
    if(t.timerStart) stopTimer(t, true);
    const alreadyThere = t.recurSpawnedId && state.tasks.some(x=>x.id === t.recurSpawnedId);
    if(t.recur && t.recur !== "none" && !alreadyThere){
      spawned = spawnRecurrence(t);
      if(spawned) showToast(`Repeats — next one is due ${fmtDate(spawned.dueDate + "T00:00:00")}`, "success");
    }
  }
  emit("status", { task: t, prev });
  return function undo(){
    if(spawned){
      state.tasks = state.tasks.filter(x=>x.id !== spawned.id);
      t.recurSpawnedId = null;
    }
  };
}

// Single place that builds a task, so the modal, quick add, templates and CSV import agree.
function createTask(f){
  const status = getColumns().some(c=>c.key === f.status) ? f.status : firstColumnKey();
  const t = {
    id: uid(),
    title: String(f.title || "").trim().slice(0,120),
    description: (f.description || "").trim().slice(0,1000),
    priority: ["low","medium","high"].includes(f.priority) ? f.priority : "medium",
    dueDate: f.dueDate || null,
    status, archived: false,
    order: Date.now() + Math.floor(Math.random()*1000),
    subtasks: (f.subtasks || []).map(x => typeof x === "string"
      ? { id: uid(), text: x.slice(0,200), done:false, createdAt: nowISO(), updatedAt: nowISO() }
      : x),
    projectId: f.projectId || null,
    recur: f.recur && f.recur !== "none" ? f.recur : null,
    createdAt: nowISO(), updatedAt: nowISO(), completedBy: null, completedOn: null
  };
  if(f.timeSpent) t.timeSpent = f.timeSpent;
  if(status === "completed"){ t.completedBy = currentDisplayName || "Me"; t.completedOn = nowISO(); }
  logActivity(t, "Created");
  state.tasks.unshift(t);
  return t;
}

/* ============================================================
   TOASTS
   ============================================================ */
function showToast(msg, type, actionLabel, actionFn){
  const wrap = document.getElementById("toastWrap");
  const el = document.createElement("div");
  el.className = "toast" + (type === "success" ? " success" : "");
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg><span>${escapeHtml(msg)}</span>`;
  if(actionLabel && actionFn){
    const btn = document.createElement("button");
    btn.className = "undo-btn";
    btn.textContent = actionLabel;
    btn.onclick = ()=>{ actionFn(); el.remove(); };
    el.appendChild(btn);
  }
  wrap.appendChild(el);
  // Toasts with an action (Undo) stay longer so keyboard/screen-reader users have time to reach them.
  setTimeout(()=>{
    el.style.animation = "toast-out .2s ease forwards";
    setTimeout(()=>el.remove(), 200);
  }, actionLabel ? 8000 : 3600);
}

/* ============================================================
   PROFILES — no-password multi-user switching
   ============================================================ */
function avatarColor(key){
  let hash = 0;
  for(let i=0; i<key.length; i++){ hash = key.charCodeAt(i) + ((hash << 5) - hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 32% 38%)`;
}

function normalizeKey(name){ return name.trim().toLowerCase(); }

function renderProfileList(){
  const list = document.getElementById("profileList");
  const keys = Object.keys(masterState.users);
  if(keys.length === 0){
    list.innerHTML = `<div class="profile-empty">No profiles yet — create the first one below.</div>`;
    return;
  }
  list.innerHTML = keys.map(k=>{
    const u = masterState.users[k];
    const count = (u.tasks || []).filter(t=>!t.archived).length;
    const displayName = u.displayName || k;
    const initial = displayName.trim().charAt(0).toUpperCase() || "?";
    return `<div class="profile-item">
      <button type="button" class="profile-card" data-key="${escapeHtml(k)}">
        <span class="profile-avatar" style="background:${avatarColor(k)}">${escapeHtml(initial)}</span>
        <span class="profile-info">
          <span class="profile-name">${escapeHtml(displayName)}</span>
          <span class="profile-meta">${count} active task${count===1?"":"s"}</span>
        </span>
      </button>
      <button type="button" class="icon-btn profile-delete" data-key="${escapeHtml(k)}" title="Delete profile" aria-label="Delete profile ${escapeHtml(displayName)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    </div>`;
  }).join("");
  list.querySelectorAll(".profile-card").forEach(btn=>{
    btn.addEventListener("click", ()=> selectProfile(btn.dataset.key));
  });
  list.querySelectorAll(".profile-delete").forEach(btn=>{
    btn.addEventListener("click", (e)=>{ e.stopPropagation(); confirmDeleteProfile(btn.dataset.key); });
  });
}

// Deleting a profile removes ALL of its data (tasks, archive, projects, settings)
// from this browser and, if GitHub sync is on, from the synced file. A tombstone
// is kept so a later pull/merge can't bring the profile back from another device.
let pendingDeleteProfileKey = null;
function confirmDeleteProfile(key, pinOk){
  const u = masterState.users[key];
  if(!u) return;
  pendingDeleteProfileKey = key;
  pendingDeleteId = null;
  pendingBulkDeleteIds = null;
  document.getElementById("confirmText").innerHTML =
    `Delete profile <b>"${escapeHtml(u.displayName || key)}"</b> and all of its tasks, archive and projects? This permanently erases the data and can't be undone.`;
  openOverlay("confirmModalOverlay");
}
function deleteProfile(key){
  const u = masterState.users[key];
  if(!u) return;
  const name = u.displayName || key;
  clearTimeout(saveTimer);
  delete masterState.users[key];
  try{ if(LS.getItem(LAST_USER_KEY) === key) LS.removeItem(LAST_USER_KEY); }catch(e){}
  masterState.deleted = masterState.deleted || {};
  masterState.deleted[key] = nowISO();
  if(Object.keys(masterState.users).length === 0){
    try{ LS.removeItem(LEGACY_KEY); }catch(e){}
  }
  persistMasterLocally();
  scheduleGithubPush();
  if(key === currentUserKey){
    currentUserKey = null;
    currentDisplayName = "";
    state = null;
    document.getElementById("board").innerHTML = "";
    document.getElementById("profileChipName").textContent = "";
    document.getElementById("profileChipAvatar").textContent = "";
  }
  emit("profile-deleted", { key, name });
  renderProfileList();
  document.getElementById("profileCancelBtn").style.display = currentUserKey ? "" : "none";
  showToast(`Deleted profile "${name}"`, "success");
}

function selectProfile(key, opts){
  const u = masterState.users[key];
  if(!u) return;
  currentUserKey = key;
  currentDisplayName = u.displayName || key;
  state = { tasks: u.tasks || [], projects: u.projects || [], settings: Object.assign(defaultUserData().settings, u.settings || {}) };
  if(!state.settings.remindersSet) state.settings.reminders = true;
  finishProfileSelection();
}

function registerProfile(rawName){
  const displayName = rawName.trim();
  if(!displayName){
    const input = document.getElementById("newUsernameInput");
    input.focus();
    input.style.borderColor = "var(--high)";
    setTimeout(()=>{ input.style.borderColor = ""; }, 900);
    return;
  }
  const key = normalizeKey(displayName);
  if(masterState.users[key]){
    // Someone already registered this name — just sign them in rather than erroring.
    selectProfile(key);
    return;
  }
  masterState.users[key] = Object.assign({ displayName, createdAt: nowISO() }, defaultUserData());
  currentUserKey = key;
  currentDisplayName = displayName;
  state = masterState.users[key];
  seedIfEmpty(); // brand-new profiles get the demo board; existing ones never do
  saveState();
  finishProfileSelection();
}

function finishProfileSelection(){
  document.getElementById("newUsernameInput").value = "";
  closeOverlay("profileModalOverlay");
  applyPrefs();
  syncToolbarToSettings();
  renderColumnSelects();
  renderBoard();
  updateProfileChip();
  try{ LS.setItem(LAST_USER_KEY, currentUserKey); }catch(e){}
  emit("profile", { key: currentUserKey });
}

// Reopen whoever was using the board last, so a refresh doesn't ask again.
// (A PIN-protected profile still asks for its PIN.)
function autoLogin(){
  let key = null;
  try{ key = LS.getItem(LAST_USER_KEY); }catch(e){}
  if(key && masterState.users[key] && !currentUserKey) selectProfile(key);
}

function updateProfileChip(){
  if(!currentUserKey) return;
  const initial = currentDisplayName.trim().charAt(0).toUpperCase() || "?";
  const avatar = document.getElementById("profileChipAvatar");
  avatar.textContent = initial;
  avatar.style.background = avatarColor(currentUserKey);
  document.getElementById("profileChipName").textContent = currentDisplayName;
}

function openProfileSwitcher(){
  renderProfileList();
  document.getElementById("profileCancelBtn").style.display = currentUserKey ? "" : "none";
  document.getElementById("newUsernameInput").value = "";
  openOverlay("profileModalOverlay");
  setTimeout(()=> document.getElementById("newUsernameInput").focus(), 60);
}

document.getElementById("profileChipBtn").addEventListener("click", openProfileSwitcher);
document.getElementById("profileCancelBtn").addEventListener("click", ()=> closeOverlay("profileModalOverlay"));
document.getElementById("profileContinueBtn").addEventListener("click", ()=>{
  registerProfile(document.getElementById("newUsernameInput").value);
});
document.getElementById("newUsernameInput").addEventListener("keydown", (e)=>{
  if(e.key === "Enter"){
    e.preventDefault();
    registerProfile(document.getElementById("newUsernameInput").value);
  }
});

/* ============================================================
   GITHUB SYNC
   Pushes the whole masterState (all profiles) to one JSON file in a
   GitHub repo, and pulls it back down so multiple trusted people
   sharing this board stay in sync. The token lives ONLY in this
   browser's localStorage (separate key from the task data itself)
   and is never included in the payload that gets committed.
   ============================================================ */
const SYNC_CONFIG_KEY = "flow_gh_sync_config_v1";

function loadSyncConfig(){
  try{
    const raw = LS.getItem(SYNC_CONFIG_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || !parsed.owner || !parsed.repo || !parsed.token) return null;
    return parsed;
  }catch(e){ return null; }
}
function saveSyncConfig(cfg){
  try{ LS.setItem(SYNC_CONFIG_KEY, JSON.stringify(cfg)); }
  catch(e){ console.error("Failed to save sync config:"); }
}
function clearSyncConfig(){
  try{ LS.removeItem(SYNC_CONFIG_KEY); }catch(e){}
}

let syncConfig = loadSyncConfig();
let lastKnownSha = null;      // avoids a GET before every push when we already know it
let syncPushTimer = null;
let syncInFlight = false;

function utf8ToBase64(str){
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}
function base64ToUtf8(b64){
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghFileUrl(cfg){
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
}
function ghHeaders(cfg){
  return {
    "Authorization": `Bearer ${cfg.token}`,
    "Accept": "application/vnd.github+json"
  };
}

function setSyncStatus(mode, text){
  const dot = document.getElementById("syncDot");
  dot.className = "sync-dot" + (mode ? " " + mode : "");
  const line = document.getElementById("syncStatusLine");
  if(line){
    line.textContent = text;
    line.className = "sync-status-line" + (mode === "synced" ? " ok" : mode === "error" ? " err" : "");
  }
}

// Per-task-id, last-write-wins merge of two masterState trees — used when a
// push hits a stale-SHA conflict, or on startup when both local and remote
// data exist and might have diverged.
function mergeMasterStates(local, remote){
  const merged = { users: {}, deleted: {} };
  [local.deleted, remote.deleted].forEach(d=>{
    Object.entries(d || {}).forEach(([k, ts])=>{
      if(!merged.deleted[k] || ts > merged.deleted[k]) merged.deleted[k] = ts;
    });
  });
  const allKeys = new Set([...Object.keys(local.users || {}), ...Object.keys(remote.users || {})]);
  allKeys.forEach(key=>{
    const l = local.users[key];
    const r = remote.users[key];
    // A profile deleted on any device stays deleted, unless it was re-created afterwards.
    const tomb = merged.deleted[key];
    if(tomb){
      const born = [l, r].map(u => u && u.createdAt ? u.createdAt : "").sort().pop();
      if(!born || born <= tomb) return;
    }
    if(l && !r){ merged.users[key] = l; return; }
    if(r && !l){ merged.users[key] = r; return; }
    // present in both — merge task-by-task on id, newer updatedAt wins
    const taskMap = new Map();
    (r.tasks || []).forEach(t => taskMap.set(t.id, t));
    (l.tasks || []).forEach(t => {
      const existing = taskMap.get(t.id);
      if(!existing || new Date(t.updatedAt || 0) >= new Date(existing.updatedAt || 0)){
        taskMap.set(t.id, t);
      }
    });
    // projects: union by id — a project added on either side survives, and on
    // a name collision for the same id we keep whichever side is "local" here
    // (mergeMasterStates is called with the actively-syncing browser as local).
    const projectMap = new Map();
    (r.projects || []).forEach(p => projectMap.set(p.id, p));
    (l.projects || []).forEach(p => projectMap.set(p.id, p));
    merged.users[key] = {
      displayName: l.displayName || r.displayName,
      tasks: [...taskMap.values()],
      projects: [...projectMap.values()],
      settings: l.settings || r.settings // prefer whichever browser is actively merging for UI prefs
    };
  });
  return merged;
}

async function pullFromGitHub(opts){
  opts = opts || {};
  if(!syncConfig) return;
  try{
    if(!opts.silent) setSyncStatus("syncing", "Pulling latest…");
    const res = await fetch(`${ghFileUrl(syncConfig)}?ref=${encodeURIComponent(syncConfig.branch || "main")}`, {
      headers: ghHeaders(syncConfig)
    });
    if(res.status === 404){
      lastKnownSha = null;
      if(!opts.silent) setSyncStatus("synced", "No data on GitHub yet — first sync will create it.");
      return;
    }
    if(!res.ok){
      const msg = res.status === 401 ? "Invalid token." : res.status === 403 ? "Forbidden — check token permissions or rate limit." : `GitHub error (${res.status}).`;
      setSyncStatus("error", msg);
      if(!opts.silent) showToast("Pull failed: " + msg, "error");
      return;
    }
    const data = await res.json();
    lastKnownSha = data.sha;
    let remote;
    try{
      remote = await window.FlowVault.decryptRemote(base64ToUtf8(data.content));
    }catch(err){
      if(err && err.legacyPlaintext){ remote = err.value; }     // old unencrypted file: read once, re-pushed encrypted
      else if(err && err.code === "DIFFERENT_VAULT"){
        setSyncStatus("error", "The GitHub file was encrypted with a different vault.");
        if(!opts.silent) showToast("Can't decrypt the GitHub file — it belongs to a different vault. Restore it from the lock screen.", "error");
        return;
      } else throw new Error("Malformed remote data");
    }
    if(!remote || typeof remote.users !== "object") throw new Error("Malformed remote data");

    masterState = mergeMasterStates(masterState, remote);
    persistMasterLocally();

    // Refresh whatever's currently on screen with the merged data
    if(currentUserKey && masterState.users[currentUserKey]){
      const u = masterState.users[currentUserKey];
      state = { tasks: u.tasks || [], projects: u.projects || [], settings: Object.assign(defaultUserData().settings, u.settings || {}) };
      renderBoard();
    }
    if(currentUserKey && !masterState.users[currentUserKey]){
      currentUserKey = null; currentDisplayName = ""; state = null;
      document.getElementById("board").innerHTML = "";
      openProfileSwitcher();
    }
    if(document.getElementById("profileModalOverlay").classList.contains("open")){
      renderProfileList();
    }
    setSyncStatus("synced", "Synced just now.");
    if(!opts.silent) showToast("Pulled latest data from GitHub", "success");
  }catch(e){
    console.error("GitHub pull failed:");
    setSyncStatus("error", "Pull failed — see console for details.");
    if(!opts.silent) showToast("Pull failed — check your connection and settings.", "error");
  }
}

function persistMasterLocally(){
  try{ LS.setItem(MASTER_KEY, JSON.stringify(masterState)); }
  catch(e){ console.error("Local save during sync failed:"); }
}

async function pushToGitHub(opts, isRetry){
  opts = opts || {};
  if(!syncConfig || syncInFlight) return;
  syncInFlight = true;
  if(!opts.silent) setSyncStatus("syncing", "Syncing…");
  else setSyncStatus("syncing", "Auto-syncing…");
  try{
    const body = {
      message: `Update board data — ${new Date().toISOString()}`,
      content: utf8ToBase64(await window.FlowVault.encryptRemote(masterState)),
      branch: syncConfig.branch || "main"
    };
    if(lastKnownSha) body.sha = lastKnownSha;

    const res = await fetch(ghFileUrl(syncConfig), {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders(syncConfig)),
      body: JSON.stringify(body)
    });

    if(res.status === 409 && !isRetry){
      // stale sha — someone else pushed since our last pull; merge and retry once
      syncInFlight = false;
      await pullFromGitHub({ silent: true });
      await pushToGitHub(opts, true);
      return;
    }
    if(!res.ok){
      const msg = res.status === 401 ? "Invalid token." : res.status === 403 ? "Forbidden — check token permissions or rate limit." : `GitHub error (${res.status}).`;
      setSyncStatus("error", msg);
      if(!opts.silent) showToast("Sync failed: " + msg, "error");
      return;
    }
    const data = await res.json();
    lastKnownSha = data.content ? data.content.sha : lastKnownSha;
    setSyncStatus("synced", "Synced just now.");
    if(!opts.silent) showToast("Synced to GitHub", "success");
  }catch(e){
    console.error("GitHub push failed:");
    setSyncStatus("error", "Sync failed — check your connection.");
    if(!opts.silent) showToast("Sync failed — check your connection and settings.", "error");
  }finally{
    syncInFlight = false;
  }
}

// Called from saveState() after every local change; batches rapid edits
// into one push a few seconds after things go quiet, instead of a
// commit-per-keystroke.
function scheduleGithubPush(){
  if(!syncConfig || !syncConfig.autoSync) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(()=> pushToGitHub({ silent: true }), 3000);
}

function openSyncModal(){
  const cfg = syncConfig || {};
  document.getElementById("ghOwnerInput").value = cfg.owner || "";
  document.getElementById("ghRepoInput").value = cfg.repo || "";
  document.getElementById("ghBranchInput").value = cfg.branch || "main";
  document.getElementById("ghPathInput").value = cfg.path || "data/flow-board.json";
  document.getElementById("ghTokenInput").value = cfg.token || "";
  document.getElementById("ghAutoSyncInput").checked = cfg.autoSync !== false;
  setSyncStatus(syncConfig ? "synced" : "", syncConfig ? "Connected." : "Not connected yet.");
  openOverlay("syncModalOverlay");
}

document.getElementById("syncBtn").addEventListener("click", openSyncModal);
document.getElementById("syncModalClose").addEventListener("click", ()=>closeOverlay("syncModalOverlay"));

document.getElementById("ghSaveBtn").addEventListener("click", async ()=>{
  const owner = document.getElementById("ghOwnerInput").value.trim();
  const repo = document.getElementById("ghRepoInput").value.trim();
  const branch = document.getElementById("ghBranchInput").value.trim() || "main";
  const path = document.getElementById("ghPathInput").value.trim() || "data/flow-board.json";
  const token = document.getElementById("ghTokenInput").value.trim();
  const autoSync = document.getElementById("ghAutoSyncInput").checked;

  if(!owner || !repo || !token){
    setSyncStatus("error", "Owner, repo, and token are all required.");
    return;
  }
  syncConfig = { owner, repo, branch, path, token, autoSync };
  saveSyncConfig(syncConfig);
  lastKnownSha = null;
  await pullFromGitHub({ silent: true });   // adopt anything already out there first
  await pushToGitHub({ silent: false });    // then publish current local state
});

document.getElementById("ghPullBtn").addEventListener("click", ()=>{
  const owner = document.getElementById("ghOwnerInput").value.trim();
  const repo = document.getElementById("ghRepoInput").value.trim();
  const token = document.getElementById("ghTokenInput").value.trim();
  if(!owner || !repo || !token){
    setSyncStatus("error", "Owner, repo, and token are all required.");
    return;
  }
  syncConfig = {
    owner, repo, token,
    branch: document.getElementById("ghBranchInput").value.trim() || "main",
    path: document.getElementById("ghPathInput").value.trim() || "data/flow-board.json",
    autoSync: document.getElementById("ghAutoSyncInput").checked
  };
  pullFromGitHub({ silent: false });
});

document.getElementById("ghDisconnectBtn").addEventListener("click", ()=>{
  clearSyncConfig();
  syncConfig = null;
  lastKnownSha = null;
  setSyncStatus("", "Not connected yet.");
  document.getElementById("ghTokenInput").value = "";
  showToast("Disconnected from GitHub sync", "success");
});

/* ============================================================
   PROJECTS — free-form, per-profile grouping for tasks
   ============================================================ */
function ensureProjectsArray(){
  if(!Array.isArray(state.projects)) state.projects = [];
}

function projectColor(id){
  let hash = 0;
  for(let i=0; i<id.length; i++){ hash = id.charCodeAt(i) + ((hash << 5) - hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 48%)`;
}

function findProject(id){
  if(!id) return null;
  return (state.projects || []).find(p => p.id === id) || null;
}

function sortedProjects(){
  return (state.projects || []).slice().sort((a,b)=> a.name.localeCompare(b.name));
}

function addProject(name){
  const trimmed = (name || "").trim();
  if(!trimmed) return null;
  ensureProjectsArray();
  const existing = state.projects.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  if(existing) return existing;
  const proj = { id: uid(), name: trimmed.slice(0,60) };
  state.projects.push(proj);
  saveState();
  return proj;
}

function renameProject(id, newName){
  const p = findProject(id);
  if(!p) return;
  const trimmed = (newName || "").trim();
  if(!trimmed || trimmed === p.name) return;
  p.name = trimmed.slice(0,60);
  saveState();
  renderBoard();
  renderProjectFilterSelect();
}

function deleteProject(id){
  const p = findProject(id);
  if(!p) return;
  const affectedIds = state.tasks.filter(t => t.projectId === id).map(t => t.id);
  state.projects = state.projects.filter(pr => pr.id !== id);
  state.tasks.forEach(t => { if(t.projectId === id) t.projectId = null; });
  if(state.settings.projectFilter === id) state.settings.projectFilter = "all";
  saveState();
  renderBoard();
  renderProjectFilterSelect();
  renderManageProjectsList();
  showToast(`Deleted project "${p.name}"`, "success", "Undo", ()=>{
    state.projects.push(p);
    state.tasks.forEach(t => { if(affectedIds.includes(t.id)) t.projectId = id; });
    saveState();
    renderBoard();
    renderProjectFilterSelect();
    renderManageProjectsList();
  });
}

// Rebuilds a <select>'s <option> list from the current project list, keeping
// `selectedId` selected if it still exists. Also nudges the custom-dropdown
// UI (see custom-ui.js) since programmatic option changes don't fire 'change'.
function renderProjectSelectOptions(selectEl, selectedId){
  const projects = sortedProjects();
  selectEl.innerHTML = `<option value="">No project</option>` +
    projects.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  selectEl.value = (selectedId && projects.some(p => p.id === selectedId)) ? selectedId : "";
  const inst = window.customSelectRegistry && window.customSelectRegistry[selectEl.id];
  if(inst) inst.refresh();
}

function renderProjectFilterSelect(){
  const sel = document.getElementById("projectFilterSelect");
  if(!sel) return;
  const projects = sortedProjects();
  const current = state.settings.projectFilter || "all";
  sel.innerHTML = `<option value="all">All projects</option><option value="none">No project</option>` +
    projects.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  sel.value = (current === "all" || current === "none" || projects.some(p => p.id === current)) ? current : "all";
  const inst = window.customSelectRegistry && window.customSelectRegistry["projectFilterSelect"];
  if(inst) inst.refresh();
}

function renderManageProjectsList(){
  const list = document.getElementById("projectManageList");
  const projects = sortedProjects();
  if(projects.length === 0){
    list.innerHTML = `<div class="project-empty">No projects yet — add one below.</div>`;
    return;
  }
  list.innerHTML = projects.map(p=>{
    const count = state.tasks.filter(t => !t.archived && t.projectId === p.id).length;
    return `<div class="project-row" data-id="${escapeHtml(p.id)}">
      <span class="project-dot" style="--proj-color:${projectColor(p.id)}"></span>
      <input type="text" class="project-row-name" value="${escapeHtml(p.name)}" maxlength="60">
      <span class="project-row-meta">${count} task${count===1?"":"s"}</span>
      <button type="button" class="project-row-delete" title="Delete project">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    </div>`;
  }).join("");

  list.querySelectorAll(".project-row-name").forEach(input=>{
    const commit = ()=> renameProject(input.closest(".project-row").dataset.id, input.value);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e)=>{
      if(e.key === "Enter"){ e.preventDefault(); input.blur(); }
    });
  });
  list.querySelectorAll(".project-row-delete").forEach(btn=>{
    btn.addEventListener("click", ()=> deleteProject(btn.closest(".project-row").dataset.id));
  });
}

function openManageProjectsModal(){
  renderManageProjectsList();
  document.getElementById("newProjectNameInput").value = "";
  openOverlay("projectsModalOverlay");
}

document.getElementById("manageProjectsBtn").addEventListener("click", openManageProjectsModal);
document.getElementById("projectsModalClose").addEventListener("click", ()=>closeOverlay("projectsModalOverlay"));
document.getElementById("addProjectBtn").addEventListener("click", ()=>{
  const input = document.getElementById("newProjectNameInput");
  const proj = addProject(input.value);
  if(proj){
    input.value = "";
    renderManageProjectsList();
    renderProjectFilterSelect();
  }
});
document.getElementById("newProjectNameInput").addEventListener("keydown", (e)=>{
  if(e.key === "Enter"){
    e.preventDefault();
    document.getElementById("addProjectBtn").click();
  }
});

/* ============================================================
   RENDER: BOARD
   ============================================================ */
const DEFAULT_COLUMNS = [
  { key:"daily", label:"Daily", dot:"daily" },
  { key:"inprogress", label:"In Progress", dot:"inprogress" },
  { key:"completed", label:"Completed", dot:"completed" }
];
// Columns are per-profile. "completed" is the permanent done column; the rest can be
// renamed, reordered, added and removed from Settings.
function getColumns(){
  const c = state && state.settings && state.settings.columns;
  return Array.isArray(c) && c.length ? c : DEFAULT_COLUMNS;
}
function colByKey(key){ return getColumns().find(c=>c.key === key); }
function colLabel(key){ const c = colByKey(key); return c ? c.label : key; }
function firstColumnKey(){ return getColumns()[0].key; }
function setColumns(cols){
  const valid = new Set(cols.map(c=>c.key));
  const fallback = cols[0].key;
  state.tasks.forEach(t=>{ if(!valid.has(t.status)){ t.status = fallback; t.updatedAt = nowISO(); } });
  state.settings.columns = cols;
  if(state.settings.statusFilter !== "all" && !valid.has(state.settings.statusFilter)) state.settings.statusFilter = "all";
  saveState();
  renderColumnSelects();
  renderBoard();
}
// Rebuild the <select>s that list columns (filter, bulk move, task modal).
function renderColumnSelects(){
  const cols = getColumns();
  const fill = (id, head)=>{
    const sel = document.getElementById(id);
    if(!sel) return;
    const cur = sel.value;
    sel.innerHTML = (head ? `<option value="${head[0]}">${escapeHtml(head[1])}</option>` : "") +
      cols.map(c=>`<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join("");
    if([...sel.options].some(o=>o.value === cur)) sel.value = cur;
    const inst = window.customSelectRegistry && window.customSelectRegistry[id];
    if(inst) inst.refresh();
  };
  fill("statusFilterSelect", ["all","All columns"]);
  fill("bulkMoveSelect", ["","Move to…"]);
  fill("statusInput", null);
}

const boardEl = document.getElementById("board");
const searchInput = document.getElementById("searchInput");
const resultCountEl = document.getElementById("resultCount");

function getVisibleTasks(){
  const q = searchInput.value.trim().toLowerCase();
  const pf = state.settings.priorityFilter;
  const prf = state.settings.projectFilter || "all";
  return state.tasks.filter(t=>{
    if(t.archived) return false;
    if(pf !== "all" && t.priority !== pf) return false;
    if(prf === "none" && t.projectId) return false;
    if(prf !== "all" && prf !== "none" && t.projectId !== prf) return false;
    if(q){
      const hay = (t.title + " " + (t.description||"")).toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}

function sortTasks(tasks){
  const mode = state.settings.sort;
  const arr = tasks.slice();
  arr.sort((a,b)=>{
    switch(mode){
      case "manual": return (a.order ?? 0) - (b.order ?? 0);
      case "created_asc": return new Date(a.createdAt) - new Date(b.createdAt);
      case "created_desc": return new Date(b.createdAt) - new Date(a.createdAt);
      case "due_asc": {
        if(!a.dueDate && !b.dueDate) return (a.order ?? 0) - (b.order ?? 0);
        if(!a.dueDate) return 1;
        if(!b.dueDate) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
      }
      case "due_desc": {
        if(!a.dueDate && !b.dueDate) return (a.order ?? 0) - (b.order ?? 0);
        if(!a.dueDate) return 1;
        if(!b.dueDate) return -1;
        return new Date(b.dueDate) - new Date(a.dueDate);
      }
      case "priority_desc": return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || (a.order ?? 0) - (b.order ?? 0);
      case "priority_asc": return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.order ?? 0) - (b.order ?? 0);
      default: return (a.order ?? 0) - (b.order ?? 0);
    }
  });
  return arr;
}

const expandedCardIds = new Set(); // session-only UI state: which cards have their checklist open
let selectMode = false; // whether bulk-select mode is active
const selectedTaskIds = new Set(); // ids currently selected while in bulk-select mode

function subtaskPanelHTML(t){
  const subs = t.subtasks || [];
  if(subs.length === 0) return "";
  const done = subs.filter(s=>s.done).length;
  const pct = Math.round((done / subs.length) * 100);
  const expanded = expandedCardIds.has(t.id);
  return `
    <div class="subtask-panel">
      <button type="button" class="subtask-summary" data-id="${t.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        <span>${done}/${subs.length} subtasks</span>
        <svg class="chevron ${expanded ? "open" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="subtask-mini-progress"><div style="width:${pct}%"></div></div>
      ${expanded ? `<div class="subtask-checklist">
        ${subs.map(s => `
          <label class="subtask-check-row" title="${subtaskTimestampTitle(s)}">
            <input type="checkbox" data-task-id="${t.id}" data-sub-id="${s.id}" ${s.done ? "checked" : ""}>
            <span class="${s.done ? "done" : ""}">${escapeHtml(s.text)}</span>
          </label>
        `).join("")}
      </div>` : ""}
    </div>`;
}

function subtaskTimestampTitle(s){
  const parts = [];
  if(s.createdAt) parts.push(`Added ${fmtDateTime(s.createdAt)}`);
  if(s.updatedAt && s.updatedAt !== s.createdAt) parts.push(`Updated ${fmtDateTime(s.updatedAt)}`);
  return escapeHtml(parts.join(" · "));
}

function cardHTML(t){
  const due = dueMeta(t.dueDate);
  const isDone = t.status === "completed";
  const proj = t.projectId ? findProject(t.projectId) : null;
  const isSelected = selectedTaskIds.has(t.id);
  return `
  <div class="card priority-${t.priority}${isDone ? " done" : ""}${isSelected ? " selected" : ""}" data-id="${t.id}" tabindex="0" role="group" aria-label="${escapeHtml(t.title)}">
    ${selectMode ? `<label class="card-select-check">
      <input type="checkbox" class="bulk-select-checkbox" data-id="${t.id}" ${isSelected ? "checked" : ""}>
    </label>` : ""}
    <div class="card-top">
      ${checkButtonHTML(t)}
      <div class="card-title">${escapeHtml(t.title)}</div>
      <span class="pri-chip priority-${t.priority}">${t.priority}</span>
    </div>
    ${proj ? `<div class="project-chip" style="--proj-color:${projectColor(proj.id)}">${escapeHtml(proj.name)}</div>` : ""}
    ${t.description ? `<div class="card-desc">${escapeHtml(t.description)}</div>` : ""}
    <div class="card-meta">
      ${due ? `<span class="meta-item due-chip ${due.cls}">${escapeHtml(due.label)}</span>` : ""}
      ${cardExtrasHTML(t)}
      <span class="meta-item meta-created" title="Created">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
        ${fmtDateTime(t.createdAt)}
      </span>
      ${t.updatedAt !== t.createdAt ? `<span class="meta-item meta-updated" title="Last updated">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
        ${fmtDateTime(t.updatedAt)}
      </span>` : ""}
    </div>
    ${subtaskPanelHTML(t)}
    ${isDone ? `<div class="completion-box">
        ✓ Completed by <b>${escapeHtml(t.completedBy || "Unknown")}</b><br>
        on ${fmtDateTime(t.completedOn)}
      </div>` : ""}
    <div class="card-actions">
      <button class="edit-btn" data-id="${t.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Edit</button>
      ${isDone ? `<button class="archive-one-btn" data-id="${t.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/></svg>Archive</button>` : ""}
      <button class="delete-btn danger" data-id="${t.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>Delete</button>
    </div>
  </div>`;
}

function emptyColHTML(){
  return `<div class="empty-col">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12h6M12 9v6"/></svg>
    <span>Nothing here. Drag a task over, or add a new one.</span>
  </div>`;
}

function updateOverallProgress(totalActive){
  const doneCount = state.tasks.filter(t=>!t.archived && t.status === "completed").length;
  const pct = totalActive === 0 ? 0 : Math.round((doneCount / totalActive) * 100);
  const isComplete = totalActive > 0 && doneCount === totalActive;

  const fillEl = document.getElementById("opFill");
  const pctEl = document.getElementById("opPct");
  const statsEl = document.getElementById("opStats");

  fillEl.style.width = pct + "%";
  const track = fillEl.parentElement;
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", "Overall completion");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(pct));
  fillEl.classList.toggle("complete", isComplete);
  pctEl.classList.toggle("complete", isComplete);
  pctEl.textContent = pct + "%";
  statsEl.textContent = totalActive === 0
    ? "No active tasks yet"
    : `${doneCount} of ${totalActive} task${totalActive===1?"":"s"} completed`;
}


const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
};
const RECUR_SHORT = { daily:"Daily", weekdays:"Weekdays", weekly:"Weekly", monthly:"Monthly" };

function checkButtonHTML(t){
  const done = t.status === "completed";
  const label = done ? "Mark as not done" : "Mark as done";
  return `<button type="button" class="card-check${done ? " checked" : ""}" data-id="${t.id}" role="checkbox" aria-checked="${done}" aria-label="${label}" title="${label}">${ICON.check}</button>`;
}
function timerHTML(t){
  const done = t.status === "completed";
  const running = !!t.timerStart;
  const total = taskElapsed(t);
  if(done && !total) return "";
  if(done) return `<span class="meta-item time-static" title="Time tracked">${fmtDuration(total)}</span>`;
  return `<button type="button" class="meta-item timer-btn${running ? " running" : ""}${!running && !total ? " idle" : ""}" data-id="${t.id}" title="${running ? "Stop timer" : "Start timer"}" aria-label="${running ? "Stop timer" : "Start timer"}">${running ? ICON.pause : ICON.play}<span data-timer-id="${t.id}">${fmtDuration(total)}</span></button>`;
}
function cardExtrasHTML(t){
  const comments = (t.activity || []).filter(a=>a.type === "comment").length;
  return (t.recur && RECUR_SHORT[t.recur]
      ? `<span class="meta-item recur-badge" title="${escapeHtml(RECUR_LABELS[t.recur])}">${ICON.repeat}${RECUR_SHORT[t.recur]}</span>` : "") +
    timerHTML(t) +
    (comments ? `<span class="meta-item" title="Comments">${ICON.comment}${comments}</span>` : "");
}

/* ============================================================
   VIEWS — board (default), list, calendar, today
   ============================================================ */
const VIEWS = ["board","list","calendar","today"];
let viewCalY = new Date().getFullYear(), viewCalM = new Date().getMonth();

function noResultsHTML(msg){
  return `<div class="no-results"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><span>${escapeHtml(msg)}</span></div>`;
}

function listRowHTML(t){
  const due = dueMeta(t.dueDate);
  const proj = t.projectId ? findProject(t.projectId) : null;
  const done = t.status === "completed";
  return `<div class="list-row priority-${t.priority}${done ? " done" : ""}" data-id="${t.id}" tabindex="0" role="row">
    <div class="lr-check">${checkButtonHTML(t)}</div>
    <div class="lr-title">
      <span class="lr-name">${escapeHtml(t.title)}</span>
      ${proj ? `<span class="project-chip" style="--proj-color:${projectColor(proj.id)}">${escapeHtml(proj.name)}</span>` : ""}
      ${t.recur && RECUR_SHORT[t.recur] ? `<span class="meta-item recur-badge">${ICON.repeat}${RECUR_SHORT[t.recur]}</span>` : ""}
    </div>
    <div class="lr-pri"><span class="pri-chip priority-${t.priority}">${t.priority}</span></div>
    <div class="lr-col">${escapeHtml(colLabel(t.status))}</div>
    <div class="lr-due">${due ? `<span class="due-chip ${due.cls}">${escapeHtml(due.label.replace(/^Due /,""))}</span>` : `<span class="lr-none">—</span>`}</div>
    <div class="lr-time">${timerHTML(t) || `<span class="lr-none">—</span>`}</div>
    <div class="lr-actions">
      <button type="button" class="icon-btn edit-btn" data-id="${t.id}" title="Edit" aria-label="Edit ${escapeHtml(t.title)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
      <button type="button" class="icon-btn delete-btn" data-id="${t.id}" title="Delete" aria-label="Delete ${escapeHtml(t.title)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
    </div>
  </div>`;
}
function renderListView(visible){
  const rows = sortTasks(visible);
  if(!rows.length){ boardEl.innerHTML = noResultsHTML("No tasks match your filters."); return; }
  boardEl.innerHTML = `<div class="list-wrap" role="table">
    <div class="list-head" role="row"><span></span><span>Task</span><span>Priority</span><span>Column</span><span>Due</span><span>Time</span><span></span></div>
    ${rows.map(listRowHTML).join("")}
  </div>`;
  boardEl.querySelectorAll(".list-row").forEach(row=>{
    row.addEventListener("click", (e)=>{
      if(e.target.closest("button")) return;
      openTaskModal(row.dataset.id);
    });
    row.addEventListener("keydown", (e)=>{
      if(e.target !== row) return;
      if(e.key === "Enter") openTaskModal(row.dataset.id);
      if(e.key === "Delete") confirmDeleteTask(row.dataset.id);
    });
  });
}

function renderTodayView(visible){
  const todayStr = localDateStr(new Date());
  const active = visible.filter(t=>t.status !== "completed");
  const overdue = active.filter(t=>t.dueDate && t.dueDate < todayStr);
  const dueToday = active.filter(t=>t.dueDate === todayStr);
  const used = new Set([...overdue, ...dueToday].map(t=>t.id));
  const doing = active.filter(t=>!used.has(t.id) && t.status !== firstColumnKey());
  const doneToday = visible.filter(t=>t.status === "completed" && t.completedOn && isoToLocalDay(t.completedOn) === todayStr);
  const groups = [
    { label:"Overdue", tasks: sortTasks(overdue), color:"var(--high)" },
    { label:"Due today", tasks: sortTasks(dueToday), color:"var(--med)" },
    { label:"In progress", tasks: sortTasks(doing), color:"var(--col-daily)" },
    { label:"Done today", tasks: sortTasks(doneToday), color:"var(--low)" }
  ].filter(g=>g.tasks.length);
  if(!groups.length){ boardEl.innerHTML = noResultsHTML("Nothing is due today. Enjoy the quiet."); return; }
  boardEl.innerHTML = groups.map(g=>`
    <section class="column today-group">
      <div class="column-head">
        <span class="col-dot" style="background:${g.color}"></span>
        <span class="column-title">${g.label}</span>
        <span class="column-count">${g.tasks.length}</span>
      </div>
      <div class="column-progress"></div>
      <div class="tasklist">${g.tasks.map(cardHTML).join("")}</div>
    </section>`).join("");
}

function renderCalendarView(visible){
  const pad = n => String(n).padStart(2,"0");
  const y = viewCalY, m = viewCalM;
  const dim = new Date(y, m + 1, 0).getDate();
  const todayStr = localDateStr(new Date());
  const byDay = {};
  const unscheduled = [];
  visible.forEach(t=>{
    if(!t.dueDate){ if(t.status !== "completed") unscheduled.push(t); return; }
    (byDay[t.dueDate] = byDay[t.dueDate] || []).push(t);
  });
  const chip = t => `<button type="button" class="cv-chip priority-${t.priority}${t.status === "completed" ? " done" : ""}" data-id="${t.id}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</button>`;
  let cells = "";
  for(let i=0;i<mondayOffset(y,m);i++) cells += `<div class="cv-cell empty"></div>`;
  for(let d=1; d<=dim; d++){
    const ds = `${y}-${pad(m+1)}-${pad(d)}`;
    const list = sortTasks(byDay[ds] || []);
    const shown = list.slice(0,3);
    cells += `<div class="cv-cell${ds === todayStr ? " today" : ""}" data-date="${ds}" tabindex="0" role="button" aria-label="Add a task due ${ds}">
      <span class="cv-day">${d}</span>
      ${shown.map(chip).join("")}
      ${list.length > 3 ? `<span class="cv-more">+${list.length - 3} more</span>` : ""}
    </div>`;
  }
  const monthLabel = new Date(y, m, 1).toLocaleDateString(LOCALE, { month:"long", year:"numeric" });
  boardEl.innerHTML = `<div class="cv">
    <div class="cv-head">
      <button type="button" class="icon-btn" id="vcPrev" title="Previous month" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
      <h2 class="cv-title">${monthLabel}</h2>
      <button type="button" class="icon-btn" id="vcNext" title="Next month" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>
      <button type="button" class="btn ghost" id="vcToday">Today</button>
    </div>
    <div class="cv-grid cv-dow">${DOW_LABELS.map(d=>`<div>${d}</div>`).join("")}</div>
    <div class="cv-grid cv-body">${cells}</div>
    ${unscheduled.length ? `<div class="cv-unscheduled"><b>No due date</b> ${sortTasks(unscheduled).map(chip).join("")}</div>` : ""}
  </div>`;
  const shift = n => { const d = new Date(y, m + n, 1); viewCalY = d.getFullYear(); viewCalM = d.getMonth(); renderBoard(); };
  document.getElementById("vcPrev").onclick = ()=>shift(-1);
  document.getElementById("vcNext").onclick = ()=>shift(1);
  document.getElementById("vcToday").onclick = ()=>{ viewCalY = new Date().getFullYear(); viewCalM = new Date().getMonth(); renderBoard(); };
  boardEl.querySelectorAll(".cv-chip").forEach(b=> b.addEventListener("click", (e)=>{ e.stopPropagation(); openTaskModal(b.dataset.id); }));
  boardEl.querySelectorAll(".cv-cell[data-date]").forEach(c=>{
    c.addEventListener("click", (e)=>{
      if(e.target.closest(".cv-chip")) return;
      openTaskModal(null, null, c.dataset.date);
    });
    c.addEventListener("keydown", (e)=>{
      if(e.target === c && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); openTaskModal(null, null, c.dataset.date); }
    });
  });
}

function renderProjectTabs(){
  const wrap = document.querySelector("#projectTabs .ptabs-list");
  if(!wrap) return;
  const cur = state.settings.projectFilter || "all";
  const act = state.tasks.filter(t=>!t.archived);
  const none = act.filter(t=>!t.projectId).length;
  const projects = sortedProjects();
  const tab = (val, label, n, color)=>`<button type="button" class="ptab${cur === val ? " active" : ""}" aria-pressed="${cur === val}" data-project="${escapeHtml(val)}">${color ? `<i class="ptab-dot" style="background:${color}"></i>` : ""}${escapeHtml(label)}<span class="ptab-n">${n}</span></button>`;
  wrap.innerHTML = tab("all","All",act.length) +
    (none && projects.length ? tab("none","No project",none) : "") +
    projects.map(p=>tab(p.id, p.name, act.filter(t=>t.projectId === p.id).length, projectColor(p.id))).join("");
}
document.getElementById("projectTabs").addEventListener("click", (e)=>{
  const b = e.target.closest(".ptab");
  if(!b || !state) return;
  state.settings.projectFilter = b.dataset.project;
  const sel = document.getElementById("projectFilterSelect");
  if(sel){ sel.value = b.dataset.project; const inst = window.customSelectRegistry && window.customSelectRegistry.projectFilterSelect; if(inst) inst.refresh(); }
  saveState();
  renderBoard();
});

function updateViewControls(){
  const v = state.settings.view || "board";
  document.querySelectorAll("#viewSeg button").forEach(b=>{
    const on = b.dataset.view === v;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const sel = document.getElementById("bulkSelectToggleBtn");
  if(sel) sel.style.display = (v === "board" || v === "today") ? "" : "none";
  const dens = state.settings.density || "comfortable";
  ["compact","comfortable","detailed"].forEach(d=>document.body.classList.toggle("density-" + d, d === dens));
  const db = document.getElementById("densityBtn");
  if(db){ db.title = "Card density: " + dens; db.setAttribute("aria-label", "Card density: " + dens); db.dataset.density = dens; }
}
function setView(v){
  if(!VIEWS.includes(v) || !state) return;
  if(selectMode && (v === "list" || v === "calendar")) exitSelectMode();
  state.settings.view = v;
  saveState();
  renderBoard();
}
function cycleDensity(){
  const order = ["compact","comfortable","detailed"];
  const cur = state.settings.density || "comfortable";
  state.settings.density = order[(order.indexOf(cur) + 1) % order.length];
  saveState();
  renderBoard();
  showToast("Card density: " + state.settings.density, "success");
}
document.getElementById("viewSeg").addEventListener("click", (e)=>{
  const b = e.target.closest("button[data-view]");
  if(b) setView(b.dataset.view);
});
document.getElementById("densityBtn").addEventListener("click", ()=>{ if(state) cycleDensity(); });

function renderBoard(){
  const visible = getVisibleTasks();
  const q = searchInput.value.trim();
  const view = state.settings.view || "board";
  document.body.dataset.view = view;
  boardEl.className = "board view-" + view;
  renderProjectTabs();
  updateViewControls();

  if(view !== "board"){
    const totalActive = state.tasks.filter(t=>!t.archived).length;
    updateOverallProgress(totalActive);
    if(view === "list") renderListView(visible);
    else if(view === "calendar") renderCalendarView(visible);
    else renderTodayView(visible);
    resultCountEl.textContent = q || state.settings.priorityFilter !== "all"
      ? `${visible.length} task${visible.length===1?"":"s"} shown`
      : `${totalActive} active tasks`;
    attachCardListeners();
    emit("render");
    return;
  }

  boardEl.innerHTML = "";
  let totalShown = 0;

  const totalActive = state.tasks.filter(t=>!t.archived).length;
  updateOverallProgress(totalActive);
  const sf = state.settings.statusFilter;
  const columnsToRender = sf === "all" ? getColumns() : getColumns().filter(c=>c.key === sf);
  boardEl.classList.toggle("single-col", sf !== "all");

  columnsToRender.forEach(col=>{
    const colTasks = sortTasks(visible.filter(t=>t.status === col.key));
    totalShown += colTasks.length;
    const allInStatus = state.tasks.filter(t=>!t.archived && t.status === col.key).length;
    const shareOfBoard = totalActive === 0 ? 0 : Math.round((allInStatus/totalActive)*100);

    const colEl = document.createElement("section");
    colEl.className = "column";
    colEl.dataset.status = col.key;
    colEl.innerHTML = `
      <div class="column-head">
        <span class="col-dot ${col.dot || ""}"${col.color ? ` style="background:${col.color}"` : ""}></span>
        <span class="column-title">${escapeHtml(col.label)}</span>
        <span class="column-count">${allInStatus}</span>
      </div>
      <div class="column-progress" title="${shareOfBoard}% of active tasks"><div style="width:${shareOfBoard}%"></div></div>
      <div class="tasklist" data-status="${col.key}">
        ${colTasks.length ? colTasks.map(cardHTML).join("") : (q ? "" : emptyColHTML())}
        ${colTasks.length === 0 && q ? `<div class="empty-col"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><span>No matches in ${escapeHtml(col.label)}.</span></div>` : ""}
      </div>
    `;
    boardEl.appendChild(colEl);
  });

  resultCountEl.textContent = q || state.settings.priorityFilter !== "all"
    ? `${totalShown} task${totalShown===1?"":"s"} shown`
    : `${state.tasks.filter(t=>!t.archived).length} active tasks`;

  attachCardListeners();
  attachDnD();
  emit("render");
}

/* ============================================================
   CARD ACTIONS
   ============================================================ */
function attachCardListeners(){
  document.querySelectorAll(".edit-btn").forEach(btn=>{
    btn.addEventListener("click", (e)=>{ e.stopPropagation(); openTaskModal(btn.dataset.id); });
  });
  document.querySelectorAll(".delete-btn").forEach(btn=>{
    btn.addEventListener("click", (e)=>{ e.stopPropagation(); confirmDeleteTask(btn.dataset.id); });
  });
  document.querySelectorAll(".archive-one-btn").forEach(btn=>{
    btn.addEventListener("click", (e)=>{ e.stopPropagation(); archiveTask(btn.dataset.id); });
  });
  document.querySelectorAll(".card").forEach(card=>{
    card.addEventListener("dblclick", ()=>{ if(!selectMode) openTaskModal(card.dataset.id); });
    card.addEventListener("keydown", (e)=>{
      if(e.altKey && e.key.startsWith("Arrow") && document.body.dataset.view === "board"){
        e.preventDefault();
        keyboardMove(card.dataset.id, e.key);
        return;
      }
      if(selectMode){
        if(e.key === "Enter"){ e.preventDefault(); toggleCardSelection(card.dataset.id); }
        return;
      }
      if(e.key === "Enter") openTaskModal(card.dataset.id);
      if(e.key === "Delete") confirmDeleteTask(card.dataset.id);
    });
    if(selectMode){
      card.addEventListener("click", (e)=>{
        if(e.target.closest("button") || e.target.closest(".bulk-select-checkbox") || e.target.closest(".subtask-panel")) return;
        toggleCardSelection(card.dataset.id);
      });
    }
  });
  document.querySelectorAll(".bulk-select-checkbox").forEach(cb=>{
    cb.addEventListener("click", (e)=> e.stopPropagation());
    cb.addEventListener("change", ()=> toggleCardSelection(cb.dataset.id));
  });
  document.querySelectorAll(".card-check").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const t = findTask(btn.dataset.id);
      if(!t) return;
      moveTaskToStatus(t.id, t.status === "completed" ? firstColumnKey() : "completed");
    });
  });
  document.querySelectorAll(".timer-btn").forEach(btn=>{
    btn.addEventListener("click", (e)=>{ e.stopPropagation(); toggleTimer(btn.dataset.id); });
  });
  document.querySelectorAll(".subtask-summary").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const id = btn.dataset.id;
      if(expandedCardIds.has(id)) expandedCardIds.delete(id); else expandedCardIds.add(id);
      renderBoard();
    });
  });
  document.querySelectorAll(".subtask-checklist input[type=checkbox]").forEach(cb=>{
    cb.addEventListener("click", (e)=> e.stopPropagation());
    cb.addEventListener("change", (e)=>{
      const taskId = cb.dataset.taskId, subId = cb.dataset.subId;
      const t = findTask(taskId);
      const s = t && (t.subtasks || []).find(s=>s.id === subId);
      if(!s) return;
      s.done = cb.checked;
      s.updatedAt = nowISO();
      t.updatedAt = nowISO();
      saveState();
      renderBoard();
    });
  });
}

function findTask(id){ return state.tasks.find(t=>t.id === id); }

// Keyboard alternative to dragging: Alt+←/→ moves a card between columns,
// Alt+↑/↓ reorders it inside its column (needs "Board order" sorting).
function keyboardMove(id, key){
  const t = findTask(id);
  if(!t) return;
  const refocus = ()=>requestAnimationFrame(()=>{ const el = document.querySelector(`.card[data-id="${id}"]`); if(el) el.focus(); });
  if(key === "ArrowLeft" || key === "ArrowRight"){
    const keys = [...document.querySelectorAll(".column")].map(c=>c.dataset.status);
    
    const step = key === "ArrowRight" ? 1 : -1;
    const target = keys[keys.indexOf(t.status) + step];
    if(!target){ showToast("No column in that direction", "error"); return; }
    moveTaskToStatus(id, target);
    refocus();
  } else if(key === "ArrowUp" || key === "ArrowDown"){
    if(state.settings.sort !== "manual"){ showToast('Set sorting to "Board order" to reorder cards', "error"); return; }
    const list = sortTasks(getVisibleTasks().filter(x=>x.status === t.status));
    const i = list.indexOf(t), j = i + (key === "ArrowUp" ? -1 : 1);
    if(j < 0 || j >= list.length) return;
    const other = list[j];
    let a = t.order ?? 0, b = other.order ?? 0;
    if(a === b) b = a + (key === "ArrowUp" ? -1 : 1);
    t.order = b; other.order = a;
    t.updatedAt = nowISO();
    saveState();
    renderBoard();
    refocus();
  }
}


function moveTaskToStatus(id, newStatus){
  const t = findTask(id);
  if(!t || t.status === newStatus) return;
  const prevStatus = t.status;
  const prevOrder = t.order;
  t.status = newStatus;
  t.order = Date.now(); // lands at the end of the target column
  t.updatedAt = nowISO();
  if(newStatus === "completed"){
    t.completedBy = currentDisplayName || "Me";
    t.completedOn = nowISO();
  } else {
    t.completedBy = null;
    t.completedOn = null;
  }
  const undoFx = onStatusChange(t, prevStatus);
  saveState();
  renderBoard();
  const label = colLabel(newStatus);
  showToast(`Moved "${t.title}" to ${label}`, "success", "Undo", ()=>{
    undoFx();
    t.status = prevStatus; t.order = prevOrder;
    if(prevStatus !== "completed"){ t.completedBy=null; t.completedOn=null; }
    saveState(); renderBoard();
  });
}

// Used by drag-and-drop: persists both the new column (status) AND the exact
// drop position (order), so cards stay right where the user dropped them
// instead of jumping to wherever the active sort mode would place them.
function dropTaskAt(id, newStatus, newOrder){
  const t = findTask(id);
  if(!t) return;
  const prevStatus = t.status;
  const prevOrder = t.order;
  const statusChanged = prevStatus !== newStatus;

  t.status = newStatus;
  t.order = newOrder;
  t.updatedAt = nowISO();
  if(statusChanged){
    if(newStatus === "completed"){
      t.completedBy = currentDisplayName || "Me";
      t.completedOn = nowISO();
    } else {
      t.completedBy = null;
      t.completedOn = null;
    }
  }
  const undoFx = statusChanged ? onStatusChange(t, prevStatus) : function(){};
  saveState();
  renderBoard();

  if(statusChanged){
    const label = colLabel(newStatus);
    showToast(`Moved "${t.title}" to ${label}`, "success", "Undo", ()=>{
      undoFx();
      t.status = prevStatus; t.order = prevOrder;
      if(prevStatus !== "completed"){ t.completedBy=null; t.completedOn=null; }
      saveState(); renderBoard();
    });
  }
}

function archiveTask(id){
  const t = findTask(id);
  if(!t) return;
  t.archived = true;
  t.updatedAt = nowISO();
  saveState();
  renderBoard();
  showToast(`Archived "${t.title}"`, "success", "Undo", ()=>{
    t.archived = false; saveState(); renderBoard();
  });
}

function restoreTask(id){
  const t = findTask(id);
  if(!t) return;
  t.archived = false;
  t.updatedAt = nowISO();
  saveState();
  renderBoard();
  renderArchiveModal();
  showToast(`Restored "${t.title}"`, "success");
}

let pendingDeleteId = null;
let pendingBulkDeleteIds = null;
function confirmDeleteTask(id){
  pendingDeleteId = id;
  pendingBulkDeleteIds = null;
  const t = findTask(id);
  document.getElementById("confirmText").innerHTML = `Delete <b>"${escapeHtml(t ? t.title : "this task")}"</b>? This can't be undone.`;
  openOverlay("confirmModalOverlay");
}
function confirmBulkDelete(ids){
  if(!ids.length) return;
  pendingBulkDeleteIds = ids.slice();
  pendingDeleteId = null;
  document.getElementById("confirmText").innerHTML = `Delete <b>${ids.length} task${ids.length===1?"":"s"}</b>? This can't be undone.`;
  openOverlay("confirmModalOverlay");
}
document.getElementById("confirmCancelBtn").addEventListener("click", ()=>{ pendingDeleteProfileKey=null; pendingDeleteId=null; pendingBulkDeleteIds=null; closeOverlay("confirmModalOverlay"); });
document.getElementById("confirmOkBtn").addEventListener("click", ()=>{
  if(pendingDeleteProfileKey){
    const k = pendingDeleteProfileKey;
    pendingDeleteProfileKey = null;
    closeOverlay("confirmModalOverlay");
    deleteProfile(k);
    return;
  }
  if(pendingBulkDeleteIds){
    const removed = [];
    const removedAt = [];
    pendingBulkDeleteIds.forEach(id=>{
      const idx = state.tasks.findIndex(t=>t.id===id);
      if(idx > -1){
        removedAt.push(idx);
        removed.push(...state.tasks.splice(idx,1));
      }
    });
    if(removed.length){
      saveState();
      exitSelectMode();
      showToast(`Deleted ${removed.length} task${removed.length===1?"":"s"}`, "success", "Undo", ()=>{
        removed.forEach(t=> state.tasks.push(t));
        saveState(); renderBoard();
      });
    }
  } else if(pendingDeleteId){
    const idx = state.tasks.findIndex(t=>t.id===pendingDeleteId);
    if(idx > -1){
      const [removed] = state.tasks.splice(idx,1);
      saveState();
      renderBoard();
      showToast(`Deleted "${removed.title}"`, "success", "Undo", ()=>{
        state.tasks.splice(idx,0,removed); saveState(); renderBoard();
      });
    }
  }
  pendingDeleteId = null;
  pendingBulkDeleteIds = null;
  closeOverlay("confirmModalOverlay");
});

/* ============================================================
   BULK SELECT & ACTIONS
   ============================================================ */
function toggleCardSelection(id){
  if(selectedTaskIds.has(id)) selectedTaskIds.delete(id); else selectedTaskIds.add(id);
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if(card){
    card.classList.toggle("selected", selectedTaskIds.has(id));
    const cb = card.querySelector(".bulk-select-checkbox");
    if(cb) cb.checked = selectedTaskIds.has(id);
  }
  updateBulkActionBar();
}

function toggleSelectMode(){
  selectMode = !selectMode;
  if(!selectMode) selectedTaskIds.clear();
  updateBulkActionBar();
  renderBoard();
}

function exitSelectMode(){
  selectMode = false;
  selectedTaskIds.clear();
  updateBulkActionBar();
  renderBoard();
}

function updateBulkActionBar(){
  const toggleBtn = document.getElementById("bulkSelectToggleBtn");
  const bar = document.getElementById("bulkActionBar");
  toggleBtn.classList.toggle("active", selectMode);
  bar.classList.toggle("open", selectMode);
  document.body.classList.toggle("select-mode", selectMode);
  document.getElementById("bulkCount").textContent = `${selectedTaskIds.size} selected`;
  document.getElementById("bulkMoveSelect").value = "";
}

function bulkMoveTo(newStatus){
  const ids = [...selectedTaskIds];
  let movedCount = 0;
  ids.forEach(id=>{
    const t = findTask(id);
    if(!t || t.status === newStatus) return;
    const prevS = t.status;
    t.status = newStatus;
    t.order = Date.now() + movedCount; // keeps the batch's relative order, lands at the end
    t.updatedAt = nowISO();
    if(newStatus === "completed"){
      t.completedBy = currentDisplayName || "Me";
      t.completedOn = nowISO();
    } else {
      t.completedBy = null;
      t.completedOn = null;
    }
    onStatusChange(t, prevS);
    movedCount++;
  });
  if(movedCount > 0){
    saveState();
    const label = colLabel(newStatus);
    showToast(`Moved ${movedCount} task${movedCount===1?"":"s"} to ${label}`, "success");
  }
  exitSelectMode();
}

function bulkArchive(){
  const ids = [...selectedTaskIds];
  let archivedCount = 0, skipped = 0;
  ids.forEach(id=>{
    const t = findTask(id);
    if(!t) return;
    if(t.status !== "completed"){ skipped++; return; }
    t.archived = true;
    t.updatedAt = nowISO();
    archivedCount++;
  });
  if(archivedCount > 0){
    saveState();
    showToast(`Archived ${archivedCount} task${archivedCount===1?"":"s"}${skipped ? `, skipped ${skipped} (not completed)` : ""}`, "success");
  } else if(skipped > 0){
    showToast(`Nothing archived — selected tasks aren't completed yet`, "error");
  }
  exitSelectMode();
}

document.getElementById("bulkSelectToggleBtn").addEventListener("click", toggleSelectMode);
document.getElementById("bulkClearBtn").addEventListener("click", exitSelectMode);
document.getElementById("bulkMoveSelect").addEventListener("change", (e)=>{
  const newStatus = e.target.value;
  if(!newStatus || selectedTaskIds.size === 0) return;
  bulkMoveTo(newStatus);
});
document.getElementById("bulkArchiveBtn").addEventListener("click", ()=>{
  if(selectedTaskIds.size === 0) return;
  bulkArchive();
});
document.getElementById("bulkDeleteBtn").addEventListener("click", ()=>{
  if(selectedTaskIds.size === 0) return;
  confirmBulkDelete([...selectedTaskIds]);
});
document.getElementById("bulkSelectAllBtn").addEventListener("click", ()=>{
  getVisibleTasks().forEach(t=> selectedTaskIds.add(t.id));
  updateBulkActionBar();
  renderBoard();
});

/* ============================================================
   DRAG & DROP — pointer-events based (works for mouse + touch)
   ============================================================ */
let dragState = null;

function attachDnD(){
  document.querySelectorAll(".card").forEach(card=>{
    card.addEventListener("pointerdown", onPointerDown);
  });
}

function onPointerDown(e){
  // dragging is disabled while selecting multiple tasks — clicking a card toggles selection instead
  if(selectMode) return;
  // ignore drags starting on buttons or the subtask checklist (checkboxes/toggle)
  if(e.target.closest("button") || e.target.closest(".subtask-panel")) return;
  if(e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;

  const card = e.currentTarget;
  const rect = card.getBoundingClientRect();
  dragState = {
    id: card.dataset.id,
    card,
    startX: e.clientX,
    startY: e.clientY,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    ghost: null,
    placeholder: null,
    started: false,
    fromList: card.closest(".tasklist")
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once:true });
}

function startDrag(){
  const { card, width, height } = dragState;

  // Ghost clone follows the cursor — this is the only thing that visually
  // represents "the card being dragged". Clone BEFORE hiding the original
  // so the clone doesn't inherit display:none, and explicitly turn off its
  // entrance animation so it doesn't fade/pop in when first appended.
  const ghost = card.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.classList.remove("dragging");
  ghost.style.animation = "none";
  ghost.style.setProperty("--ghost-w", width + "px");
  ghost.querySelectorAll(".card-actions").forEach(a=>a.remove());
  document.body.appendChild(ghost);
  dragState.ghost = ghost;

  // A lightweight placeholder takes the card's spot in the list and is what
  // actually gets reordered as the pointer moves — NOT the real card. Moving
  // the real, "heavy" card element via repeated insertBefore/appendChild
  // (including across different columns) was re-triggering its CSS entrance
  // animation on every reinsertion, which is what looked like "shaking".
  // The placeholder has no such animation, so this is gone entirely.
  const placeholder = document.createElement("div");
  placeholder.className = "card-placeholder";
  placeholder.style.height = height + "px";
  card.parentElement.insertBefore(placeholder, card);
  dragState.placeholder = placeholder;

  // The real card just sits hidden in its original spot until drop, at
  // which point the board re-renders from state anyway.
  card.classList.add("dragging");

  dragState.started = true;
  document.body.style.userSelect = "none";
}

function onPointerMove(e){
  if(!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  if(!dragState.started){
    if(Math.abs(dx) + Math.abs(dy) < 5) return;
    startDrag();
  }

  const ghost = dragState.ghost;
  ghost.style.left = (e.clientX - dragState.offsetX) + "px";
  ghost.style.top = (e.clientY - dragState.offsetY) + "px";

  // find column under pointer
  document.querySelectorAll(".column").forEach(c=>c.classList.remove("drop-hover"));
  ghost.style.display = "none";
  const elUnder = document.elementFromPoint(e.clientX, e.clientY);
  ghost.style.display = "";
  const col = elUnder && elUnder.closest(".column");
  if(col) col.classList.add("drop-hover");
  dragState.hoverColumn = col;

  // reorder preview within target list — moves the placeholder, never the real card
  const list = elUnder && elUnder.closest(".tasklist");
  if(list){
    const after = getDragAfterElement(list, e.clientY);
    const placeholder = dragState.placeholder;
    if(after == null){
      if(list.lastElementChild !== placeholder) list.appendChild(placeholder);
    } else if(after !== placeholder){
      list.insertBefore(placeholder, after);
    }

    // Auto-scroll the column when dragging near its top/bottom edge, so
    // long columns can still be dropped into below the visible fold.
    const listRect = list.getBoundingClientRect();
    const edge = 44;
    if(e.clientY < listRect.top + edge){
      list.scrollTop -= 14;
    } else if(e.clientY > listRect.bottom - edge){
      list.scrollTop += 14;
    }
  }
}

function getDragAfterElement(container, y){
  const els = [...container.querySelectorAll(".card:not(.dragging)")];
  return els.reduce((closest, child)=>{
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height/2;
    if(offset < 0 && offset > closest.offset){
      return { offset, element: child };
    } else {
      return closest;
    }
  }, { offset: -Infinity, element: null }).element;
}

function computeOrderFromDOM(list, referenceEl){
  // Places the new `order` value between referenceEl's current DOM
  // neighbors, so the task lands exactly where the placeholder was dropped.
  // Skips the (hidden) real dragged card and any non-task elements (like an
  // empty-column message) when looking for real neighbors.
  if(!list || !referenceEl) return Date.now();

  let prevEl = referenceEl.previousElementSibling;
  while(prevEl && (prevEl.classList.contains("dragging") || !prevEl.dataset.id)) prevEl = prevEl.previousElementSibling;
  let nextEl = referenceEl.nextElementSibling;
  while(nextEl && (nextEl.classList.contains("dragging") || !nextEl.dataset.id)) nextEl = nextEl.nextElementSibling;

  const prevTask = prevEl ? findTask(prevEl.dataset.id) : null;
  const nextTask = nextEl ? findTask(nextEl.dataset.id) : null;
  const prevOrder = prevTask ? (prevTask.order ?? 0) : null;
  const nextOrder = nextTask ? (nextTask.order ?? 0) : null;

  if(prevOrder == null && nextOrder == null) return Date.now();
  if(prevOrder == null) return nextOrder - 1;
  if(nextOrder == null) return prevOrder + 1;
  return (prevOrder + nextOrder) / 2;
}

function onPointerUp(e){
  window.removeEventListener("pointermove", onPointerMove);
  document.body.style.userSelect = "";
  if(!dragState) return;

  if(dragState.started){
    document.querySelectorAll(".column").forEach(c=>c.classList.remove("drop-hover"));
    if(dragState.ghost) dragState.ghost.remove();

    const finalList = dragState.placeholder && dragState.placeholder.parentElement
      ? dragState.placeholder.parentElement
      : dragState.fromList;
    const finalColumn = finalList ? finalList.closest(".column") : null;
    const newStatus = finalColumn ? finalColumn.dataset.status : dragState.fromList.dataset.status;
    const newOrder = computeOrderFromDOM(finalList, dragState.placeholder);

    if(dragState.placeholder) dragState.placeholder.remove();
    dragState.card.classList.remove("dragging");
    dragState.card.style.display = ""; // defensive; renderBoard() replaces this node anyway

    dropTaskAt(dragState.id, newStatus, newOrder);
  }
  dragState = null;
}

/* ============================================================
   TASK MODAL (Add / Edit)
   ============================================================ */
let editingId = null;
const taskForm = document.getElementById("taskForm");
const titleInput = document.getElementById("titleInput");
const descInput = document.getElementById("descInput");
const dueInput = document.getElementById("dueInput");
const statusInput = document.getElementById("statusInput");
const priSelect = document.getElementById("priSelect");
const metaReadout = document.getElementById("metaReadout");

let currentPriority = "medium";
priSelect.addEventListener("click", (e)=>{
  const opt = e.target.closest(".pri-opt");
  if(!opt) return;
  currentPriority = opt.dataset.val;
  [...priSelect.children].forEach(c=>c.classList.toggle("active", c===opt));
});

/* ---------- Subtask editor (inside the Add/Edit modal) ---------- */
let currentSubtasks = [];

function renderSubtaskEditor(){
  const list = document.getElementById("subtaskList");
  if(currentSubtasks.length === 0){
    list.innerHTML = `<div class="subtask-empty">No subtasks yet — break this down into smaller steps.</div>`;
  } else {
    list.innerHTML = currentSubtasks.map(s => `
      <div class="subtask-row" data-id="${s.id}">
        <input type="checkbox" class="subtask-row-check" ${s.done ? "checked" : ""}>
        <div class="subtask-row-main">
          <span class="subtask-row-text ${s.done ? "done" : ""}">${escapeHtml(s.text)}</span>
          ${subtaskTimestampTitle(s) ? `<span class="subtask-row-meta">${subtaskTimestampTitle(s)}</span>` : ""}
        </div>
        <button type="button" class="subtask-row-remove" title="Remove subtask">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    `).join("");
  }

  const doneCt = currentSubtasks.filter(s=>s.done).length;
  const hint = document.getElementById("subtaskProgressHint");
  hint.textContent = currentSubtasks.length ? `${doneCt}/${currentSubtasks.length} done` : "optional";

  list.querySelectorAll(".subtask-row-check").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const id = cb.closest(".subtask-row").dataset.id;
      const s = currentSubtasks.find(s=>s.id===id);
      if(s){ s.done = cb.checked; s.updatedAt = nowISO(); }
      renderSubtaskEditor();
    });
  });
  list.querySelectorAll(".subtask-row-remove").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.closest(".subtask-row").dataset.id;
      currentSubtasks = currentSubtasks.filter(s=>s.id!==id);
      renderSubtaskEditor();
    });
  });
}

function addSubtaskFromInput(){
  const input = document.getElementById("subtaskInput");
  const text = input.value.trim();
  if(!text) return;
  const now = nowISO();
  currentSubtasks.push({ id: uid(), text: text.slice(0,200), done:false, createdAt: now, updatedAt: now });
  input.value = "";
  renderSubtaskEditor();
  input.focus();
}

document.getElementById("subtaskAddBtn").addEventListener("click", addSubtaskFromInput);
document.getElementById("subtaskInput").addEventListener("keydown", (e)=>{
  if(e.key === "Enter"){
    e.preventDefault(); // don't let Enter inside this field submit the whole task form
    addSubtaskFromInput();
  }
});

function openTaskModal(id, presetStatus, presetDue){
  editingId = id || null;
  const t = id ? findTask(id) : null;

  document.getElementById("taskModalTitle").textContent = t ? "Edit task" : "New task";
  document.getElementById("taskSaveBtn").textContent = t ? "Save changes" : "Add task";

  titleInput.value = t ? t.title : "";
  descInput.value = t ? (t.description || "") : "";
  dueInput.value = t ? (t.dueDate || "") : (presetDue || "");
  setSelectValue("statusInput", t ? t.status : (presetStatus || firstColumnKey()));
  setSelectValue("recurInput", t && t.recur ? t.recur : "none");
  document.getElementById("templateRow").style.display = t ? "none" : "";
  renderTemplateSelect();
  currentPriority = t ? t.priority : "medium";
  [...priSelect.children].forEach(c=>c.classList.toggle("active", c.dataset.val === currentPriority));

  currentSubtasks = t && Array.isArray(t.subtasks) ? t.subtasks.map(s => ({ ...s })) : [];
  renderSubtaskEditor();

  renderProjectSelectOptions(document.getElementById("projectInput"), t ? t.projectId : null);
  document.getElementById("projectNewRow").style.display = "none";

  if(t){
    metaReadout.style.display = "flex";
    metaReadout.innerHTML = `
      <span>Created: <b>${fmtDateTime(t.createdAt)}</b></span>
      <span>Updated: <b>${fmtDateTime(t.updatedAt)}</b></span>
      ${taskElapsed(t) ? `<span>Time tracked: <b>${fmtDuration(taskElapsed(t))}</b></span>` : ""}
      ${t.status==="completed" ? `<span>Completed by: <b>${escapeHtml(t.completedBy||"—")}</b> on <b>${fmtDateTime(t.completedOn)}</b></span>` : ""}
    `;
  } else {
    metaReadout.style.display = "none";
  }

  renderActivity(t);
  openOverlay("taskModalOverlay");
  setTimeout(()=>titleInput.focus(), 60);
}

function setSelectValue(id, val){
  const el = document.getElementById(id);
  if(!el) return;
  el.value = val;
  const inst = window.customSelectRegistry && window.customSelectRegistry[id];
  if(inst) inst.refresh();
}

/* ---------- Templates ---------- */
function renderTemplateSelect(){
  const sel = document.getElementById("templateSelect");
  const list = (state.settings.templates || []);
  sel.innerHTML = `<option value="">Start from a template…</option>` +
    list.map(tp=>`<option value="${escapeHtml(tp.id)}">${escapeHtml(tp.name)}</option>`).join("");
  setSelectValue("templateSelect", "");
  document.getElementById("templateRow").classList.toggle("no-templates", list.length === 0);
}
function applyTemplate(id){
  const tp = (state.settings.templates || []).find(x=>x.id === id);
  if(!tp) return;
  titleInput.value = tp.title || "";
  descInput.value = tp.description || "";
  currentPriority = tp.priority || "medium";
  [...priSelect.children].forEach(c=>c.classList.toggle("active", c.dataset.val === currentPriority));
  currentSubtasks = (tp.subtasks || []).map(x=>({ id: uid(), text: x, done:false, createdAt: nowISO(), updatedAt: nowISO() }));
  renderSubtaskEditor();
  setSelectValue("recurInput", tp.recur || "none");
  titleInput.focus();
}
document.getElementById("templateSelect").addEventListener("change", (e)=>{ if(e.target.value) applyTemplate(e.target.value); });
document.getElementById("saveTemplateBtn").addEventListener("click", ()=>{
  const title = titleInput.value.trim();
  if(!title){ titleInput.focus(); showToast("Add a title first, then save it as a template", "error"); return; }
  state.settings.templates = state.settings.templates || [];
  state.settings.templates.push({
    id: uid(), name: title.slice(0,60), title, description: descInput.value.trim(), priority: currentPriority,
    subtasks: currentSubtasks.map(x=>x.text), recur: document.getElementById("recurInput").value || "none"
  });
  saveState();
  renderTemplateSelect();
  showToast(`Saved template "${title}"`, "success");
});

/* ---------- Activity & comments (inside the task modal) ---------- */
function renderActivity(t){
  const field = document.getElementById("activityField");
  const list = document.getElementById("activityList");
  field.style.display = t ? "" : "none";
  if(!t){ list.innerHTML = ""; return; }
  const items = (t.activity || []).slice().reverse().slice(0, 40);
  list.innerHTML = items.length ? items.map(a=>`
    <li class="act-item ${a.type === "comment" ? "comment" : ""}">
      <div class="act-meta"><b>${escapeHtml(a.by || "")}</b> · ${fmtDateTime(a.at)}</div>
      <div class="act-text">${escapeHtml(a.text)}</div>
    </li>`).join("") : `<li class="act-empty">No activity yet.</li>`;
}
function postComment(){
  const input = document.getElementById("commentInput");
  const text = input.value.trim();
  if(!text || !editingId) return;
  const t = findTask(editingId);
  if(!t) return;
  logActivity(t, text.slice(0,500), "comment");
  t.updatedAt = nowISO();
  input.value = "";
  saveState();
  renderActivity(t);
  renderBoard();
}
document.getElementById("commentAddBtn").addEventListener("click", postComment);
document.getElementById("commentInput").addEventListener("keydown", (e)=>{
  if(e.key === "Enter"){ e.preventDefault(); postComment(); }
});

taskForm.addEventListener("submit", (e)=>{
  e.preventDefault();
  const title = titleInput.value.trim();
  if(!title) return;
  const projectId = document.getElementById("projectInput").value || null;
  const recur = document.getElementById("recurInput").value || "none";

  if(editingId){
    const t = findTask(editingId);
    const changes = [];
    if(t.title !== title) changes.push("title");
    if(t.priority !== currentPriority) changes.push(`priority → ${currentPriority}`);
    if((t.dueDate || null) !== (dueInput.value || null)) changes.push(`due date → ${dueInput.value ? fmtDate(dueInput.value + "T00:00:00") : "none"}`);
    if((t.recur || "none") !== recur) changes.push(`repeat → ${RECUR_LABELS[recur].toLowerCase()}`);
    t.title = title;
    t.description = descInput.value.trim();
    t.priority = currentPriority;
    t.dueDate = dueInput.value || null;
    t.recur = recur === "none" ? null : recur;
    t.subtasks = currentSubtasks;
    t.projectId = projectId;
    if(changes.length) logActivity(t, "Changed " + changes.join(", "));
    const newStatus = statusInput.value;
    if(newStatus !== t.status){
      moveTaskToStatus(t.id, newStatus); // handles completedBy/On + activity + toast
    }
    t.updatedAt = nowISO();
    saveState();
    renderBoard();
    showToast(`Saved "${t.title}"`, "success");
  } else {
    const newTask = createTask({
      title, description: descInput.value, priority: currentPriority, dueDate: dueInput.value || null,
      status: statusInput.value, subtasks: currentSubtasks, projectId, recur
    });
    saveState();
    renderBoard();
    showToast(`Added "${newTask.title}"`, "success");
  }
  closeOverlay("taskModalOverlay");
});

document.getElementById("taskCancelBtn").addEventListener("click", ()=>closeOverlay("taskModalOverlay"));
document.getElementById("taskModalClose").addEventListener("click", ()=>closeOverlay("taskModalOverlay"));
document.getElementById("newTaskBtn").addEventListener("click", ()=>openTaskModal(null));

document.getElementById("projectAddInlineBtn").addEventListener("click", ()=>{
  const row = document.getElementById("projectNewRow");
  const showing = row.style.display !== "none";
  row.style.display = showing ? "none" : "flex";
  if(!showing){
    const input = document.getElementById("newProjectInlineInput");
    input.value = "";
    input.focus();
  }
});
function confirmNewProjectInline(){
  const input = document.getElementById("newProjectInlineInput");
  const proj = addProject(input.value);
  if(!proj) return;
  input.value = "";
  document.getElementById("projectNewRow").style.display = "none";
  renderProjectSelectOptions(document.getElementById("projectInput"), proj.id);
  renderProjectFilterSelect();
}
document.getElementById("projectNewConfirmBtn").addEventListener("click", confirmNewProjectInline);
document.getElementById("newProjectInlineInput").addEventListener("keydown", (e)=>{
  if(e.key === "Enter"){
    e.preventDefault(); // don't let Enter inside this field submit the whole task form
    confirmNewProjectInline();
  }
});

/* ============================================================
   OVERLAYS (generic open/close + ESC + backdrop click)
   ============================================================ */
function openOverlay(id){
  document.getElementById(id).classList.add("open");
}
function closeOverlay(id){
  document.getElementById(id).classList.remove("open");
}
document.querySelectorAll(".modal-overlay").forEach(ov=>{
  if(ov.id === "profileModalOverlay") return; // only dismissed via its own explicit buttons
  ov.addEventListener("mousedown", (e)=>{ if(e.target === ov) closeOverlay(ov.id); });
});
window.addEventListener("keydown", (e)=>{
  if(e.key === "Escape"){
    document.querySelectorAll(".modal-overlay.open").forEach(ov=>{
      if(ov.id === "profileModalOverlay") return;
      closeOverlay(ov.id);
    });
  }
});

/* ============================================================
   ARCHIVE MODAL
   ============================================================ */
function renderArchiveModal(){
  const list = document.getElementById("archiveList");
  const archived = state.tasks.filter(t=>t.archived).sort((a,b)=> new Date(b.updatedAt)-new Date(a.updatedAt));
  if(archived.length === 0){
    list.innerHTML = `<div class="empty-col" style="border:none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/></svg><span>No archived tasks yet. Completed tasks you archive will show up here.</span></div>`;
    return;
  }
  list.innerHTML = archived.map(t=>`
    <div class="card priority-${t.priority} done" style="cursor:default;">
      <div class="card-top">
        <div class="card-title">${escapeHtml(t.title)}</div>
        <span class="pri-chip priority-${t.priority}">${t.priority}</span>
      </div>
      ${t.description ? `<div class="card-desc">${escapeHtml(t.description)}</div>` : ""}
      <div class="completion-box">✓ Completed by <b>${escapeHtml(t.completedBy||"—")}</b><br>on ${fmtDateTime(t.completedOn)}</div>
      <div class="card-actions" style="opacity:1; transform:none;">
        <button class="restore-btn" data-id="${t.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>Restore</button>
        <button class="delete-btn danger" data-id="${t.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>Delete forever</button>
      </div>
    </div>
  `).join("");
  list.querySelectorAll(".restore-btn").forEach(b=>b.addEventListener("click", ()=>restoreTask(b.dataset.id)));
  list.querySelectorAll(".delete-btn").forEach(b=>b.addEventListener("click", ()=>{
    closeOverlay("archiveModalOverlay");
    confirmDeleteTask(b.dataset.id);
  }));
}
document.getElementById("archiveBtn").addEventListener("click", ()=>{ renderArchiveModal(); openOverlay("archiveModalOverlay"); });
document.getElementById("archiveModalClose").addEventListener("click", ()=>closeOverlay("archiveModalOverlay"));

/* ============================================================
   BOARD INSIGHTS & ANALYTICS DASHBOARD
   ============================================================ */
let insightsCalMonth = new Date().getMonth(); // 0-11
let insightsCalYear = new Date().getFullYear();

function openInsightsModal(){
  const now = new Date();
  insightsCalMonth = now.getMonth();
  insightsCalYear = now.getFullYear();
  renderInsights();
  openOverlay("insightsModalOverlay");
}

function renderInsights(){
  const body = document.getElementById("insightsBody");
  if(!body || !state || !state.tasks) return;

  const all = state.tasks.filter(t => !t.archived);
  const totalActive = all.length;
  const completed = all.filter(t => t.status === "completed");
  const inProgress = all.filter(t => t.status === "inprogress");
  const daily = all.filter(t => t.status === "daily");

  const completionRate = totalActive > 0 ? Math.round((completed.length / totalActive) * 100) : 0;

  const todayDate = new Date(); todayDate.setHours(0,0,0,0);
  const overdueCount = all.filter(t => {
    if(t.status === "completed" || !t.dueDate) return false;
    return new Date(t.dueDate + "T00:00:00") < todayDate;
  }).length;

  const days = [];
  let maxDayCompleted = 1;
  for(let i = 6; i >= 0; i--){
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = localDateStr(d);
    const dayLabel = d.toLocaleDateString(LOCALE, { weekday: "short" });
    const isToday = i === 0;

    const count = completed.filter(t => {
      const cDate = t.completedOn ? isoToLocalDay(t.completedOn) : (t.updatedAt ? isoToLocalDay(t.updatedAt) : "");
      return cDate === dateStr;
    }).length;

    if(count > maxDayCompleted) maxDayCompleted = count;
    days.push({ dayLabel, count, isToday });
  }

  const highCt = all.filter(t => t.priority === "high").length;
  const medCt = all.filter(t => t.priority === "medium").length;
  const lowCt = all.filter(t => t.priority === "low").length;

  // Uses the real categorization feature this board has (Projects) rather
  // than a separate tags system, since tasks aren't tagged — they're
  // optionally assigned to a project.
  const projectCounts = {};
  all.forEach(t => {
    if(t.projectId) projectCounts[t.projectId] = (projectCounts[t.projectId] || 0) + 1;
  });
  const topProjects = Object.entries(projectCounts)
    .map(([id, count]) => ({ project: findProject(id), count }))
    .filter(p => p.project)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  body.innerHTML = `
    <div class="insights-grid">
      <div class="insights-kpis">
        <div class="kpi-card">
          <div class="kpi-val">${totalActive}</div>
          <div class="kpi-label">Active Tasks</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-val">${completed.length}</div>
          <div class="kpi-label">Completed</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-val">${completionRate}%</div>
          <div class="kpi-label">Completion Rate</div>
        </div>
        <div class="kpi-card" ${overdueCount > 0 ? 'style="border-color:var(--high);"' : ''}>
          <div class="kpi-val" ${overdueCount > 0 ? 'style="color:var(--high);"' : ''}>${overdueCount}</div>
          <div class="kpi-label">Overdue Tasks</div>
        </div>
      </div>

      <div class="insights-panel">
        <h3>7-Day Completion Velocity <span>Tasks finished per day</span></h3>
        <div class="velocity-chart">
          ${days.map(d => {
            const pct = Math.round((d.count / maxDayCompleted) * 100);
            return `
              <div class="velocity-col">
                <span class="velocity-count">${d.count || ''}</span>
                <div class="velocity-bar-track">
                  <div class="velocity-bar-fill${d.isToday ? " today" : ""}" style="height:${Math.max(pct, d.count > 0 ? 12 : 0)}%;"></div>
                </div>
                <span class="velocity-day" ${d.isToday ? 'style="color:var(--text-0); font-weight:800;"' : ''}>${d.isToday ? "Today" : d.dayLabel}</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>

      <div id="insightsCalendarPanel"></div>

      <div class="insights-row">
        <div class="insights-panel">
          <h3>Status Breakdown <span>Distribution across columns</span></h3>
          <div class="breakdown-list">
            ${getColumns().map(c=>{
              const n = all.filter(t=>t.status === c.key).length;
              const pct = totalActive ? Math.round((n/totalActive)*100) : 0;
              return `<div class="breakdown-item">
              <div class="breakdown-head"><span>${escapeHtml(c.label)}</span><b>${n} (${pct}%)</b></div>
              <div class="breakdown-track"><div class="breakdown-fill ${c.dot || ""}" style="width:${pct}%;${c.color ? `background:${c.color}` : ""}"></div></div>
            </div>`;
            }).join("")}
          </div>
        </div>

        <div class="insights-panel">
          <h3>Priority Distribution <span>High / Medium / Low</span></h3>
          <div class="breakdown-list">
            <div class="breakdown-item">
              <div class="breakdown-head"><span>High Priority</span><b>${highCt} (${totalActive ? Math.round((highCt/totalActive)*100) : 0}%)</b></div>
              <div class="breakdown-track"><div class="breakdown-fill high" style="width:${totalActive ? Math.round((highCt/totalActive)*100) : 0}%"></div></div>
            </div>
            <div class="breakdown-item">
              <div class="breakdown-head"><span>Medium Priority</span><b>${medCt} (${totalActive ? Math.round((medCt/totalActive)*100) : 0}%)</b></div>
              <div class="breakdown-track"><div class="breakdown-fill medium" style="width:${totalActive ? Math.round((medCt/totalActive)*100) : 0}%"></div></div>
            </div>
            <div class="breakdown-item">
              <div class="breakdown-head"><span>Low Priority</span><b>${lowCt} (${totalActive ? Math.round((lowCt/totalActive)*100) : 0}%)</b></div>
              <div class="breakdown-track"><div class="breakdown-fill low" style="width:${totalActive ? Math.round((lowCt/totalActive)*100) : 0}%"></div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="insights-panel">
        <h3>Most Active Projects <span>Where your active tasks are concentrated</span></h3>
        ${topProjects.length ? `
          <div class="insights-project-list">
            ${topProjects.map(({project, count}) => `
              <div class="insights-project-pill">
                <span class="project-chip" style="margin-top:0; --proj-color:${projectColor(project.id)}">${escapeHtml(project.name)}</span>
                <span class="count">${count} task${count===1 ? '' : 's'}</span>
              </div>
            `).join("")}
          </div>
        ` : `<div class="insights-empty">No tasks are assigned to a project yet.</div>`}
      </div>
    </div>
  `;

  updateCalendarPanel(all);
}

// ---- Monthly calendar panel: navigable by month AND year, shows per-day
// completion/due activity, with a click-through detail list for any day. ----
function calendarPanelHTML(all){
  const year = insightsCalYear, month = insightsCalMonth;
  const pad = n => String(n).padStart(2, "0");
  const monthLabel = new Date(year, month, 1).toLocaleDateString(LOCALE, { month: "long" });
  const firstDayOfWeek = mondayOffset(year, month);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = localDateStr(new Date());
  const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);

  const dayStats = {};
  for(let d = 1; d <= daysInMonth; d++){
    dayStats[`${year}-${pad(month+1)}-${pad(d)}`] = { completed: [], due: [] };
  }
  all.forEach(t=>{
    if(t.completedOn){
      const cDate = isoToLocalDay(t.completedOn);
      if(dayStats[cDate]) dayStats[cDate].completed.push(t);
    }
    if(t.dueDate && dayStats[t.dueDate] && t.status !== "completed"){
      dayStats[t.dueDate].due.push(t);
    }
  });

  let monthCompletedCt = 0, monthDueCt = 0, monthOverdueCt = 0;
  Object.entries(dayStats).forEach(([dateStr, s])=>{
    monthCompletedCt += s.completed.length;
    monthDueCt += s.due.length;
    if(s.due.length && new Date(dateStr + "T00:00:00") < todayMidnight) monthOverdueCt += s.due.length;
  });

  // Year options: a sane range around today, widened to cover any task dates
  // that fall outside it, so old or future-dated data is always reachable.
  const nowYear = new Date().getFullYear();
  let minYear = nowYear - 1, maxYear = nowYear + 1;
  all.forEach(t=>{
    [t.createdAt, t.dueDate, t.completedOn].forEach(v=>{
      if(!v) return;
      const y = parseInt(String(v).slice(0,4), 10);
      if(!isNaN(y)){ minYear = Math.min(minYear, y); maxYear = Math.max(maxYear, y); }
    });
  });
  maxYear = Math.max(maxYear, year);
  minYear = Math.min(minYear, year);

  const monthNames = Array.from({length:12}, (_,i)=> new Date(2000, i, 1).toLocaleDateString(LOCALE, { month:"long" }));
  const dowLabels = DOW_LABELS;

  let cells = "";
  for(let i = 0; i < firstDayOfWeek; i++) cells += `<div class="cal-cell empty"></div>`;
  for(let d = 1; d <= daysInMonth; d++){
    const dateStr = `${year}-${pad(month+1)}-${pad(d)}`;
    const s = dayStats[dateStr];
    const isToday = dateStr === todayStr;
    const hasActivity = s.completed.length > 0 || s.due.length > 0;
    cells += `<div class="cal-cell${isToday ? " today" : ""}${hasActivity ? " has-activity" : ""}" ${hasActivity ? `data-date="${dateStr}" tabindex="0"` : ""}>
      <span class="cal-daynum">${d}</span>
      ${hasActivity ? `<div class="cal-indicators">
        ${s.completed.length ? `<span class="cal-dot completed">${s.completed.length}</span>` : ""}
        ${s.due.length ? `<span class="cal-dot due">${s.due.length}</span>` : ""}
      </div>` : ""}
    </div>`;
  }

  return `
    <div class="insights-panel" id="insightsCalendarPanel">
      <h3>Monthly Calendar <span>Completions and due dates by day</span></h3>
      <div class="cal-header">
        <button type="button" class="icon-btn" id="calPrevBtn" title="Previous month">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <select class="select" id="calMonthSelect">
          ${monthNames.map((m,i)=>`<option value="${i}" ${i===month?"selected":""}>${m}</option>`).join("")}
        </select>
        <select class="select" id="calYearSelect">
          ${Array.from({length: maxYear-minYear+1}, (_,i)=>minYear+i).map(y=>`<option value="${y}" ${y===year?"selected":""}>${y}</option>`).join("")}
        </select>
        <button type="button" class="icon-btn" id="calNextBtn" title="Next month">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        <button type="button" class="btn ghost" id="calTodayBtn">Today</button>
      </div>
      <div class="cal-summary">
        <span><b>${monthCompletedCt}</b> completed</span>
        <span><b>${monthDueCt}</b> due</span>
        <span${monthOverdueCt > 0 ? ' class="overdue"' : ''}><b>${monthOverdueCt}</b> overdue</span>
      </div>
      <div class="cal-grid cal-grid-head">
        ${dowLabels.map(d=>`<div class="cal-dow">${d}</div>`).join("")}
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-day-detail" id="calDayDetail" style="display:none;"></div>
    </div>
  `;
}

function updateCalendarPanel(all){
  const container = document.getElementById("insightsCalendarPanel");
  if(!container) return;
  container.outerHTML = calendarPanelHTML(all);
  attachCalendarListeners(all);
}

function attachCalendarListeners(all){
  const prevBtn = document.getElementById("calPrevBtn");
  const nextBtn = document.getElementById("calNextBtn");
  const todayBtn = document.getElementById("calTodayBtn");
  const monthSel = document.getElementById("calMonthSelect");
  const yearSel = document.getElementById("calYearSelect");

  if(prevBtn) prevBtn.addEventListener("click", ()=>{
    insightsCalMonth--;
    if(insightsCalMonth < 0){ insightsCalMonth = 11; insightsCalYear--; }
    updateCalendarPanel(all);
  });
  if(nextBtn) nextBtn.addEventListener("click", ()=>{
    insightsCalMonth++;
    if(insightsCalMonth > 11){ insightsCalMonth = 0; insightsCalYear++; }
    updateCalendarPanel(all);
  });
  if(todayBtn) todayBtn.addEventListener("click", ()=>{
    const now = new Date();
    insightsCalMonth = now.getMonth();
    insightsCalYear = now.getFullYear();
    updateCalendarPanel(all);
  });
  if(monthSel) monthSel.addEventListener("change", (e)=>{
    insightsCalMonth = parseInt(e.target.value, 10);
    updateCalendarPanel(all);
  });
  if(yearSel) yearSel.addEventListener("change", (e)=>{
    insightsCalYear = parseInt(e.target.value, 10);
    updateCalendarPanel(all);
  });

  document.querySelectorAll(".cal-cell.has-activity").forEach(cell=>{
    const open = ()=> showCalDayDetail(cell.dataset.date, all);
    cell.addEventListener("click", open);
    cell.addEventListener("keydown", (e)=>{ if(e.key === "Enter") open(); });
  });
}

function showCalDayDetail(dateStr, all){
  const detail = document.getElementById("calDayDetail");
  if(!detail) return;
  const completedTasks = all.filter(t => t.completedOn && isoToLocalDay(t.completedOn) === dateStr);
  const dueTasks = all.filter(t => t.dueDate === dateStr && t.status !== "completed");
  const label = new Date(dateStr + "T00:00:00").toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });

  detail.style.display = "block";
  detail.innerHTML = `
    <div class="cal-detail-head">${label}</div>
    ${completedTasks.length ? `<div class="cal-detail-group"><b>Completed</b>
      ${completedTasks.map(t=>`<div class="cal-detail-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>${escapeHtml(t.title)}</div>`).join("")}
    </div>` : ""}
    ${dueTasks.length ? `<div class="cal-detail-group"><b>Due</b>
      ${dueTasks.map(t=>`<div class="cal-detail-item"><span class="pri-chip priority-${t.priority}" style="margin:0;">${t.priority}</span>${escapeHtml(t.title)}</div>`).join("")}
    </div>` : ""}
    ${!completedTasks.length && !dueTasks.length ? `<div class="cal-detail-item">No activity that day.</div>` : ""}
  `;
}

const insightsBtn = document.getElementById("insightsBtn");
if(insightsBtn) insightsBtn.addEventListener("click", openInsightsModal);
const insightsModalClose = document.getElementById("insightsModalClose");
if(insightsModalClose) insightsModalClose.addEventListener("click", ()=>closeOverlay("insightsModalOverlay"));

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */
document.getElementById("exportBtn").addEventListener("click", exportData);
function exportData(){
  const payload = {
    exportedAt: nowISO(),
    app: "Flow local to-do board",
    version: 2,
    tasks: state.tasks,
    projects: state.projects || []
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = localDateStr(new Date());
  a.href = url;
  a.download = `flow-tasks-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Exported tasks as JSON", "success");
}

const importFileInput = document.getElementById("importFileInput");
document.getElementById("importBtn").addEventListener("click", ()=>importFileInput.click());
importFileInput.addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (evt)=>{
    if(/\.csv$/i.test(file.name) || file.type === "text/csv"){
      if(window.FlowCsv) window.FlowCsv.importText(evt.target.result);
      importFileInput.value = "";
      return;
    }
    try{
      const data = JSON.parse(evt.target.result);
      const incoming = Array.isArray(data) ? data : data.tasks;
      if(!Array.isArray(incoming)) throw new Error("No tasks array found");

      // Bring in any projects referenced by the import too, matching existing
      // ones by name (case-insensitive) so re-importing doesn't create duplicates.
      const incomingProjects = Array.isArray(data.projects) ? data.projects : [];
      const projectIdMap = {}; // id in the imported file -> id in this profile
      incomingProjects.forEach(rp=>{
        if(!rp || !rp.name) return;
        const proj = addProject(rp.name);
        if(rp.id && proj) projectIdMap[rp.id] = proj.id;
      });

      let added = 0, skipped = 0;
      const existingIds = new Set(state.tasks.map(t=>t.id));
      const importBase = Date.now();
      let importOffset = 0;
      incoming.forEach(raw=>{
        if(!raw || !raw.title) { skipped++; return; }
        const task = {
          id: (raw.id && !existingIds.has(raw.id)) ? raw.id : uid(),
          title: String(raw.title).slice(0,120),
          description: raw.description ? String(raw.description).slice(0,1000) : "",
          priority: ["low","medium","high"].includes(raw.priority) ? raw.priority : "medium",
          dueDate: raw.dueDate || null,
          status: getColumns().some(c=>c.key === raw.status) ? raw.status : firstColumnKey(),
          archived: !!raw.archived,
          order: typeof raw.order === "number" ? raw.order : (importBase + (importOffset++)),
          subtasks: Array.isArray(raw.subtasks)
            ? raw.subtasks
                .filter(s => s && s.text)
                .map(s => ({
                  id: s.id || uid(),
                  text: String(s.text).slice(0,200),
                  done: !!s.done,
                  createdAt: s.createdAt || raw.createdAt || nowISO(),
                  updatedAt: s.updatedAt || s.createdAt || raw.updatedAt || nowISO()
                }))
            : [],
          projectId: raw.projectId && projectIdMap[raw.projectId] ? projectIdMap[raw.projectId] : null,
          createdAt: raw.createdAt || nowISO(),
          updatedAt: raw.updatedAt || nowISO(),
          completedBy: raw.completedBy || null,
          completedOn: raw.completedOn || null,
          recur: RECUR_LABELS[raw.recur] && raw.recur !== "none" ? raw.recur : null,
          timeSpent: Number(raw.timeSpent) || 0,
          timeLog: Array.isArray(raw.timeLog) ? raw.timeLog.slice(-200) : [],
          activity: Array.isArray(raw.activity) ? raw.activity.slice(-100) : []
        };
        existingIds.add(task.id);
        state.tasks.push(task);
        added++;
      });
      saveState();
      renderBoard();
      renderProjectFilterSelect();
      showToast(`Imported ${added} task${added===1?"":"s"}${skipped?`, skipped ${skipped}`:""}`, "success");
    }catch(err){
      console.error("Unexpected error");
      showToast("Import failed — invalid JSON file.", "error");
    }
    importFileInput.value = "";
  };
  reader.readAsText(file);
});

/* ============================================================
   THEME
   ============================================================ */
function effectiveTheme(){
  const m = (state && (state.settings.themeMode || state.settings.theme)) || "dark";
  if(m === "system") return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return m === "light" ? "light" : "dark";
}
function applyTheme(){
  const th = effectiveTheme();
  document.body.setAttribute("data-theme", th);
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute("content", th === "dark" ? "#0E131A" : "#F3F5F8");
}
// Everything per-profile that affects how the app looks.
function applyPrefs(){
  applyTheme();
  document.body.dataset.palette = state.settings.palette || "slate";
  document.body.dataset.accent = (state.settings.accent === "teal" ? "navy" : state.settings.accent) || "navy";
  ["compact","comfortable","detailed"].forEach(d=>document.body.classList.toggle("density-" + d, d === (state.settings.density || "comfortable")));
  emit("prefs");
}
if(window.matchMedia){
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", ()=>{
    if(state && state.settings.themeMode === "system") applyTheme();
  });
}
document.getElementById("themeBtn").addEventListener("click", ()=>{
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  state.settings.themeMode = next;
  state.settings.theme = next;
  applyTheme();
  saveState();
});

/* ============================================================
   FILTERS / SORT / SEARCH
   ============================================================ */
document.getElementById("priorityFilterSeg").addEventListener("click", (e)=>{
  const btn = e.target.closest("button");
  if(!btn) return;
  state.settings.priorityFilter = btn.dataset.val;
  [...e.currentTarget.children].forEach(c=>c.classList.toggle("active", c===btn));
  saveState();
  renderBoard();
});

document.getElementById("sortSelect").addEventListener("change", (e)=>{
  state.settings.sort = e.target.value;
  saveState();
  renderBoard();
});

document.getElementById("statusFilterSelect").addEventListener("change", (e)=>{
  state.settings.statusFilter = e.target.value;
  saveState();
  renderBoard();
});

document.getElementById("projectFilterSelect").addEventListener("change", (e)=>{
  state.settings.projectFilter = e.target.value;
  saveState();
  renderBoard();
});

searchInput.addEventListener("input", debounce(()=>renderBoard(), 120));

/* ============================================================
   NAME PROMPT
   ============================================================ */
/* ============================================================
   SHORTCUTS
   ============================================================ */
document.getElementById("shortcutsBtn").addEventListener("click", ()=>openOverlay("shortcutsModalOverlay"));
document.getElementById("shortcutsModalClose").addEventListener("click", ()=>closeOverlay("shortcutsModalOverlay"));

window.addEventListener("keydown", (e)=>{
  if(!state) return; // no profile chosen yet — board shortcuts don't apply
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || e.target.isContentEditable;

  if(e.key === "/" && !typing){
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if(typing) return;

  if((e.ctrlKey || e.metaKey) || e.altKey) { /* modifier combos are handled elsewhere */ }
  else if(e.key === "n" || e.key === "N"){ openTaskModal(null); }
  else if(e.key === "q" || e.key === "Q"){ e.preventDefault(); emit("focus-quickadd"); }
  else if(["1","2","3","4"].includes(e.key)){ setView(VIEWS[Number(e.key) - 1]); }
  if(e.key === "t" || e.key === "T"){ document.getElementById("themeBtn").click(); }
  if(e.key === "?"){ openOverlay("shortcutsModalOverlay"); }
  if((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E")){ e.preventDefault(); exportData(); }
});

/* ============================================================
   INIT
   ============================================================ */
function seedIfEmpty(){
  if(state.tasks.length > 0) return;
  const t0 = Date.now();
  const mk = (mins)=> new Date(t0 - mins*60000).toISOString();
  state.tasks = [
    {
      id: uid(), title:"Welcome to Flow 👋", description:"This board saves everything locally in your browser. Try dragging this card to another column.",
      priority:"medium", dueDate:null, status:"daily", archived:false, order: t0 - 400000,
      createdAt: mk(120), updatedAt: mk(120), completedBy:null, completedOn:null
    },
    {
      id: uid(), title:"Try adding a new task", description:"Click \"New task\" up top, or press N on your keyboard.",
      priority:"low", dueDate:null, status:"daily", archived:false, order: t0 - 300000,
      subtasks:[
        { id: uid(), text:"Open the New task modal", done:true, createdAt: mk(90), updatedAt: mk(88) },
        { id: uid(), text:"Give it a title and priority", done:false, createdAt: mk(90), updatedAt: mk(90) },
        { id: uid(), text:"Try checking this box right on the card", done:false, createdAt: mk(90), updatedAt: mk(90) }
      ],
      createdAt: mk(90), updatedAt: mk(90), completedBy:null, completedOn:null
    },
    {
      id: uid(), title:"Example: in-progress work", description:"Tasks here show up in the middle column until they're done.",
      priority:"high", dueDate: localDateStr(new Date(Date.now()+2*86400000)), status:"inprogress", archived:false, order: t0 - 200000,
      createdAt: mk(60), updatedAt: mk(30), completedBy:null, completedOn:null
    },
    {
      id: uid(), title:"Example: a finished task", description:"Completed tasks keep a permanent record of who finished them and when.",
      priority:"low", dueDate:null, status:"completed", archived:false, order: t0 - 100000,
      createdAt: mk(200), updatedAt: mk(10), completedBy:"Flow", completedOn: mk(10)
    }
  ];
  expandedCardIds.add(state.tasks[1].id); // show the demo checklist open by default
  saveState();
}

function syncToolbarToSettings(){
  document.getElementById("sortSelect").value = state.settings.sort;
  document.getElementById("statusFilterSelect").value = state.settings.statusFilter;
  renderProjectFilterSelect();
  document.querySelectorAll("#priorityFilterSeg button").forEach(b=>{
    b.classList.toggle("active", b.dataset.val === state.settings.priorityFilter);
  });
  // These two values were just set programmatically above, which doesn't fire
  // a native 'change' event — nudge the custom dropdown UI so its visible
  // trigger text matches (otherwise it can show the previous profile's choice).
  ["sortSelect", "statusFilterSelect"].forEach(id=>{
    const inst = window.customSelectRegistry && window.customSelectRegistry[id];
    if(inst) inst.refresh();
  });
}

function init(){
  // Board rendering, seeding, and theme all happen once a profile is chosen
  // (see finishProfileSelection / registerProfile). Until then, just show the picker.
  renderProfileList();
  document.getElementById("profileCancelBtn").style.display = "none"; // mandatory on first load
  openOverlay("profileModalOverlay");
  setTimeout(()=> document.getElementById("newUsernameInput").focus(), 60);

  if(syncConfig){
    setSyncStatus("syncing", "Checking GitHub for updates…");
    pullFromGitHub({ silent: true });
  }

  // Keep multi-tab usage in sync: if another tab (same profile) changes data, reflect it here.
  window.addEventListener("storage", (e)=>{
    if(e.key === MASTER_KEY && e.newValue){
      try{
        const fresh = JSON.parse(e.newValue);
        if(fresh && typeof fresh.users === "object"){
          masterState = fresh;
          if(currentUserKey && masterState.users[currentUserKey]){
            const u = masterState.users[currentUserKey];
            state = { tasks: u.tasks || [], projects: u.projects || [], settings: Object.assign(defaultUserData().settings, u.settings || {}) };
            applyPrefs();
            renderColumnSelects();
            renderBoard();
          }
        }
      }catch(err){ /* ignore malformed cross-tab payloads */ }
    }
  });

  // If a trusted collaborator pushed changes while this tab was in the
  // background, pick them up as soon as the person comes back to it.
  document.addEventListener("visibilitychange", ()=>{
    if(document.visibilityState === "visible" && syncConfig && state){
      pullFromGitHub({ silent: true });
    }
  });
}

window.FLOW_LOCALE = LOCALE;
window.FLOW_DOW = DOW_LABELS;

window.Flow = {
  get state(){ return state; },
  get master(){ return masterState; },
  get userKey(){ return currentUserKey; },
  get displayName(){ return currentDisplayName; },
  get locale(){ return LOCALE; },
  on, emit, saveState, persistMasterLocally, renderBoard, openOverlay, closeOverlay, showToast,
  findTask, createTask, uid, nowISO, localDateStr, isoToLocalDay, escapeHtml, fmtDate, fmtDateTime, fmtDuration,
  taskElapsed, openTaskModal, addProject, sortedProjects, findProject, renderProjectFilterSelect, selectProfile,
  getColumns, setColumns, colLabel, firstColumnKey, setView, cycleDensity, applyPrefs, applyTheme, effectiveTheme,
  autoLogin, openProfileSwitcher, exportData, defaultUserData, RECUR_LABELS, nextOccurrence,
  getVisibleTasks, toggleTimer, normalizeKey
};

init();

})();
