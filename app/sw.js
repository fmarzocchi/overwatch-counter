// Service worker: guscio dell'app cache-first (aggiornato in sottofondo), data.json network-first
// con ripiego sulla copia salvata se offline, icone degli eroi cache-first.
const VERSION = "v4";
const SHELL = `owc-shell-${VERSION}`;
const DATA = "owc-data";
const IMG = "owc-img";
const SHELL_FILES = ["./", "index.html", "style.css", "app.js", "recommend.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("owc-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function dataFirst(req) {
  const cache = await caches.open(DATA);
  const key = new URL(new URL(req.url).pathname, self.registration.scope).href; // senza ?t=
  try {
    const res = await fetch(req, { cache: "no-store" });
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key)) ?? new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
  }
}

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

async function shellFirst(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit ?? (await update) ?? new Response("offline", { status: 503 });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && (url.pathname.endsWith("/data.json") || url.pathname.includes("/divisions/"))) {
    return e.respondWith(dataFirst(req));
  }
  if (req.destination === "image") return e.respondWith(cacheFirst(IMG, req));
  if (url.origin === location.origin) return e.respondWith(shellFirst(req));
});
