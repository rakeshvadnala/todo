(function(){
"use strict";

/* ============================================================
   STORAGE LAYER — multi-profile
   All profiles live together in one master object under MASTER_KEY.
   Each profile is keyed by a lowercased username and holds its own
   {tasks, settings}. No passwords — picking/creating a username is
   the entire "login."
   ============================================================ */
const MASTER_KEY = "flow_todo_master_v1";
const LEGACY_KEY = "flow_todo_data_v1"; // pre-multi-profile single-user storage

function loadMaster(){
  try{
    const raw = localStorage.getItem(MASTER_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || typeof parsed.users !== "object" || parsed.users === null) return null;
    return parsed;
  }catch(e){
    console.error("Failed to load profile data:", e);
    return null;
  }
}

function defaultUserData(){
  return {
    tasks: [],
    settings: {
      theme: (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark",
      sort: "manual",
      priorityFilter: "all",
      statusFilter: "all"
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
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if(!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw);
    if(!legacy || !Array.isArray(legacy.tasks)) return;
    const displayName = (legacy.settings && legacy.settings.userName) ? legacy.settings.userName : "Me";
    const key = displayName.trim().toLowerCase() || "me";
    masterState.users[key] = {
      displayName,
      tasks: legacy.tasks,
      settings: Object.assign(defaultUserData().settings, legacy.settings || {})
    };
    localStorage.setItem(MASTER_KEY, JSON.stringify(masterState));
  }catch(e){
    console.error("Legacy data migration failed:", e);
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
  // Debounced auto-save; still effectively instant.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    try{
      localStorage.setItem(MASTER_KEY, JSON.stringify(masterState));
    }catch(e){
      console.error("Auto-save failed:", e);
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

function fmtDate(iso){
  if(!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
}
function fmtDateTime(iso){
  if(!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric" }) + ", " +
         d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
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
  setTimeout(()=>{
    el.style.animation = "toast-out .2s ease forwards";
    setTimeout(()=>el.remove(), 200);
  }, 3600);
}

/* ============================================================
   PROFILES — no-password multi-user switching
   ============================================================ */
function avatarColor(key){
  let hash = 0;
  for(let i=0; i<key.length; i++){ hash = key.charCodeAt(i) + ((hash << 5) - hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 68% 50%)`;
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
    return `<button type="button" class="profile-card" data-key="${escapeHtml(k)}">
      <span class="profile-avatar" style="background:${avatarColor(k)}">${escapeHtml(initial)}</span>
      <span class="profile-info">
        <span class="profile-name">${escapeHtml(displayName)}</span>
        <span class="profile-meta">${count} active task${count===1?"":"s"}</span>
      </span>
    </button>`;
  }).join("");
  list.querySelectorAll(".profile-card").forEach(btn=>{
    btn.addEventListener("click", ()=> selectProfile(btn.dataset.key));
  });
}

function selectProfile(key){
  const u = masterState.users[key];
  if(!u) return;
  currentUserKey = key;
  currentDisplayName = u.displayName || key;
  state = { tasks: u.tasks || [], settings: Object.assign(defaultUserData().settings, u.settings || {}) };
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
  masterState.users[key] = Object.assign({ displayName }, defaultUserData());
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
  applyTheme();
  syncToolbarToSettings();
  renderBoard();
  updateProfileChip();
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
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || !parsed.owner || !parsed.repo || !parsed.token) return null;
    return parsed;
  }catch(e){ return null; }
}
function saveSyncConfig(cfg){
  try{ localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(cfg)); }
  catch(e){ console.error("Failed to save sync config:", e); }
}
function clearSyncConfig(){
  try{ localStorage.removeItem(SYNC_CONFIG_KEY); }catch(e){}
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
  const merged = { users: {} };
  const allKeys = new Set([...Object.keys(local.users || {}), ...Object.keys(remote.users || {})]);
  allKeys.forEach(key=>{
    const l = local.users[key];
    const r = remote.users[key];
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
    merged.users[key] = {
      displayName: l.displayName || r.displayName,
      tasks: [...taskMap.values()],
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
    const remote = JSON.parse(base64ToUtf8(data.content));
    if(!remote || typeof remote.users !== "object") throw new Error("Malformed remote data");

    masterState = mergeMasterStates(masterState, remote);
    persistMasterLocally();

    // Refresh whatever's currently on screen with the merged data
    if(currentUserKey && masterState.users[currentUserKey]){
      const u = masterState.users[currentUserKey];
      state = { tasks: u.tasks || [], settings: Object.assign(defaultUserData().settings, u.settings || {}) };
      renderBoard();
    }
    if(document.getElementById("profileModalOverlay").classList.contains("open")){
      renderProfileList();
    }
    setSyncStatus("synced", "Synced just now.");
    if(!opts.silent) showToast("Pulled latest data from GitHub", "success");
  }catch(e){
    console.error("GitHub pull failed:", e);
    setSyncStatus("error", "Pull failed — see console for details.");
    if(!opts.silent) showToast("Pull failed — check your connection and settings.", "error");
  }
}

function persistMasterLocally(){
  try{ localStorage.setItem(MASTER_KEY, JSON.stringify(masterState)); }
  catch(e){ console.error("Local save during sync failed:", e); }
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
      content: utf8ToBase64(JSON.stringify(masterState, null, 2)),
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
    console.error("GitHub push failed:", e);
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
   RENDER: BOARD
   ============================================================ */
const COLUMNS = [
  { key:"daily", label:"Daily", dot:"daily" },
  { key:"inprogress", label:"In Progress", dot:"inprogress" },
  { key:"completed", label:"Completed", dot:"completed" }
];

const boardEl = document.getElementById("board");
const searchInput = document.getElementById("searchInput");
const resultCountEl = document.getElementById("resultCount");

function getVisibleTasks(){
  const q = searchInput.value.trim().toLowerCase();
  const pf = state.settings.priorityFilter;
  return state.tasks.filter(t=>{
    if(t.archived) return false;
    if(pf !== "all" && t.priority !== pf) return false;
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
          <label class="subtask-check-row">
            <input type="checkbox" data-task-id="${t.id}" data-sub-id="${s.id}" ${s.done ? "checked" : ""}>
            <span class="${s.done ? "done" : ""}">${escapeHtml(s.text)}</span>
          </label>
        `).join("")}
      </div>` : ""}
    </div>`;
}

function cardHTML(t){
  const due = dueMeta(t.dueDate);
  const isDone = t.status === "completed";
  return `
  <div class="card priority-${t.priority}${isDone ? " done" : ""}" data-id="${t.id}" tabindex="0" role="group" aria-label="${escapeHtml(t.title)}">
    <div class="card-top">
      <div class="card-title">${escapeHtml(t.title)}</div>
      <span class="pri-chip priority-${t.priority}">${t.priority}</span>
    </div>
    ${t.description ? `<div class="card-desc">${escapeHtml(t.description)}</div>` : ""}
    <div class="card-meta">
      ${due ? `<span class="meta-item due-chip ${due.cls}">${escapeHtml(due.label)}</span>` : ""}
      <span class="meta-item" title="Created">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
        ${fmtDateTime(t.createdAt)}
      </span>
      ${t.updatedAt !== t.createdAt ? `<span class="meta-item" title="Last updated">
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
  fillEl.classList.toggle("complete", isComplete);
  pctEl.classList.toggle("complete", isComplete);
  pctEl.textContent = pct + "%";
  statsEl.textContent = totalActive === 0
    ? "No active tasks yet"
    : `${doneCount} of ${totalActive} task${totalActive===1?"":"s"} completed`;
}

function renderBoard(){
  const visible = getVisibleTasks();
  const q = searchInput.value.trim();

  boardEl.innerHTML = "";
  let totalShown = 0;

  const totalActive = state.tasks.filter(t=>!t.archived).length;
  updateOverallProgress(totalActive);
  const sf = state.settings.statusFilter;
  const columnsToRender = sf === "all" ? COLUMNS : COLUMNS.filter(c=>c.key === sf);
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
        <span class="col-dot ${col.dot}"></span>
        <span class="column-title">${col.label}</span>
        <span class="column-count">${allInStatus}</span>
      </div>
      <div class="column-progress" title="${shareOfBoard}% of active tasks"><div style="width:${shareOfBoard}%"></div></div>
      <div class="tasklist" data-status="${col.key}">
        ${colTasks.length ? colTasks.map(cardHTML).join("") : (q ? "" : emptyColHTML())}
        ${colTasks.length === 0 && q ? `<div class="empty-col"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><span>No matches in ${col.label}.</span></div>` : ""}
      </div>
    `;
    boardEl.appendChild(colEl);
  });

  resultCountEl.textContent = q || state.settings.priorityFilter !== "all"
    ? `${totalShown} task${totalShown===1?"":"s"} shown`
    : `${state.tasks.filter(t=>!t.archived).length} active tasks`;

  attachCardListeners();
  attachDnD();
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
    card.addEventListener("dblclick", ()=> openTaskModal(card.dataset.id));
    card.addEventListener("keydown", (e)=>{
      if(e.key === "Enter") openTaskModal(card.dataset.id);
      if(e.key === "Delete") confirmDeleteTask(card.dataset.id);
    });
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
      t.updatedAt = nowISO();
      saveState();
      renderBoard();
    });
  });
}

function findTask(id){ return state.tasks.find(t=>t.id === id); }

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
  saveState();
  renderBoard();
  const label = COLUMNS.find(c=>c.key===newStatus).label;
  showToast(`Moved "${t.title}" to ${label}`, "success", "Undo", ()=>{
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
  saveState();
  renderBoard();

  if(statusChanged){
    const label = COLUMNS.find(c=>c.key===newStatus).label;
    showToast(`Moved "${t.title}" to ${label}`, "success", "Undo", ()=>{
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
function confirmDeleteTask(id){
  pendingDeleteId = id;
  const t = findTask(id);
  document.getElementById("confirmText").innerHTML = `Delete <b>"${escapeHtml(t ? t.title : "this task")}"</b>? This can't be undone.`;
  openOverlay("confirmModalOverlay");
}
document.getElementById("confirmCancelBtn").addEventListener("click", ()=>{ pendingDeleteId=null; closeOverlay("confirmModalOverlay"); });
document.getElementById("confirmOkBtn").addEventListener("click", ()=>{
  if(pendingDeleteId){
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
  closeOverlay("confirmModalOverlay");
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
    ghost: null,
    started: false,
    fromList: card.closest(".tasklist")
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once:true });
}

function startDrag(){
  const { card, width } = dragState;
  card.classList.add("dragging");
  const ghost = card.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.setProperty("--ghost-w", width + "px");
  ghost.querySelectorAll(".card-actions").forEach(a=>a.remove());
  document.body.appendChild(ghost);
  dragState.ghost = ghost;
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

  // reorder preview within target list
  const list = elUnder && elUnder.closest(".tasklist");
  if(list){
    const after = getDragAfterElement(list, e.clientY);
    const placeholder = dragState.card;
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

function computeOrderFromDOM(list, cardEl){
  // Places the card's new `order` value between its current DOM neighbors,
  // so it lands exactly where the live drag preview left it.
  if(!list) return Date.now();
  const domCards = [...list.querySelectorAll(".card")];
  const idx = domCards.indexOf(cardEl);
  const prevEl = idx > 0 ? domCards[idx-1] : null;
  const nextEl = idx >= 0 && idx < domCards.length - 1 ? domCards[idx+1] : null;
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

    // The live preview already reparented dragState.card into whichever
    // tasklist it was hovering over — read its final resting place directly
    // rather than relying only on the last hover event (more robust if the
    // pointer ends exactly on a column edge).
    const finalList = dragState.card.parentElement && dragState.card.parentElement.classList.contains("tasklist")
      ? dragState.card.parentElement
      : dragState.fromList;
    const finalColumn = finalList ? finalList.closest(".column") : null;
    const newStatus = finalColumn ? finalColumn.dataset.status : dragState.fromList.dataset.status;
    const newOrder = computeOrderFromDOM(finalList, dragState.card);

    dragState.card.classList.remove("dragging");
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
        <span class="subtask-row-text ${s.done ? "done" : ""}">${escapeHtml(s.text)}</span>
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
      if(s) s.done = cb.checked;
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
  currentSubtasks.push({ id: uid(), text: text.slice(0,200), done:false });
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

function openTaskModal(id, presetStatus){
  editingId = id || null;
  const t = id ? findTask(id) : null;

  document.getElementById("taskModalTitle").textContent = t ? "Edit task" : "New task";
  document.getElementById("taskSaveBtn").textContent = t ? "Save changes" : "Add task";

  titleInput.value = t ? t.title : "";
  descInput.value = t ? (t.description || "") : "";
  dueInput.value = t ? (t.dueDate || "") : "";
  statusInput.value = t ? t.status : (presetStatus || "daily");
  currentPriority = t ? t.priority : "medium";
  [...priSelect.children].forEach(c=>c.classList.toggle("active", c.dataset.val === currentPriority));

  currentSubtasks = t && Array.isArray(t.subtasks) ? t.subtasks.map(s => ({ ...s })) : [];
  renderSubtaskEditor();

  if(t){
    metaReadout.style.display = "flex";
    metaReadout.innerHTML = `
      <span>Created: <b>${fmtDateTime(t.createdAt)}</b></span>
      <span>Updated: <b>${fmtDateTime(t.updatedAt)}</b></span>
      ${t.status==="completed" ? `<span>Completed by: <b>${escapeHtml(t.completedBy||"—")}</b> on <b>${fmtDateTime(t.completedOn)}</b></span>` : ""}
    `;
  } else {
    metaReadout.style.display = "none";
  }

  openOverlay("taskModalOverlay");
  setTimeout(()=>titleInput.focus(), 60);
}

taskForm.addEventListener("submit", (e)=>{
  e.preventDefault();
  const title = titleInput.value.trim();
  if(!title) return;

  if(editingId){
    const t = findTask(editingId);
    t.title = title;
    t.description = descInput.value.trim();
    t.priority = currentPriority;
    t.dueDate = dueInput.value || null;
    t.subtasks = currentSubtasks;
    const newStatus = statusInput.value;
    if(newStatus !== t.status){
      moveTaskToStatus(t.id, newStatus); // handles completedBy/On + toast
    }
    t.updatedAt = nowISO();
    saveState();
    renderBoard();
    showToast(`Saved "${t.title}"`, "success");
  } else {
    const newTask = {
      id: uid(),
      title,
      description: descInput.value.trim(),
      priority: currentPriority,
      dueDate: dueInput.value || null,
      status: statusInput.value,
      archived: false,
      order: Date.now(),
      subtasks: currentSubtasks,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      completedBy: null,
      completedOn: null
    };
    if(newTask.status === "completed"){
      newTask.completedBy = currentDisplayName || "Me";
      newTask.completedOn = nowISO();
    }
    state.tasks.unshift(newTask);
    saveState();
    renderBoard();
    showToast(`Added "${newTask.title}"`, "success");
  }
  closeOverlay("taskModalOverlay");
});

document.getElementById("taskCancelBtn").addEventListener("click", ()=>closeOverlay("taskModalOverlay"));
document.getElementById("taskModalClose").addEventListener("click", ()=>closeOverlay("taskModalOverlay"));
document.getElementById("newTaskBtn").addEventListener("click", ()=>openTaskModal(null));

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
   EXPORT / IMPORT
   ============================================================ */
document.getElementById("exportBtn").addEventListener("click", exportData);
function exportData(){
  const payload = {
    exportedAt: nowISO(),
    app: "Flow local to-do board",
    version: 1,
    tasks: state.tasks
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0,10);
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
    try{
      const data = JSON.parse(evt.target.result);
      const incoming = Array.isArray(data) ? data : data.tasks;
      if(!Array.isArray(incoming)) throw new Error("No tasks array found");
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
          status: ["daily","inprogress","completed"].includes(raw.status) ? raw.status : "daily",
          archived: !!raw.archived,
          order: typeof raw.order === "number" ? raw.order : (importBase + (importOffset++)),
          subtasks: Array.isArray(raw.subtasks)
            ? raw.subtasks
                .filter(s => s && s.text)
                .map(s => ({ id: s.id || uid(), text: String(s.text).slice(0,200), done: !!s.done }))
            : [],
          createdAt: raw.createdAt || nowISO(),
          updatedAt: raw.updatedAt || nowISO(),
          completedBy: raw.completedBy || null,
          completedOn: raw.completedOn || null
        };
        existingIds.add(task.id);
        state.tasks.push(task);
        added++;
      });
      saveState();
      renderBoard();
      showToast(`Imported ${added} task${added===1?"":"s"}${skipped?`, skipped ${skipped}`:""}`, "success");
    }catch(err){
      console.error(err);
      showToast("Import failed — invalid JSON file.", "error");
    }
    importFileInput.value = "";
  };
  reader.readAsText(file);
});

/* ============================================================
   THEME
   ============================================================ */
function applyTheme(){
  document.body.setAttribute("data-theme", state.settings.theme);
}
document.getElementById("themeBtn").addEventListener("click", ()=>{
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
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

  if(e.key === "n" || e.key === "N"){ openTaskModal(null); }
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
        { id: uid(), text:"Open the New task modal", done:true },
        { id: uid(), text:"Give it a title and priority", done:false },
        { id: uid(), text:"Try checking this box right on the card", done:false }
      ],
      createdAt: mk(90), updatedAt: mk(90), completedBy:null, completedOn:null
    },
    {
      id: uid(), title:"Example: in-progress work", description:"Tasks here show up in the middle column until they're done.",
      priority:"high", dueDate: new Date(Date.now()+2*86400000).toISOString().slice(0,10), status:"inprogress", archived:false, order: t0 - 200000,
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
  document.querySelectorAll("#priorityFilterSeg button").forEach(b=>{
    b.classList.toggle("active", b.dataset.val === state.settings.priorityFilter);
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
            state = { tasks: u.tasks || [], settings: Object.assign(defaultUserData().settings, u.settings || {}) };
            applyTheme();
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

init();

})();
