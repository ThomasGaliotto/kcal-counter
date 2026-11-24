// Service worker: lets the app open and show the last known data without a connection.
// Network first everywhere (the server always has the freshest version); the cache is only a fallback.
// Meals saved offline are queued by the page itself (app.js, IndexedDB), not here.
const SHELL = "kcal-shell-v1";
const DATA = "kcal-data-v1";
const SHELL_FILES = ["/", "/app.js", "/style.css", "/manifest.webmanifest", "/logo.svg", "/icon-192.png", "/favicon-32.png"];
// read-only API answers worth showing offline (per signed-in user: the page clears them on logout)
const CACHED_API = ["/api/me", "/api/goal", "/api/meals", "/api/energy", "/api/streak", "/api/auth/config"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const api = url.pathname.startsWith("/api/");
  if (api && !CACHED_API.includes(url.pathname)) return;
  const bucket = api ? DATA : SHELL;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(bucket).then((c) => c.put(req, copy));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreVary: true })
        || (req.mode === "navigate" ? await caches.match("/") : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
