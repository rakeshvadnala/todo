/* Flow service worker — keeps the app usable offline.
   Strategy: network first (so updates always arrive), falling back to the
   cache when offline. Cross-origin requests (GitHub sync) are never touched. */
const CACHE = "flow-v5";
const SHELL = [
  "./", "./index.html", "./css/style.css", "./css/custom-ui.css", "./css/features.css",
  "./js/vault.js", "./js/script.js", "./js/custom-ui.js", "./js/features.js",
  "./image/todo-logo.png", "./favicon.ico", "./manifest.webmanifest"
];

self.addEventListener("install", (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", (e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k !== CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())
  );
});
self.addEventListener("fetch", (e)=>{
  const req = e.request;
  if(req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res=>{
      if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=>c.put(req, copy)); }
      return res;
    }).catch(()=>caches.match(req).then(hit=>hit || caches.match("./index.html")))
  );
});
self.addEventListener("notificationclick", (e)=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type:"window" }).then(list=>{
    if(list.length) return list[0].focus();
    return self.clients.openWindow("./");
  }));
});
