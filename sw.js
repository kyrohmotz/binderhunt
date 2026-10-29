/* BinderHunt service worker.
   VERSION only names the caches. Bump it when the caching strategy changes
   so activate can drop the previous caches. Shell files are network-first,
   and a navigation falls back to the cached shell after a short timeout,
   so a deploy still reaches people when VERSION was not bumped alongside
   index.html, js, or css. Any change to this file is a new worker: it
   calls skipWaiting immediately and takes over, and the page asks before
   it reloads. */
const VERSION = "bh-5";
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
  "js/binder-turn.js",
  "js/card-inspect.js",
  "css/binder.css",
  "css/polish.css",
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
const NAV_TIMEOUT = 4000;
let forceOffline = false;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

self.addEventListener("install", event => {
  // Call skipWaiting before any await. Gating it on a finished precache left
  // the worker in waiting when one shell file hung, and the next navigation
  // never finished.
  self.skipWaiting();
  event.waitUntil(precacheShell());
});

async function precacheShell() {
  let cache;
  try { cache = await caches.open(SHELL); }
  catch (e) { return; }
  await Promise.all(SHELL_FILES.map(async path => {
    try {
      const url = new URL(path, self.registration.scope);
      const response = await withTimeout(fetch(url, { cache: "no-store" }), NAV_TIMEOUT);
      if (!good(response)) return;
      await cache.put(url, await materialize(response));
    } catch (e) {}
  }));
}

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith("bh-") && !KEEP.has(name)).map(name => caches.delete(name)));
      await purgeUnusable();
    } catch (e) {}
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  const data = event.data;
  if (data === "SKIP_WAITING" || (data && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
    return;
  }
  if (data === "bh-offline") { forceOffline = true; return; }
  if (data === "bh-online") { forceOffline = false; return; }
  if (data !== "bh-version") return;
  const payload = { version: VERSION };
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

/* Card art comes from two CDNs, and TCGdex serves some files without CORS
   headers. Fetching those in cors mode fails, which used to swap real cards
   for a placeholder. Try cors first so the file can be cached; when the CDN
   refuses, remember the URL and let the browser load it the way the page
   asked (a plain <img> is no-cors and renders fine). */
const corsRefused = new Set();
function noteCorsRefused(url) {
  if (corsRefused.size > 4000) corsRefused.clear();
  corsRefused.add(url);
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

async function networkFirst(cacheName, request, cap, timeoutMs) {
  if (!offlineNow()) {
    try {
      const response = timeoutMs ? await withTimeout(fetch(request), timeoutMs) : await fetch(request);
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

function offlineDocument() {
  return new Response("<!doctype html><title>BinderHunt</title><p>You're offline. The hunt will be here when you reconnect.</p>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function cachedShell(request) {
  try {
    const cache = await caches.open(SHELL);
    const exact = await cache.match(request, { ignoreSearch: true });
    if (exact && good(exact)) return exact;
    const shell = await cache.match(new URL("index.html", self.registration.scope));
    if (shell && good(shell)) return shell;
  } catch (e) {}
  return null;
}

async function navigation(event, request) {
  if (!offlineNow()) {
    try {
      const response = await withTimeout(fetch(request), NAV_TIMEOUT);
      if (good(response)) {
        const copy = response.clone();
        try {
          event.waitUntil((async () => {
            try {
              const cache = await caches.open(SHELL);
              const body = await materialize(copy);
              await cache.put(request, body.clone());
              await cache.put(new URL("index.html", self.registration.scope), body);
            } catch (e) {}
          })());
        } catch (e) {}
        return response;
      }
      return (await cachedShell(request)) || response || offlineDocument();
    } catch (e) {}
  }
  return (await cachedShell(request)) || offlineDocument();
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
  /* A network error makes the page fall back to its own placeholder, which
     fits wherever the image sits (the binder has a dark one). */
  if (offlineNow()) return Response.error();
  if (!corsRefused.has(request.url)) {
    try {
      const response = await fetch(request.url, { mode: "cors", credentials: "omit", redirect: "follow" });
      if (good(response)) {
        await putLimited(IMG, request, response.clone(), IMG_CAP);
        return response;
      }
      return response;
    } catch (e) {
      noteCorsRefused(request.url);
    }
  }
  if (request.mode === "cors") return Response.error();
  try {
    return await fetch(request);
  } catch (e) {
    return Response.error();
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
    event.respondWith(navigation(event, request).catch(() => offlineDocument()));
    return;
  }
  if (isData(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (isShell(url)) {
    event.respondWith(networkFirst(SHELL, request, 0, NAV_TIMEOUT).catch(() => cached(SHELL, request).then(hit => hit || new Response("Offline", { status: 503, headers: { "Cache-Control": "no-store" } }))));
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
