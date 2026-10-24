// Installability, offline launch, and the service-worker update toast.
// Serves the site under /binderhunt/ the way GitHub Pages does.
// Run: npx -y node@22 scripts/test_pwa.mjs
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8796;
const vendor = "/tmp/binderhunt-playwright";
const shotDir = "/opt/cursor/artifacts";
mkdirSync(shotDir, { recursive: true });

if (!existsSync(vendor + "/node_modules/playwright-core/package.json")) {
  mkdirSync(vendor, { recursive: true });
  const install = spawnSync("npm", ["install", "--prefix", vendor, "playwright-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
const require = createRequire(vendor + "/node_modules/playwright-core/package.json");
const { chromium } = require("playwright-core");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml"
};

let swVersion = null;
let stallShell = false;
let stallNav = false;
const hung = new Set();
const server = http.createServer((req, res) => {
  const fetchMode = req.headers["sec-fetch-mode"];
  const fetchDest = req.headers["sec-fetch-dest"];
  if (stallNav && (fetchMode === "navigate" || fetchDest === "document")) {
    hung.add(res);
    setTimeout(() => {
      hung.delete(res);
      if (res.writableEnded) return;
      res.writeHead(504, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("navigation stalled");
    }, 20000);
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/binderhunt") pathname = "/binderhunt/";
  if (!pathname.startsWith("/binderhunt/")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  let rel = pathname.slice("/binderhunt/".length);
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (stallShell && rel === "fonts/fraunces-500.woff2") {
    hung.add(res);
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("missing");
    return;
  }
  let body = readFileSync(file);
  const ext = file.slice(file.lastIndexOf("."));
  const headers = {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": rel === "sw.js" ? "no-store" : "no-cache"
  };
  if (rel === "sw.js" && swVersion) {
    let text = body.toString("utf8");
    const marker = 'const VERSION = "bh-3"';
    if (!text.includes(marker)) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("sw.js VERSION marker missing");
      return;
    }
    text = text.replace(marker, 'const VERSION = "' + swVersion + '"');
    text += "\n/* deployed " + swVersion + " */\n";
    body = Buffer.from(text);
  }
  res.writeHead(200, headers);
  res.end(body);
});

const problems = [];
function note(ok, name, extra) {
  if (ok) console.log("ok", name);
  else {
    const line = name + (extra ? " — " + extra : "");
    problems.push(line);
    console.log("FAIL", line);
  }
}

const baseBoot = `(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
})();`;

const wishCard = { id: "base1-4", name: "Charizard", set: "Base", setId: "base1", number: "4", rarity: "Rare Holo", img: "https://assets.tcgdex.net/en/base/base1/4/high.webp", thumb: "https://assets.tcgdex.net/en/base/base1/4/low.webp", price: 400 };
const collectionBoot = `
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("binderhuntWish", JSON.stringify(${JSON.stringify([wishCard])}));
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[{id:"btest",name:"Jungle",color:"#ABB28D",theme:{kind:"none"},cards:[],charm:"none"}]}));
  localStorage.setItem("bh.pwa.v1", JSON.stringify({swipes:0,dismissed:true}));
`;

await new Promise(resolve => server.listen(PORT, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + PORT;
const home = origin + "/binderhunt/";

let browser;
function releaseHung() {
  stallShell = false;
  stallNav = false;
  for (const res of hung) {
    try { res.destroy(); } catch (e) {}
  }
  hung.clear();
}
function shutdown(code) {
  releaseHung();
  return (browser ? browser.close().catch(() => {}) : Promise.resolve()).finally(() => {
    server.close();
    process.exit(code);
  });
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function watch(page, bag) {
  page.on("pageerror", err => bag.push("pageerror: " + String(err && err.message || err).split("\n")[0]));
  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!text) return;
    bag.push(text.split("\n")[0]);
  });
}

async function shot(page, name) {
  const file = join(shotDir, name + ".png");
  await page.screenshot({ path: file, fullPage: false });
  console.log("screenshot", file);
  return file;
}

try {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const sw = readFileSync(join(root, "sw.js"), "utf8");
  for (const key of ["binderhuntWish", "bh.binders.v1", "bh.owned.v1"]) {
    note(html.includes('"' + key + '"') || html.includes("'" + key + "'") || html.includes(key), "storage key still in the app: " + key);
  }
  note(!/api\.scrydex\.com|scrydex\.com\/v/.test(html + sw), "no new Scrydex host in the app or service worker");
  note(/const IMG_CAP = 300/.test(sw) && /keys\.length - cap/.test(sw), "image cache is capped at about 300");
  note(/type !== "opaque"/.test(sw) && /response\.ok/.test(sw), "error and opaque responses are not stored");
  note(/skipWaiting\(/.test(sw) && /New version, tap to refresh/.test(html), "skipWaiting plus the refresh toast");
  const install = sw.slice(sw.indexOf('addEventListener("install"'), sw.indexOf('addEventListener("activate"'));
  note(install.includes("self.skipWaiting()") && install.indexOf("self.skipWaiting()") < install.indexOf("event.waitUntil"), "skipWaiting runs at the start of install");
  note(!sw.includes("addAll") && install.includes("precacheShell"), "one failed shell fetch cannot reject install");
  note(/const NAV_TIMEOUT = 4000/.test(sw) && /withTimeout\(fetch\(request\), NAV_TIMEOUT\)/.test(sw), "navigations time out and fall back to the cached shell");
  note(sw.includes("clients.claim()") && sw.includes("SKIP_WAITING"), "activate claims clients and a waiting worker can be skipped");
  note(!/__BH_GEN|bh\.sw\.gen/.test(html + "\n" + sw), "update flow does not depend on a generation counter");
  note(html.includes('postMessage("SKIP_WAITING")') && html.includes("controllerchange") && /setInterval\(look, 30 \* 60 \* 1000\)/.test(html), "toast follows a real controller change and open tabs check for deploys");
  note(sw.includes("async function staleWhileRevalidate") && sw.includes("isData(url)"), "data JSON uses stale-while-revalidate");

  const manifestRes = await fetch(home + "manifest.webmanifest");
  const manifest = await manifestRes.json();
  note(manifestRes.ok && manifestRes.headers.get("content-type").includes("manifest"), "manifest is served as a manifest");
  note(manifest.name === "BinderHunt" && manifest.short_name === "BinderHunt", "manifest name");
  note(manifest.start_url === "/binderhunt/" && manifest.scope === "/binderhunt/" && manifest.id === "/binderhunt/", "start_url and scope are the /binderhunt/ subpath", JSON.stringify({ start: manifest.start_url, scope: manifest.scope, id: manifest.id }));
  note(manifest.display === "standalone", "display standalone");
  note(manifest.background_color === "#F8F7EF" && manifest.theme_color === "#F8F7EF", "pastel paper theme and background", manifest.theme_color + " " + manifest.background_color);
  const icons = manifest.icons || [];
  const has = (size, purpose) => icons.some(icon => String(icon.sizes).includes(size) && String(icon.purpose || "any").split(/\s+/).includes(purpose));
  note(has("192x192", "any") && has("512x512", "any"), "any icons at 192 and 512");
  note(has("192x192", "maskable") && has("512x512", "maskable"), "maskable icons at 192 and 512");
  for (const icon of icons) {
    const res = await fetch(home + icon.src);
    const buf = Buffer.from(await res.arrayBuffer());
    const size = pngSize(buf);
    const [w, h] = String(icon.sizes).split("x").map(Number);
    note(res.ok && size && size.width === w && size.height === h, "icon " + icon.src + " is " + icon.sizes, size ? size.width + "x" + size.height : "not a png");
  }

  browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  async function freshPage(width, height, boot, options = {}) {
    const errors = [];
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      isMobile: width < 600,
      hasTouch: width < 600,
      userAgent: options.userAgent,
      serviceWorkers: "allow"
    });
    const requests = [];
    context.on("request", req => requests.push(req.url()));
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    watch(page, errors);
    if (boot) await page.addInitScript(boot);
    return { context, page, errors, requests };
  }

  async function fireInstallPrompt(page) {
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = () => Promise.resolve();
      event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
      window.dispatchEvent(event);
    });
  }

  // First visit, before onboarding: no install hint.
  {
    const { context, page, errors } = await freshPage(390, 844, baseBoot + `
      localStorage.setItem("binderhuntWish", "[]");
      localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
      localStorage.setItem("bh.pwa.v1", JSON.stringify({swipes:12}));
    `);
    await page.goto(home, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#onboard:not([hidden])");
    await fireInstallPrompt(page);
    await sleep(100);
    const hintHidden = await page.locator("#installHint").isHidden();
    note(hintHidden, "install hint stays hidden before onboarding");
    note(!errors.length, "no console errors on first visit", errors.slice(0, 4).join(" | "));
    await shot(page, "screenshot_pwa_onboarding_390");
    await context.close();
  }

  // Engagement gate, dismissal, and the iOS share hint.
  {
    const { context, page } = await freshPage(390, 844, baseBoot + `
      localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
      localStorage.setItem("binderhuntWish", "[]");
      localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
      localStorage.setItem("bh.pwa.v1", JSON.stringify({swipes:9}));
    `);
    await page.goto(home, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof maybeInstallHint === "function");
    await fireInstallPrompt(page);
    note(await page.locator("#installHint").isHidden(), "9 swipes does not show the install hint");
    await page.evaluate(() => { const data = loadPwa(); data.swipes = 10; savePwa(data); maybeInstallHint(); });
    await page.waitForSelector("#installHint:not([hidden])");
    const text = await page.locator("#installHintText").innerText();
    note(text === "Add BinderHunt to your home screen", "hint copy after 10 swipes", text);
    note(await page.locator("#installGo").isVisible(), "Add button is available when the browser can install");
    await shot(page, "screenshot_pwa_install_hint_390");
    await page.click("#installDismiss");
    note(await page.locator("#installHint").isHidden(), "Not now hides the hint");
    const dismissed = await page.evaluate(() => loadPwa().dismissed === true);
    note(dismissed, "dismissal is remembered");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof maybeInstallHint === "function");
    await fireInstallPrompt(page);
    await sleep(50);
    note(await page.locator("#installHint").isHidden(), "hint stays dismissed after reload");
    await context.close();
  }

  {
    const ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const { context, page } = await freshPage(390, 844, baseBoot + `
      localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
      localStorage.setItem("binderhuntWish", "[]");
      localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[{id:"b1",name:"Jungle",color:"#ABB28D",theme:{kind:"none"},cards:[],charm:"none"}]}));
      localStorage.removeItem("bh.pwa.v1");
    `, { userAgent: ios });
    await page.goto(home, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#installHint:not([hidden])");
    const text = await page.locator("#installHintText").innerText();
    note(/Share/.test(text) && /Add to Home Screen/.test(text), "iOS hint says Share, then Add to Home Screen", text);
    note(await page.locator("#installGo").isHidden(), "iOS hint has no dead Add button");
    await shot(page, "screenshot_pwa_ios_install_390");
    await context.close();
  }

  // App shell, offline launch, both viewports.
  const errors = [];
  const requests = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "allow"
  });
  context.on("request", req => requests.push(req.url()));
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  watch(page, errors);
  await page.addInitScript(baseBoot + collectionBoot);
  await page.goto(home, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.includes("/binderhunt/sw.js"));
  const regScope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.scope : "";
  });
  note(regScope === home, "service worker scope is /binderhunt/", regScope);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const img = document.querySelector("#deck .card img");
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem("bh.recent.v1") || "[]").length > 0; } catch (e) { return false; }
  });

  const metas = await page.evaluate(() => {
    const pick = name => {
      const el = document.querySelector('meta[name="' + name + '"]');
      return el ? el.getAttribute("content") : "";
    };
    return {
      viewport: pick("viewport"),
      capable: pick("apple-mobile-web-app-capable"),
      status: pick("apple-mobile-web-app-status-bar-style"),
      theme: pick("theme-color"),
      touch: !!document.querySelector('link[rel="apple-touch-icon"]')
    };
  });
  note(metas.viewport.includes("viewport-fit=cover"), "viewport-fit=cover", metas.viewport);
  note(metas.capable === "yes", "apple-mobile-web-app-capable");
  note(metas.status === "default", "apple status bar style", metas.status);
  note(metas.theme === "#F8F7EF", "theme-color meta", metas.theme);
  note(metas.touch, "apple-touch-icon link");

  async function brokenImages() {
    return page.evaluate(() => [...document.images].filter(img => img.complete && img.naturalWidth === 0).map(img => img.currentSrc || img.src || img.alt));
  }
  let broken = await brokenImages();
  note(!broken.length, "no broken images at 390x844", broken.slice(0, 4).join(" | "));
  const onlineErrors = errors.splice(0, errors.length);
  note(!onlineErrors.length, "no console errors at 390x844", onlineErrors.slice(0, 6).join(" | "));
  await shot(page, "screenshot_pwa_hunt_390");

  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  broken = await brokenImages();
  note(!broken.length, "no broken images at 1440x900", broken.slice(0, 4).join(" | "));
  const wideErrors = errors.splice(0, errors.length);
  note(!wideErrors.length, "no console errors at 1440x900", wideErrors.slice(0, 6).join(" | "));
  await shot(page, "screenshot_pwa_hunt_1440");
  await page.setViewportSize({ width: 390, height: 844 });

  const seenName = await page.evaluate(() => {
    const card = document.querySelector("#deck .card");
    return card && card.card ? card.card.name : "";
  });
  note(!!seenName, "deck painted a card before going offline", seenName);

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#offlineNote:not([hidden])");
  const offlineText = await page.locator("#offlineNote").innerText();
  note(/offline/i.test(offlineText) && !/error/i.test(offlineText), "friendly offline note", offlineText);
  await page.waitForFunction(() => document.querySelector("#deck .card") || document.querySelector("#deck .empty-state"), null, { timeout: 15000 });
  const offlineDeck = await page.evaluate(() => {
    const card = document.querySelector("#deck .card");
    const empty = document.querySelector("#deck .empty-state");
    const warn = document.querySelector("#deck .warn");
    return {
      name: card && card.card ? card.card.name : "",
      empty: empty ? empty.textContent : "",
      warn: warn ? warn.textContent : ""
    };
  });
  note(!offlineDeck.warn && !/didn't respond|Check your connection/i.test(offlineDeck.empty), "offline deck is not an error", JSON.stringify(offlineDeck));
  note(!!offlineDeck.name, "offline deck still shows a cached card", offlineDeck.name || offlineDeck.empty);
  broken = await brokenImages();
  note(!broken.length, "no broken images offline", broken.slice(0, 4).join(" | "));
  await page.locator(".tabs [data-tab=binders]").click();
  await page.waitForSelector("#shelf");
  const bindersText = await page.locator("#bindersScroll").innerText();
  note(bindersText.includes("Jungle"), "binder still opens from localStorage", bindersText.slice(0, 180));
  note(/1 cards/.test(bindersText), "wishlist still opens from localStorage", bindersText.slice(0, 180));
  const keys = await page.evaluate(() => ({
    wish: localStorage.getItem("binderhuntWish"),
    binders: localStorage.getItem("bh.binders.v1"),
    owned: localStorage.getItem("bh.owned.v1")
  }));
  note(JSON.parse(keys.wish)[0].id === "base1-4", "binderhuntWish key unchanged");
  note(JSON.parse(keys.binders).binders[0].name === "Jungle", "bh.binders.v1 key unchanged");
  note(JSON.parse(keys.owned).v === 1, "bh.owned.v1 key unchanged");
  const offlineErrors = errors.splice(0, errors.length).filter(line => !/ERR_|Failed to load resource|net::/i.test(line));
  note(!offlineErrors.length, "no console errors on offline reload", offlineErrors.slice(0, 6).join(" | "));
  await shot(page, "screenshot_pwa_offline_390");

  // install, reload, offline, reload, back online, then a new sw.js.
  // One shell file never answers. A navigation is stalled for 20s. The next
  // worker must not stay waiting, and a tap must finish the reload.
  await context.setOffline(false);
  note(await page.locator("#updateToast").isHidden(), "toast stays hidden until a new service worker takes over");
  stallShell = true;
  swVersion = "bh-4";
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
  });
  await page.waitForSelector("#updateToast:not([hidden])", { timeout: 20000 });
  const workerState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const version = await new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 4000);
      channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data); };
      const sw = navigator.serviceWorker.controller;
      if (!sw) { clearTimeout(timer); resolve(null); return; }
      sw.postMessage("bh-version", [channel.port2]);
    });
    return { waiting: !!(reg && reg.waiting), installing: !!(reg && reg.installing), version };
  });
  note(!workerState.waiting, "new service worker does not stay waiting", JSON.stringify(workerState));
  note(workerState.version && workerState.version.version === "bh-4" && workerState.version.gen == null, "plain VERSION bump took over without a generation counter", JSON.stringify(workerState.version));
  const toast = await page.locator("#updateToast").innerText();
  note(/New version, tap to refresh/.test(toast), "update toast copy", toast);
  await shot(page, "screenshot_pwa_update_toast_390");
  stallNav = true;
  await page.evaluate(() => { window.__bhReloadMark = 1; });
  const started = Date.now();
  const loaded = page.waitForFunction(() => !window.__bhReloadMark, null, { timeout: 12000 });
  await page.click("#updateRefresh", { noWaitAfter: true });
  await loaded;
  const elapsed = Date.now() - started;
  console.log("reload-after-offline", elapsed + "ms");
  note(elapsed < 10000, "reload finishes after the offline visit", elapsed + "ms");
  await page.locator("#updateToast").waitFor({ state: "attached", timeout: 10000 });
  note(await page.locator("#updateToast").isHidden(), "toast clears after refresh");
  const refreshed = await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 4000);
    channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data); };
    const sw = navigator.serviceWorker.controller;
    if (!sw) { clearTimeout(timer); resolve(null); return; }
    sw.postMessage("bh-version", [channel.port2]);
  }));
  note(refreshed && refreshed.version === "bh-4", "tap loads the new build", JSON.stringify(refreshed));
  releaseHung();

  // Standalone safe area at 390x844.
  const client = await context.newCDPSession(page);
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "standalone" }] });
  let insetOk = false;
  let insetDetail = "CDP safe-area override unavailable";
  const insetAttempts = [
    ["Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, left: 0, bottom: 34, right: 0 } }],
    ["Emulation.setSafeAreaInsetsOverride", { top: 47, left: 0, bottom: 34, right: 0 }]
  ];
  for (const [method, params] of insetAttempts) {
    try {
      await client.send(method, params);
      insetOk = true;
      insetDetail = method;
      break;
    } catch (e) {
      insetDetail = String(e && e.message || e).split("\n")[0];
    }
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(400);
  const safe = await page.evaluate(() => {
    const shell = getComputedStyle(document.querySelector(".shell"));
    const tabs = getComputedStyle(document.querySelector(".tabs"));
    const word = document.querySelector(".stage .word").getBoundingClientRect();
    const tab = document.querySelector(".tabs .tabbtn").getBoundingClientRect();
    return {
      padTop: shell.paddingTop,
      tabPad: tabs.paddingBottom,
      wordTop: word.top,
      tabBottom: tab.bottom,
      height: window.innerHeight,
      standalone: matchMedia("(display-mode: standalone)").matches
    };
  });
  console.log("safe-area", insetDetail, JSON.stringify(safe));
  if (insetOk) {
    note(parseFloat(safe.padTop) >= 47, "shell clears a 47px notch inset", JSON.stringify(safe));
    note(safe.wordTop >= 47, "title sits below the top inset", JSON.stringify(safe));
    note(parseFloat(safe.tabPad) >= 34 && safe.tabBottom <= safe.height - 34 + 1, "tab bar clears the home indicator", JSON.stringify(safe));
    await shot(page, "screenshot_pwa_safe_area_390");
  } else {
    const css = await page.evaluate(() => {
      const rules = [...document.styleSheets].flatMap(sheet => {
        try { return [...sheet.cssRules].map(rule => rule.cssText); } catch (e) { return []; }
      });
      return rules.filter(rule => /display-mode:\s*standalone/.test(rule)).join("\n");
    });
    note(/safe-area-inset-top/.test(css) && /safe-area-inset-bottom/.test(css), "standalone CSS uses safe-area insets", insetDetail);
  }

  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "" }] }).catch(() => {});
  const scrydexHits = requests.filter(url => /scrydex\.com/i.test(url) && !url.includes("/binderhunt/data/scrydex.json"));
  note(!scrydexHits.length, "no Scrydex network calls", scrydexHits.slice(0, 3).join(" "));

  await context.close();
} catch (error) {
  problems.push(String(error && error.stack || error).split("\n").slice(0, 6).join(" | "));
  console.error(error);
}

if (problems.length) {
  console.log("FAILED\n" + problems.join("\n"));
  await shutdown(1);
}
console.log("pwa checks passed");
await shutdown(0);
