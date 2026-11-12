/* ==========================================================================
   Flow — vault
   Client-side encryption and the unlock screen. Loads FIRST; the application
   scripts (script.js, features.js) are only fetched and run after a
   successful unlock, so no task data ever exists in memory or in the DOM
   before authentication.

   Design (envelope encryption):
     password ──PBKDF2-SHA256 (600k, random 16-byte salt)──▶ KEK
     KEK ──AES-256-GCM wrap──▶ DEK  (random 256-bit data key)        [pw]
     recovery key (random 256-bit, optional) ──wrap──▶ DEK           [rec]
     DEK ──AES-256-GCM (fresh 96-bit IV per write)──▶ vault data     [data]

   Only the encrypted record is stored (localStorage "flow_vault_v1") and
   synced to GitHub. The password, the KEK and the DEK are never persisted;
   a wrong password simply fails the AES-GCM authentication tag, so no
   password hash or verifier exists anywhere to attack.
   ========================================================================== */
(function(){
"use strict";

const VAULT_KEY = "flow_vault_v1";
const PREFS_KEY = "flow_vault_prefs";
const FORMAT = "flow-vault";
const ITER = 600000;
const AAD = new TextEncoder().encode("flow-vault-v1");
const LEGACY_KEYS = ["flow_todo_master_v1", "flow_todo_data_v1", "flow_gh_sync_config_v1", "flow_last_user_v1", "flow_backups_v1"];
const MIN_PW = 10;

const te = new TextEncoder(), td = new TextDecoder();
const hasCrypto = !!(window.crypto && crypto.subtle);

/* ---------- encoding helpers ---------- */
function toB64(buf){
  const b = new Uint8Array(buf); let s = "";
  for(let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s){
  const bin = atob(s), out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

// Recovery key: 32 random bytes shown as Crockford base32 in groups of 4.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function recoveryEncode(bytes){
  let bits = 0, val = 0, out = "";
  for(const b of bytes){ val = (val << 8) | b; bits += 8; while(bits >= 5){ out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if(bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join("-");
}
function recoveryDecode(str){
  const clean = str.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  let bits = 0, val = 0; const out = [];
  for(const ch of clean){
    const i = B32.indexOf(ch); if(i < 0) return null;
    val = (val << 5) | i; bits += 5;
    if(bits >= 8){ out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return out.length >= 32 ? new Uint8Array(out.slice(0, 32)) : null;
}

/* ---------- crypto primitives ---------- */
async function deriveKEK(password, salt, iter){
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name:"PBKDF2", salt, iterations:iter, hash:"SHA-256" }, base,
    { name:"AES-GCM", length:256 }, false, ["wrapKey", "unwrapKey"]);
}
async function recoveryKEK(bytes){
  return crypto.subtle.importKey("raw", bytes, { name:"AES-GCM" }, false, ["wrapKey", "unwrapKey"]);
}
async function wrapDek(dek, kek){
  const iv = rand(12);
  const ct = await crypto.subtle.wrapKey("raw", dek, kek, { name:"AES-GCM", iv, additionalData:AAD });
  return { iv: toB64(iv), ct: toB64(ct) };
}
function unwrapDek(w, kek, extractable){
  return crypto.subtle.unwrapKey("raw", fromB64(w.ct), kek, { name:"AES-GCM", iv:fromB64(w.iv), additionalData:AAD },
    { name:"AES-GCM", length:256 }, !!extractable, extractable ? ["encrypt", "decrypt"] : ["encrypt", "decrypt"]);
}
async function encJson(dek, obj){
  const iv = rand(12); // unique per encryption
  const ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv, additionalData:AAD }, dek, te.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function decJson(dek, blob){
  const pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv:fromB64(blob.iv), additionalData:AAD }, dek, fromB64(blob.ct));
  return JSON.parse(td.decode(pt));
}

/* ---------- session state (memory only) ---------- */
let dek = null;          // non-extractable CryptoKey once unlocked
let record = null;       // the encrypted vault record
const mem = Object.create(null);   // decrypted key/value store for this session
let writeChain = Promise.resolve();
let writeTimer = null;
let unlocked = false;

function readRecord(){
  try{
    const raw = localStorage.getItem(VAULT_KEY);
    if(!raw) return null;
    const r = JSON.parse(raw);
    return r && r.format === FORMAT && r.kdf && r.pw && r.data ? r : null;
  }catch(e){ return null; }
}
function newRecord(kdf, pw, rec){ return { format:FORMAT, v:1, kdf, pw, rec: rec || null, data:null }; }

async function persist(){
  if(!unlocked || !dek) return;
  record.data = await encJson(dek, mem);
  record.ts = new Date().toISOString();
  localStorage.setItem(VAULT_KEY, JSON.stringify(record));
}
function schedulePersist(){
  clearTimeout(writeTimer);
  writeTimer = setTimeout(()=>{ writeChain = writeChain.then(persist).catch(()=>{ /* storage full or locked */ }); }, 40);
}
function flush(){
  clearTimeout(writeTimer);
  writeChain = writeChain.then(persist).catch(()=>{});
  return writeChain;
}

/* The only storage object the application code uses (same API as localStorage). */
const FlowStore = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
  setItem(k, v){ if(!unlocked) return; mem[k] = String(v); schedulePersist(); },
  removeItem(k){ if(!unlocked) return; delete mem[k]; schedulePersist(); }
};
Object.freeze(FlowStore);
window.FlowStore = FlowStore;

/* ---------- preferences kept inside the vault ---------- */
function getPrefs(){
  let p = {}; try{ p = JSON.parse(mem[PREFS_KEY] || "{}"); }catch(e){}
  return Object.assign({ autoLockMin: 5 }, p);
}
function setPrefs(patch){
  mem[PREFS_KEY] = JSON.stringify(Object.assign(getPrefs(), patch));
  schedulePersist();
  startIdleWatch();
}

/* ---------- vault lifecycle ---------- */
function scorePassword(pw){
  let s = 0;
  if(pw.length >= MIN_PW) s++;
  if(pw.length >= 14) s++;
  if(/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if(/\d/.test(pw)) s++;
  if(/[^A-Za-z0-9]/.test(pw)) s++;
  if(pw.length >= 20) s++;
  return Math.min(4, Math.ceil(s * 4 / 6));
}

function collectLegacy(){
  const out = {};
  LEGACY_KEYS.forEach(k=>{ try{ const v = localStorage.getItem(k); if(v != null) out[k] = v; }catch(e){} });
  return out;
}
function purgeLegacy(){
  LEGACY_KEYS.forEach(k=>{ try{ localStorage.removeItem(k); }catch(e){} });
}

async function createVault(password, withRecovery){
  const salt = rand(16);
  const kek = await deriveKEK(password, salt, ITER);
  const newDek = await crypto.subtle.generateKey({ name:"AES-GCM", length:256 }, true, ["encrypt", "decrypt"]);
  const pw = await wrapDek(newDek, kek);
  let rec = null, recoveryKey = null;
  if(withRecovery){
    const rk = rand(32);
    rec = await wrapDek(newDek, await recoveryKEK(rk));
    recoveryKey = recoveryEncode(rk);
  }
  const kdf = { alg:"PBKDF2-SHA256", iter:ITER, salt:toB64(salt) };
  // Re-import the data key as non-extractable for the session.
  const raw = await crypto.subtle.exportKey("raw", newDek);
  dek = await crypto.subtle.importKey("raw", raw, { name:"AES-GCM" }, false, ["encrypt", "decrypt"]);
  new Uint8Array(raw).fill(0);
  record = newRecord(kdf, pw, rec);
  unlocked = true;
  // Bring any pre-existing plaintext data into the vault, then erase the plaintext copy.
  Object.assign(mem, collectLegacy());
  await persist();
  // Verify the round trip before deleting anything.
  const check = readRecord();
  if(!check || JSON.stringify(await decJson(dek, check.data)) !== JSON.stringify(mem)) throw new Error("verify");
  purgeLegacy();
  return recoveryKey;
}

async function openWithKey(rec, getKek){
  const kek = await getKek();
  return unwrapDek(rec, kek, false);
}

async function finishUnlock(key, rec){
  dek = key; record = rec; unlocked = true;
  const data = await decJson(dek, rec.data);
  Object.keys(mem).forEach(k=>delete mem[k]);
  Object.assign(mem, data);
  // Anything stray in plaintext (e.g. an old tab) is folded in and removed.
  const stray = collectLegacy();
  if(Object.keys(stray).length){
    Object.keys(stray).forEach(k=>{ if(!(k in mem)) mem[k] = stray[k]; });
    purgeLegacy(); schedulePersist();
  }
}

async function unlockWithPassword(password, rec){
  const kek = await deriveKEK(password, fromB64(rec.kdf.salt), rec.kdf.iter || ITER);
  const key = await unwrapDek(rec.pw, kek, false);   // throws on wrong password
  await finishUnlock(key, rec);
}
async function unlockWithRecovery(recoveryText, rec){
  const bytes = recoveryDecode(recoveryText);
  if(!bytes || !rec.rec) throw new Error("recovery");
  const key = await unwrapDek(rec.rec, await recoveryKEK(bytes), false);
  await finishUnlock(key, rec);
}

// Runs fn with a temporarily extractable data key, after re-checking the password.
async function withDek(password, fn){
  const kek = await deriveKEK(password, fromB64(record.kdf.salt), record.kdf.iter || ITER);
  const exportable = await unwrapDek(record.pw, kek, true);
  return fn(exportable);
}
async function changePassword(current, next){
  return withDek(current, async (ex)=>{
    const salt = rand(16);
    const kek = await deriveKEK(next, salt, ITER);
    record.kdf = { alg:"PBKDF2-SHA256", iter:ITER, salt:toB64(salt) };
    record.pw = await wrapDek(ex, kek);
    await persist();
  });
}
async function newRecoveryKey(password){
  return withDek(password, async (ex)=>{
    const rk = rand(32);
    record.rec = await wrapDek(ex, await recoveryKEK(rk));
    await persist();
    return recoveryEncode(rk);
  });
}
function hasRecovery(){ return !!(record && record.rec); }

/* ---------- GitHub / backup envelope ---------- */
// The synced file is a vault record whose data holds ONLY the board (never the
// sync token, backups, or preferences). It can be decrypted with the same
// password (or recovery key) on any device.
async function encryptRemote(master){
  const r = { format:FORMAT, v:1, kdf:record.kdf, pw:record.pw, rec:record.rec || null, data: await encJson(dek, { board: master }) };
  return JSON.stringify(r, null, 2);
}
async function decryptRemote(text){
  const r = JSON.parse(text);
  if(r && r.format === FORMAT){
    try{ const d = await decJson(dek, r.data); return d.board; }
    catch(e){ const err = new Error("different-vault"); err.code = "DIFFERENT_VAULT"; throw err; }
  }
  if(r && typeof r.users === "object"){ const err = new Error("plaintext"); err.legacyPlaintext = true; err.value = r; throw err; }
  throw new Error("unrecognised");
}
async function exportBackup(){
  await flush();
  return JSON.stringify(record, null, 2);
}

// Used by the lock screen: turn a downloaded vault/GitHub file into the local vault.
async function restoreFromText(text, password){
  const r = JSON.parse(text);
  if(!r || r.format !== FORMAT || !r.kdf || !r.pw || !r.data) throw new Error("format");
  const kek = await deriveKEK(password, fromB64(r.kdf.salt), r.kdf.iter || ITER);
  const key = await unwrapDek(r.pw, kek, false);
  const data = await decJson(key, r.data);
  const mine = Object.assign({}, data.board ? { flow_todo_master_v1: JSON.stringify(data.board) } : data);
  dek = key; unlocked = true;
  record = { format:FORMAT, v:1, kdf:r.kdf, pw:r.pw, rec:r.rec || null, data:null };
  Object.keys(mem).forEach(k=>delete mem[k]);
  Object.assign(mem, mine);
  await persist();
  purgeLegacy();
}

function wipeAll(){
  try{ localStorage.removeItem(VAULT_KEY); }catch(e){}
  purgeLegacy();
}

/* ---------- locking ---------- */
async function lock(){
  try{ await flush(); }catch(e){}
  location.reload();   // discards every key and all decrypted data from memory
}
let idleTimer = null, lastActive = Date.now();
function limitMs(){ const m = getPrefs().autoLockMin; return m > 0 ? m * 60000 : 0; }
function bump(){ lastActive = Date.now(); armIdle(); }
function armIdle(){
  clearTimeout(idleTimer);
  const lim = limitMs();
  if(unlocked && lim) idleTimer = setTimeout(lock, lim);
}
let idleWired = false;
function startIdleWatch(){
  if(!idleWired){
    idleWired = true;
    ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"].forEach(ev=>
      window.addEventListener(ev, ()=>{ if(Date.now() - lastActive > 1000) bump(); }, { passive:true, capture:true }));
    document.addEventListener("visibilitychange", ()=>{
      if(document.visibilityState === "visible"){
        const lim = limitMs();
        if(lim && Date.now() - lastActive > lim) lock(); else armIdle();
      }
    });
  }
  bump();
}
// A page restored from the back/forward cache must not show old data.
window.addEventListener("pageshow", (e)=>{ if(e.persisted && unlocked) location.reload(); });
window.addEventListener("pagehide", ()=>{ if(unlocked) flush(); });

// Another tab wrote the vault: adopt its data so we never overwrite it with stale state.
window.addEventListener("storage", async (e)=>{
  if(!unlocked || e.key !== VAULT_KEY) return;
  if(!e.newValue){ location.reload(); return; }   // vault erased elsewhere
  try{
    const r = JSON.parse(e.newValue);
    const data = await decJson(dek, r.data);
    record = r;
    const before = mem.flow_todo_master_v1;
    Object.keys(mem).forEach(k=>delete mem[k]);
    Object.assign(mem, data);
    if(mem.flow_todo_master_v1 && mem.flow_todo_master_v1 !== before){
      window.dispatchEvent(new StorageEvent("storage", { key:"flow_todo_master_v1", newValue:mem.flow_todo_master_v1 }));
    }
  }catch(err){ location.reload(); }
});

/* ==========================================================================
   Unlock screen
   ========================================================================== */
const screen = document.getElementById("vaultScreen");
const esc = (s)=>String(s).replace(/[&<>"']/g, c=>({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

const SHELL_HTML = (inner)=>`
  <div class="vault-card" role="dialog" aria-modal="true" aria-labelledby="vaultTitle">
    <div class="vault-brand"><img src="image/todo-logo.png" alt="" width="36" height="36"><span>Flow</span></div>
    ${inner}
  </div>`;

function eyeField(id, label, ph, auto){
  return `<label class="vault-label" for="${id}">${label}</label>
    <div class="vault-input"><input id="${id}" type="password" autocomplete="${auto}" placeholder="${ph || ""}" spellcheck="false" autocapitalize="off">
    <button type="button" class="vault-eye" data-eye="${id}" aria-label="Show password" aria-pressed="false">Show</button></div>`;
}
function wireEyes(root){
  root.querySelectorAll("[data-eye]").forEach(b=>b.addEventListener("click", ()=>{
    const i = root.querySelector("#" + b.dataset.eye); const show = i.type === "password";
    i.type = show ? "text" : "password"; b.textContent = show ? "Hide" : "Show"; b.setAttribute("aria-pressed", String(show));
  }));
}
function setMsg(root, msg, ok){
  const m = root.querySelector(".vault-msg"); if(!m) return;
  m.textContent = msg || ""; m.className = "vault-msg" + (ok ? " ok" : "");
}
function busy(root, on, label){
  const b = root.querySelector("[data-primary]"); if(!b) return;
  b.disabled = on; if(label){ if(on){ b.dataset.t = b.textContent; b.textContent = label; } else if(b.dataset.t){ b.textContent = b.dataset.t; } }
}

let resolveBoot;
const booted = new Promise(r=>{ resolveBoot = r; });

function view(html){
  screen.innerHTML = SHELL_HTML(html);
  screen.hidden = false;
  wireEyes(screen);
  const first = screen.querySelector("input"); if(first) setTimeout(()=>first.focus(), 30);
}

function showUnsupported(){
  view(`<h1 id="vaultTitle">Secure connection required</h1>
    <p class="vault-sub">Encryption needs the browser's Web Crypto API, which is only available on HTTPS pages (or localhost). Open this site over HTTPS — GitHub Pages provides that automatically.</p>`);
}

/* ----- Create ----- */
function showSetup(){
  const hasOld = Object.keys(collectLegacy()).length > 0;
  view(`<h1 id="vaultTitle">Protect your board</h1>
    <p class="vault-sub">${hasOld ? "Your existing tasks on this device will be encrypted with a master password you choose." : "Choose a master password. Everything is encrypted in your browser before it is saved or synced to GitHub."}</p>
    <form id="vaultForm" novalidate>
      ${eyeField("vPw", "Master password", `At least ${MIN_PW} characters`, "new-password")}
      <div class="vault-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="vault-hint" id="vHint">Use a long passphrase — length matters more than symbols.</div>
      ${eyeField("vPw2", "Confirm password", "", "new-password")}
      <label class="vault-check"><input type="checkbox" id="vRec" checked><span>Also create a <b>recovery key</b> (recommended)</span></label>
      <label class="vault-check"><input type="checkbox" id="vAck"><span>I understand that <b>if I lose the password and have no recovery key, my data cannot be recovered</b> — by anyone.</span></label>
      <div class="vault-msg" role="alert"></div>
      <button class="vault-btn" type="submit" data-primary>Encrypt &amp; continue</button>
    </form>
    <div class="vault-links"><button type="button" class="vault-link" id="vRestore">Restore from an encrypted backup instead</button></div>`);
  const f = screen.querySelector("#vaultForm"), pw = f.querySelector("#vPw"), hint = f.querySelector("#vHint");
  const bars = [...f.querySelectorAll(".vault-meter i")];
  pw.addEventListener("input", ()=>{
    const s = pw.value ? Math.max(1, scorePassword(pw.value)) : 0;
    bars.forEach((b, i)=>{ b.className = i < s ? "on s" + s : ""; });
    hint.textContent = pw.value.length < MIN_PW ? `${MIN_PW - pw.value.length} more character${MIN_PW - pw.value.length === 1 ? "" : "s"} needed` : ["", "Weak", "Fair", "Good", "Strong"][s] || "";
  });
  screen.querySelector("#vRestore").addEventListener("click", showRestore);
  f.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const a = pw.value, b = f.querySelector("#vPw2").value;
    if(a.length < MIN_PW) return setMsg(screen, `Use at least ${MIN_PW} characters.`);
    if(a !== b) return setMsg(screen, "The two passwords don't match.");
    if(!f.querySelector("#vAck").checked) return setMsg(screen, "Please confirm you understand the recovery warning.");
    setMsg(screen, ""); busy(screen, true, "Encrypting…");
    askNotifyPermission();   // the click is the user gesture browsers require
    try{
      const key = await createVault(a, f.querySelector("#vRec").checked);
      if(key) showRecoveryKey(key); else finishBoot();
    }catch(err){ busy(screen, false); setMsg(screen, "Couldn't create the vault in this browser."); }
  });
}

function showRecoveryKey(key, after){
  view(`<h1 id="vaultTitle">Save your recovery key</h1>
    <p class="vault-sub">This is the <b>only</b> way back in if you forget your password. It is shown once and is not stored anywhere readable. Keep it somewhere safe and private — not in this repository.</p>
    <div class="vault-key" id="vKey" tabindex="0">${esc(key)}</div>
    <div class="vault-row">
      <button type="button" class="vault-btn ghost" id="vCopy">Copy</button>
      <button type="button" class="vault-btn ghost" id="vDl">Download .txt</button>
    </div>
    <label class="vault-check"><input type="checkbox" id="vSaved"><span>I have saved my recovery key.</span></label>
    <div class="vault-msg" role="alert"></div>
    <button class="vault-btn" type="button" id="vDone" data-primary>Continue</button>`);
  screen.querySelector("#vCopy").addEventListener("click", async ()=>{ try{ await navigator.clipboard.writeText(key); setMsg(screen, "Copied.", true); }catch(e){ setMsg(screen, "Copy failed — select the key and copy it manually."); } });
  screen.querySelector("#vDl").addEventListener("click", ()=>{
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["Flow recovery key\n\n" + key + "\n\nKeep this private. Anyone with it (plus access to your encrypted data) can read your board.\n"], { type:"text/plain" }));
    a.download = "flow-recovery-key.txt"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  });
  screen.querySelector("#vDone").addEventListener("click", ()=>{
    if(!screen.querySelector("#vSaved").checked) return setMsg(screen, "Tick the box once you have saved the key.");
    (after || finishBoot)();
  });
}

/* ----- Unlock ----- */
let fails = 0, blockedUntil = 0;
function showUnlock(rec){
  view(`<h1 id="vaultTitle">Unlock Flow</h1>
    <p class="vault-sub">Your board is encrypted. Enter your master password to continue.</p>
    <form id="vaultForm" novalidate>
      ${eyeField("vPw", "Master password", "", "current-password")}
      <div class="vault-msg" role="alert"></div>
      <button class="vault-btn" type="submit" data-primary>Unlock</button>
    </form>
    <div class="vault-links">
      <button type="button" class="vault-link" id="vUseRec">Use recovery key</button>
      <button type="button" class="vault-link" id="vRestore">Restore from backup</button>
      <button type="button" class="vault-link danger" id="vReset">Forgot everything? Reset this device</button>
    </div>`);
  const f = screen.querySelector("#vaultForm");
  f.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const wait = blockedUntil - Date.now();
    if(wait > 0) return setMsg(screen, `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`);
    const pw = f.querySelector("#vPw").value;
    if(!pw) return setMsg(screen, "Enter your password.");
    setMsg(screen, ""); busy(screen, true, "Unlocking…");
    askNotifyPermission();
    try{
      await unlockWithPassword(pw, rec);
      fails = 0; finishBoot();
    }catch(err){
      busy(screen, false); fails++;
      f.querySelector("#vPw").value = ""; f.querySelector("#vPw").focus();
      if(fails >= 5) blockedUntil = Date.now() + Math.min(300000, 2000 * Math.pow(2, fails - 5));
      setMsg(screen, "That password didn't work.");
    }
  });
  screen.querySelector("#vUseRec").addEventListener("click", ()=>showRecover(rec));
  screen.querySelector("#vRestore").addEventListener("click", showRestore);
  screen.querySelector("#vReset").addEventListener("click", ()=>showReset(rec));
}

/* ----- Recovery-key unlock ----- */
function showRecover(rec){
  view(`<h1 id="vaultTitle">Use your recovery key</h1>
    <p class="vault-sub">${rec.rec ? "Enter the recovery key, then choose a new master password." : "This vault has no recovery key. Without the password the data cannot be recovered."}</p>
    <form id="vaultForm" novalidate>
      <label class="vault-label" for="vRk">Recovery key</label>
      <input id="vRk" class="vault-plain" type="text" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-…" ${rec.rec ? "" : "disabled"}>
      ${eyeField("vPw", "New master password", `At least ${MIN_PW} characters`, "new-password")}
      ${eyeField("vPw2", "Confirm new password", "", "new-password")}
      <div class="vault-msg" role="alert"></div>
      <button class="vault-btn" type="submit" data-primary ${rec.rec ? "" : "disabled"}>Unlock &amp; set password</button>
    </form>
    <div class="vault-links"><button type="button" class="vault-link" id="vBack">Back</button></div>`);
  screen.querySelector("#vBack").addEventListener("click", ()=>showUnlock(rec));
  const f = screen.querySelector("#vaultForm");
  f.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const a = f.querySelector("#vPw").value, b = f.querySelector("#vPw2").value;
    if(a.length < MIN_PW) return setMsg(screen, `Use at least ${MIN_PW} characters.`);
    if(a !== b) return setMsg(screen, "The two passwords don't match.");
    setMsg(screen, ""); busy(screen, true, "Working…");
    try{
      await unlockWithRecovery(f.querySelector("#vRk").value, rec);
      // Re-wrap the data key under the new password (needs an extractable copy once).
      const rk = recoveryDecode(f.querySelector("#vRk").value);
      const ex = await unwrapDek(rec.rec, await recoveryKEK(rk), true);
      const salt = rand(16);
      record.kdf = { alg:"PBKDF2-SHA256", iter:ITER, salt:toB64(salt) };
      record.pw = await wrapDek(ex, await deriveKEK(a, salt, ITER));
      await persist();
      finishBoot();
    }catch(err){ busy(screen, false); unlocked = false; dek = null; setMsg(screen, "That recovery key didn't work."); }
  });
}

/* ----- Restore from an encrypted file (backup or the synced GitHub file) ----- */
function showRestore(){
  const rec = readRecord();
  view(`<h1 id="vaultTitle">Restore from encrypted backup</h1>
    <p class="vault-sub">Choose a Flow backup file, or the synced file from your GitHub repo (<code>data/flow-board.json</code>), then enter the master password it was encrypted with. This replaces the vault on this device.</p>
    <form id="vaultForm" novalidate>
      <label class="vault-label" for="vFile">Encrypted file</label>
      <input id="vFile" class="vault-plain" type="file" accept=".json,application/json">
      <button type="button" class="vault-btn ghost" id="vFetch">Fetch from this site</button>
      ${eyeField("vPw", "Master password of that backup", "", "current-password")}
      <div class="vault-msg" role="alert"></div>
      <button class="vault-btn" type="submit" data-primary>Restore</button>
    </form>
    <div class="vault-links"><button type="button" class="vault-link" id="vBack">Back</button></div>`);
  let text = null;
  const f = screen.querySelector("#vaultForm");
  screen.querySelector("#vBack").addEventListener("click", ()=> rec ? showUnlock(rec) : showSetup());
  f.querySelector("#vFile").addEventListener("change", async (e)=>{ const file = e.target.files[0]; if(file){ text = await file.text(); setMsg(screen, "File loaded.", true); } });
  f.querySelector("#vFetch").addEventListener("click", async ()=>{
    try{
      const r = await fetch("data/flow-board.json", { cache:"no-store" });
      if(!r.ok) throw 0; text = await r.text(); setMsg(screen, "Fetched the encrypted file from this site.", true);
    }catch(e){ setMsg(screen, "No file found on this site."); }
  });
  f.addEventListener("submit", async (e)=>{
    e.preventDefault();
    if(!text) return setMsg(screen, "Choose or fetch an encrypted file first.");
    const pw = f.querySelector("#vPw").value; if(!pw) return setMsg(screen, "Enter the password.");
    if(rec && !confirm("This replaces the vault currently on this device. Continue?")) return;
    setMsg(screen, ""); busy(screen, true, "Restoring…");
    try{ await restoreFromText(text, pw); finishBoot(); }
    catch(err){ busy(screen, false); unlocked = false; dek = null; setMsg(screen, "Couldn't decrypt that file with this password."); }
  });
}

/* ----- Reset ----- */
function showReset(rec){
  view(`<h1 id="vaultTitle">Reset this device?</h1>
    <p class="vault-sub">This <b>permanently erases the encrypted data stored in this browser</b>. It does not touch GitHub, so you can restore later from the synced file if you remember the password. If you have neither the password nor a recovery key, the encrypted data is gone for good.</p>
    <label class="vault-label" for="vType">Type <b>RESET</b> to confirm</label>
    <input id="vType" class="vault-plain" type="text" autocomplete="off">
    <div class="vault-msg" role="alert"></div>
    <button class="vault-btn danger" type="button" id="vGo" data-primary>Erase this device</button>
    <div class="vault-links"><button type="button" class="vault-link" id="vBack">Cancel</button></div>`);
  screen.querySelector("#vBack").addEventListener("click", ()=>showUnlock(rec));
  screen.querySelector("#vGo").addEventListener("click", ()=>{
    if(screen.querySelector("#vType").value.trim() !== "RESET") return setMsg(screen, "Type RESET exactly to confirm.");
    wipeAll(); location.reload();
  });
}

/* ---------- notification permission (needs a user gesture) ---------- */
function askNotifyPermission(){
  try{ if("Notification" in window && Notification.permission === "default") Notification.requestPermission(); }catch(e){}
}

/* ---------- boot the application after unlock ---------- */
function loadScript(src){
  return new Promise((res, rej)=>{
    const s = document.createElement("script");
    s.src = src; s.async = false; s.onload = res; s.onerror = ()=>rej(new Error("load"));
    document.body.appendChild(s);
  });
}
async function finishBoot(){
  screen.hidden = true; screen.innerHTML = "";
  document.body.classList.remove("locked");
  startIdleWatch();
  try{
    await loadScript("./js/script.js");
    await loadScript("./js/features.js");
  }catch(e){
    document.body.classList.add("locked"); screen.hidden = false;
    screen.innerHTML = SHELL_HTML(`<h1 id="vaultTitle">Couldn't load the app</h1><p class="vault-sub">Check your connection and reload the page.</p>`);
  }
  resolveBoot();
}

/* ---------- public surface (no keys, no secrets) ---------- */
window.FlowVault = Object.freeze({
  lock, getPrefs, setPrefs, hasRecovery,
  changePassword, newRecoveryKey, exportBackup,
  encryptRemote, decryptRemote,
  minPassword: MIN_PW, scorePassword,
  isUnlocked: ()=>unlocked,
  showRecoveryKey: (k)=>{ document.body.classList.add("locked"); showRecoveryKey(k, ()=>{ screen.hidden = true; screen.innerHTML = ""; document.body.classList.remove("locked"); }); },
  flush
});

/* ---------- start ---------- */
(function start(){
  document.body.classList.add("locked");
  // The lock screen follows the system theme until a profile (and its saved theme) is loaded.
  try{ document.body.dataset.theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; }catch(e){}
  if(!hasCrypto){ showUnsupported(); return; }
  const rec = readRecord();
  if(rec) showUnlock(rec); else showSetup();
})();

})();
