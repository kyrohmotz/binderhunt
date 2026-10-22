/* BinderHunt service worker. Bump VERSION when the caching strategy changes.
   Any edit to this file is a new deploy: skipWaiting lets it take over,
   and the page asks before it reloads. */
const VERSION = "bh-1";
const SHELL = "bh-shell-" + VERSION;
const DATA = "bh-data-" + VERSION;
const IMG = "bh-img-" + VERSION;
const API = "bh-api-" + VERSION;
const IMG_CAP = 300;
const API_CAP = 80;

const SHELL_FILES = [
  "index.html",
  "css/daily.css",
  "js/daily-core.js",
  "js/daily-ui.js",
  "manifest.webmanifest",
  "favicon-32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable.png",
  "icon-maskable-192.png",
  "assets/brand/two-toads-logo.png",
  "fonts/sniglet-800.woff2",
  "fonts/nunito.woff2",
  "fonts/nunito-bold.woff2",
  "fonts/lato-700-italic.woff2",
  "fonts/baloo-600.ttf",
  "fonts/fraunces-500.woff2"
];

const KEEP = new Set([SHELL, DATA, IMG, API]);
let forceOffline = false;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("bh-") && !KEEP.has(name)).map(name => caches.delete(name)));
    await purgeUnusable();
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: "bh-updated", version: VERSION, gen: self.__BH_GEN || 1 });
  })());
});

self.addEventListener("message", event => {
  if (event.data === "bh-offline") { forceOffline = true; return; }
  if (event.data === "bh-online") { forceOffline = false; return; }
  if (event.data !== "bh-version") return;
  const payload = { version: VERSION, gen: self.__BH_GEN || 1 };
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(payload);
  else if (event.source) event.source.postMessage(payload);
});

function good(response) {
  return !!response && response.ok === true && response.type !== "opaque" && response.type !== "opaqueredirect" && response.status >= 200 && response.status < 300;
}

async function purgeUnusable() {
  const names = await caches.keys();
  await Promise.all(names.map(async name => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    await Promise.all(keys.map(async request => {
      const response = await cache.match(request);
      if (!good(response)) {
        try { await cache.delete(request); } catch (e) {}
      }
    }));
  }));
}

async function materialize(response) {
  const blob = await response.clone().blob();
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(blob, { status: response.status, statusText: response.statusText, headers });
}

async function putLimited(cacheName, request, response, cap) {
  if (!good(response)) return;
  const cache = await caches.open(cacheName);
  let body;
  try { body = await materialize(response); }
  catch (e) { return; }
  try { await cache.delete(request); } catch (e) {}
  try { await cache.put(request, body); }
  catch (e) { return; }
  if (!cap) return;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - cap; i++) {
    try { await cache.delete(keys[i]); } catch (e) {}
  }
}

function scopePath() {
  const path = new URL("./", self.registration.scope).pathname;
  return path.endsWith("/") ? path : path + "/";
}

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function relPath(url) {
  const base = scopePath();
  if (!sameOrigin(url) || !url.pathname.startsWith(base)) return "";
  return url.pathname.slice(base.length);
}

function isData(url) {
  return /^data\/[^/]+\.json$/.test(relPath(url));
}

function isShell(url) {
  const path = relPath(url);
  if (!path) return false;
  if (path === "sw.js") return false;
  return path === "index.html"
    || path === "manifest.webmanifest"
    || path.startsWith("js/")
    || path.startsWith("css/")
    || path.startsWith("fonts/")
    || path.startsWith("assets/")
    || path === "favicon-32.png"
    || path === "apple-touch-icon.png"
    || path === "og.png"
    || /^icon-/.test(path);
}

function isCardImage(url) {
  return url.origin === "https://assets.tcgdex.net" || url.origin === "https://images.pokemontcg.io";
}

function isCatalog(url) {
  return url.origin === "https://api.tcgdex.net" || url.origin === "https://api.pokemontcg.io";
}

function offlineNow() {
  return forceOffline || !!(self.navigator && self.navigator.onLine === false);
}

function cardFallback() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 63 88"><rect width="63" height="88" rx="8" fill="#F8F7EF" stroke="#1F1F1E" stroke-width="2.5"/><rect x="7" y="8" width="49" height="72" rx="5" fill="#E4E7DA" stroke="#1F1F1E" stroke-width="1.5"/><circle cx="24" cy="34" r="7" fill="#ABB28D" stroke="#1F1F1E" stroke-width="1.5"/><circle cx="40" cy="34" r="7" fill="#F6C9C9" stroke="#1F1F1E" stroke-width="1.5"/><circle cx="24" cy="34" r="1.4" fill="#1F1F1E"/><circle cx="40" cy="34" r="1.4" fill="#1F1F1E"/></svg>';
  return new Response(svg, {
    status: 200,
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }
  });
}

async function cached(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit && good(hit)) return hit;
  if (hit) {
    try { await cache.delete(request); } catch (e) {}
  }
  return null;
}

async function networkFirst(cacheName, request, cap) {
  if (!offlineNow()) {
    try {
      const response = await fetch(request);
      if (good(response)) {
        await putLimited(cacheName, request, response.clone(), cap || 0);
        return response;
      }
      const hit = await cached(cacheName, request);
      return hit || response;
    } catch (e) {}
  }
  const hit = await cached(cacheName, request);
  if (hit) return hit;
  return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function navigation(request) {
  if (!offlineNow()) {
    try {
      const response = await fetch(request);
      if (good(response)) {
        const cache = await caches.open(SHELL);
        try {
          const copy = await materialize(response);
          await cache.put(request, copy.clone());
          await cache.put(new URL("index.html", self.registration.scope), copy);
        } catch (e) {}
        return response;
      }
    } catch (e) {}
  }
  const cache = await caches.open(SHELL);
  const exact = await cache.match(request, { ignoreSearch: true });
  if (exact && good(exact)) return exact;
  const shell = await cache.match(new URL("index.html", self.registration.scope));
  if (shell && good(shell)) return shell;
  return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(request);
  if (offlineNow()) {
    if (hit && good(hit)) return hit;
    if (hit) { try { await cache.delete(request); } catch (e) {} }
    return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const fresh = fetch(request).then(async response => {
    if (good(response)) {
      try { await cache.put(request, await materialize(response)); } catch (e) {}
    }
    return response;
  }).catch(() => null);
  if (hit && good(hit)) {
    fresh.catch(() => {});
    return hit;
  }
  if (hit) {
    try { await cache.delete(request); } catch (e) {}
  }
  const response = await fresh;
  if (response) return response;
  return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function imageCache(request) {
  const hit = await cached(IMG, request);
  if (hit) {
    try {
      const cache = await caches.open(IMG);
      await cache.delete(request);
      await cache.put(request, hit.clone());
    } catch (e) {}
    return hit;
  }
  if (offlineNow()) return cardFallback();
  try {
    const response = await fetch(request.url, { mode: "cors", credentials: "omit", redirect: "follow" });
    if (good(response)) {
      await putLimited(IMG, request, response.clone(), IMG_CAP);
      return response;
    }
    return response;
  } catch (e) {
    return cardFallback();
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try { url = new URL(request.url); }
  catch (e) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (sameOrigin(url) && relPath(url) === "sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(navigation(request).catch(() => new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })));
    return;
  }
  if (isData(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (isShell(url)) {
    event.respondWith(networkFirst(SHELL, request, 0).catch(() => cached(SHELL, request).then(hit => hit || new Response("Offline", { status: 503 }))));
    return;
  }
  if (isCardImage(url)) {
    event.respondWith(imageCache(request));
    return;
  }
  if (isCatalog(url)) {
    event.respondWith(networkFirst(API, request, API_CAP).catch(() => cached(API, request).then(hit => hit || new Response("offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }))));
  }
});
