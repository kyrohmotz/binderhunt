// Wishlist target prices and the Deals shelf.
// Prices come from the cached Scrydex file already in the page. No Scrydex
// calls. Existing storage keys keep their shapes. Run:
// node scripts/test_targets.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Targets = require(resolve(root, "js/targets.js"));

const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
assert.match(sw, /const VERSION = "bh-15"/);
assert.match(sw, /"js\/targets\.js"/);
assert.match(sw, /"css\/targets\.css"/);
assert.equal(html.includes("js/targets.js"), false, "targets script stays out of the first paint");
assert.equal(html.includes("css/targets.css"), false, "targets stylesheet stays out of the first paint");
assert.match(app, /bh\.targets\.v1|BinderTargets/);
assert.doesNotMatch(readFileSync(resolve(root, "js/targets.js"), "utf8"), /scrydex\.com/i);
assert.doesNotMatch(readFileSync(resolve(root, "css/targets.css"), "utf8"), /scrydex\.com/i);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

function memory() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

assert.equal(Targets.suggest(100), 90);
assert.equal(Targets.suggest(12.34), 11.11);
assert.equal(Targets.suggest(0.05), 0.04);
assert.equal(Targets.suggest(0.01), null);
assert.equal(Targets.suggest(0), null);
assert.equal(Targets.suggest(NaN), null);
assert.equal(Targets.moneyText(Targets.suggest(100)), "$90.00");
assert.equal(Targets.moneyText(0), "");
assert.equal(Targets.moneyText(NaN), "");
assert.equal(Targets.parsePrice("$1,200.50"), 1200.5);
assert.equal(Targets.parsePrice("0"), null);
assert.equal(Targets.parsePrice("0.00"), null);
assert.equal(Targets.parsePrice("NaN"), null);
assert.equal(Targets.parsePrice("undefined"), null);
assert.equal(Targets.parsePrice("-4"), null);

const store = memory();
store.setItem("binderhuntWish", "[{\"id\":\"base1-4\"}]");
store.setItem("bh.binders.v1", "{\"discoveryId\":\"\",\"binders\":[]}");
store.setItem("bh.owned.v1", "{\"v\":1,\"ids\":[]}");
store.setItem("bh.value.v1", "{\"v\":1}");
store.setItem("bh.filters.v3", "{\"set\":\"\"}");
store.setItem("bh.onboard.v1", "{\"done\":true}");
assert.equal(Targets.setTarget(store, "base1-4", 0, 100, 1700000000000), null);
assert.equal(Targets.setTarget(store, "base1-4", NaN, 100, 1700000000000), null);
const saved = Targets.setTarget(store, "base1-4", 90, 100, 1700000000000);
assert.equal(saved.price, 90);
assert.equal(saved.priceAtSet, 100);
assert.equal(saved.setAt, 1700000000000);
const raw = JSON.parse(store.getItem("bh.targets.v1"));
assert.deepEqual(Object.keys(raw["base1-4"]).sort(), ["price", "priceAtSet", "seen", "seenAt", "setAt"]);
assert.equal(store.getItem("binderhuntWish"), "[{\"id\":\"base1-4\"}]");
assert.equal(store.getItem("bh.binders.v1"), "{\"discoveryId\":\"\",\"binders\":[]}");
assert.equal(store.getItem("bh.owned.v1"), "{\"v\":1,\"ids\":[]}");
assert.equal(store.getItem("bh.value.v1"), "{\"v\":1}");
assert.equal(store.getItem("bh.filters.v3"), "{\"set\":\"\"}");
assert.equal(store.getItem("bh.onboard.v1"), "{\"done\":true}");
assert.equal(Targets.clearTarget(store, "base1-4"), true);
assert.equal(store.getItem("bh.targets.v1"), null);

const junk = memory();
junk.setItem("bh.targets.v1", JSON.stringify({
  "base1-4": { price: "nope", setAt: 10, priceAtSet: 10 },
  "base1-2": { price: 0, setAt: 10, priceAtSet: 12 },
  "not an id": { price: 10, setAt: 10, priceAtSet: 12 },
  "base1-15": { price: 12.5, setAt: 20, priceAtSet: 40, seen: 30, seenAt: 15, extra: "ignored" }
}));
const kept = Targets.read(junk);
assert.deepEqual(Object.keys(kept), ["base1-15"]);
assert.equal(kept["base1-15"].price, 12.5);
assert.equal(kept["base1-15"].extra, undefined);

const quote = Targets.quoteRecord({
  history: [
    { d: "2026/09/01", v: "holofoil", m: 100 },
    { d: "2026/10/01", v: "holofoil", m: 0 },
    { d: "2026/10/01", v: "holofoil", m: NaN },
    { d: "2026/10/01", v: "normal", m: 40 }
  ]
});
assert.equal(quote.latest, 40);
assert.equal(Targets.quoteRecord({ missing: true, history: [{ d: "2026/10/01", v: "normal", m: 40 }] }), null);
assert.equal(Targets.quoteRecord({ history: [] }), null);

const charizard = {
  id: "base1-4",
  name: "Charizard",
  market: 80,
  visit: 95,
  target: { price: 100, setAt: 1700000000000, priceAtSet: 120 }
};
const blastoise = {
  id: "base1-2",
  name: "Blastoise",
  market: 80,
  visit: 80,
  target: { price: 50, setAt: 1700000000000, priceAtSet: 100 }
};
const quiet = {
  id: "base1-25",
  name: "Pikachu",
  market: 91,
  visit: 100,
  target: { price: 50, setAt: 1700000000000, priceAtSet: 100 }
};
const exact = {
  id: "base1-15",
  name: "Venusaur",
  market: 90,
  target: { price: 50, setAt: 1700000000000, priceAtSet: 100 }
};
const atTarget = {
  id: "sv1-1",
  name: "Sprigatito",
  market: 80,
  target: { price: 80, setAt: 1700000000000, priceAtSet: 80 }
};
const unpriced = { id: "base1-44", name: "Bulbasaur", market: null, target: { price: 5, setAt: 1, priceAtSet: 9 } };
const deals = Targets.listDeals([quiet, blastoise, unpriced, charizard, exact, atTarget, { id: "nope", market: NaN, target: charizard.target }]);
assert.deepEqual(deals.map(deal => deal.id), ["base1-4", "sv1-1", "base1-2", "base1-15"]);
const lines = Targets.dealLines(deals[0]);
assert.deepEqual(lines, [
  "Under your target by $20.00",
  "Down $40.00 (33.3%) since you saved it",
  "Down $15.00 (15.8%) since your last visit"
]);
assert.equal(lines.some(line => /NaN|undefined|\$0(?:\.00)?\b/.test(line)), false);
assert.equal(Targets.dealLines(deals.find(deal => deal.id === "sv1-1")).includes("At your target"), true);
assert.equal(Targets.dealLines(deals.find(deal => deal.id === "base1-2"))[0], "Down $20.00 (20%) since you saved it");

const visitStore = memory();
visitStore.setItem("bh.targets.v1", JSON.stringify({
  "base1-4": { price: 100, setAt: 1000, priceAtSet: 120, seen: 95, seenAt: 2000 }
}));
const prior = Targets.rememberVisit(visitStore, [{ id: "base1-4", market: 80 }], 9000);
assert.equal(prior["base1-4"], 95);
const afterVisit = Targets.read(visitStore)["base1-4"];
assert.equal(afterVisit.price, 100);
assert.equal(afterVisit.priceAtSet, 120);
assert.equal(afterVisit.setAt, 1000);
assert.equal(afterVisit.seen, 80);
console.log("targets math ok");

const PORT = 8818;
const vendor = "/tmp/binderhunt-playwright";
if (!existsSync(vendor + "/node_modules/playwright-core/package.json")) {
  mkdirSync(vendor, { recursive: true });
  const install = spawnSync("npm", ["install", "--prefix", vendor, "playwright-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
if (!existsSync(vendor + "/node_modules/axe-core/axe.min.js")) {
  const install = spawnSync("npm", ["install", "--prefix", vendor, "axe-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
const pwRequire = createRequire(vendor + "/node_modules/playwright-core/package.json");
const { chromium } = pwRequire("playwright-core");
const axeSource = readFileSync(resolve(vendor, "node_modules/axe-core/axe.min.js"), "utf8");

mkdirSync("/opt/cursor/artifacts", { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const problems = [];
const consoleErrors = [];
let browser;
function note(ok, name, extra) {
  if (ok) console.log("ok", name);
  else {
    problems.push(name + (extra ? " — " + extra : ""));
    console.log("FAIL", name, extra || "");
  }
}
function shutdown(code) {
  return (browser ? browser.close().catch(() => {}) : Promise.resolve()).finally(() => {
    try { server.kill(); } catch (e) {}
    process.exit(code);
  });
}
process.on("exit", () => { try { server.kill(); } catch (e) {} });

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/js/targets.js", { signal: AbortSignal.timeout(500) });
      if (res.ok) { await res.arrayBuffer(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

function point(iso, variant, market) {
  return { d: iso.replace(/-/g, "/"), v: variant, m: market };
}
const cache = {
  cards: {
    "base1-4": {
      name: "Charizard",
      history: [
        point("2026-08-01", "holofoil", 120),
        point("2026-10-01", "normal", 10),
        point("2026-10-01", "holofoil", 0),
        point("2026-10-01", "holofoil", null),
        point("2026-10-01", "holofoil", 80)
      ]
    },
    "base1-2": {
      name: "Blastoise",
      history: [point("2026-08-01", "holofoil", 100), point("2026-10-01", "holofoil", 80), point("2026-10-01", "normal", 4)]
    },
    "base1-25": {
      name: "Pikachu",
      history: [point("2026-10-01", "holofoil", 40)]
    },
    "base1-44": {
      name: "Bulbasaur",
      history: [point("2026-10-01", "holofoil", 0), point("2026-10-01", "holofoil", null)]
    }
  }
};

function card(id, name, number, market) {
  return {
    id, name, set: "Base", setId: "base1", number,
    img: "https://assets.tcgdex.net/en/base/base1/" + number + "/high.webp",
    thumb: "https://assets.tcgdex.net/en/base/base1/" + number + "/low.webp",
    variants: market ? [{ key: "holofoil", label: "Holofoil", market }] : [{ key: "holofoil", label: "Holofoil", market: 5 }]
  };
}

const boot = `(() => {
  try {
    const stub = {
      register() { return Promise.resolve({ addEventListener() {}, installing: null, waiting: null, active: null }); },
      addEventListener() {},
      getRegistrations() { return Promise.resolve([]); },
      controller: null
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, get() { return stub; } });
  } catch (e) {}
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("bh.value.v1", JSON.stringify({v:1,at:1700000000000,ownedTotal:10,wishTotal:10,ownedKey:"",wishKey:"base1-4"}));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
  localStorage.setItem("binderhuntWish", JSON.stringify([
    ${JSON.stringify(card("base1-4", "Charizard", "4", 80))},
    ${JSON.stringify(card("base1-2", "Blastoise", "2", 80))},
    ${JSON.stringify(card("base1-25", "Pikachu", "25", 40))},
    ${JSON.stringify(card("base1-44", "Bulbasaur", "44", 0))}
  ]));
  localStorage.setItem("bh.targets.v1", JSON.stringify({
    "base1-4": { price: 100, setAt: Date.now() - 3 * 86400000, priceAtSet: 120, seen: 95, seenAt: Date.now() - 86400000 },
    "base1-2": { price: 50, setAt: Date.now() - 2 * 86400000, priceAtSet: 100, seen: 80, seenAt: Date.now() - 86400000 }
  }));
})();`;

function watch(page) {
  page.on("pageerror", err => consoleErrors.push("pageerror: " + String(err && err.message || err).split("\n")[0]));
  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text) consoleErrors.push(text.split("\n")[0]);
  });
  page.on("request", req => {
    const url = req.url();
    if (/api\.scrydex\.com|scrydex\.com\/v/i.test(url)) consoleErrors.push("unexpected Scrydex request " + url);
  });
}

async function shot(page, name) {
  const file = "/opt/cursor/artifacts/" + name + ".png";
  await page.screenshot({ path: file });
  console.log("screenshot", file);
}

async function settle(page) {
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const imgs = [...document.images].filter(img => !img.closest("[hidden]"));
    await Promise.all(imgs.map(img => img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function axe(page, label) {
  await page.evaluate(source => {
    if (window.axe) return;
    const script = document.createElement("script");
    script.textContent = source;
    document.head.appendChild(script);
  }, axeSource);
  return page.evaluate(async name => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations.map(item => name + " " + item.id + " " + item.nodes.slice(0, 3).map(node => (node.target || []).join(" ")).join(" | "));
  }, label);
}

function badMoney(text) {
  return /NaN|undefined|\$0(?:\.00)?\b/.test(text || "");
}

async function dismiss(page) {
  await page.evaluate(() => {
    ["dropPrompt", "installHint", "onboard", "menu"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    const shell = document.getElementById("shell");
    if (shell) shell.removeAttribute("inert");
  });
}

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.setDefaultTimeout(30000);
watch(page);
await page.addInitScript(boot);
await page.route("**/data/scrydex.json", route => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(cache)
}));
await page.route(/scrydex\.com/i, route => route.abort());
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const img = document.querySelector("#deck .card img");
  return !!(img && (img.currentSrc || img.src));
});
const early = await page.evaluate(() => ({
  script: !!document.querySelector('script[src="js/targets.js"]'),
  css: !!document.querySelector('link[href="css/targets.css"]'),
  deck: !!document.querySelector("#deck .card img")
}));
note(early.deck && !early.script && !early.css, "targets files stay unloaded on the first deck paint", JSON.stringify(early));

await page.waitForFunction(() => {
  const btn = document.querySelector('.tabs [data-tab="binders"]');
  return btn && /2 deals/.test(btn.innerText || btn.textContent || "") && typeof BinderTargets !== "undefined";
});
await dismiss(page);
const keysBefore = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  value: localStorage.getItem("bh.value.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  onboard: localStorage.getItem("bh.onboard.v1")
}));

await page.evaluate(() => openProfile(wish.find(card => card.id === "base1-4")));
await page.waitForSelector("#targetPrice");
const profile390 = await page.evaluate(() => {
  const input = document.getElementById("targetPrice");
  const text = document.getElementById("profile").innerText;
  const label = document.querySelector('label[for="targetPrice"]');
  return {
    value: input && input.value,
    labelled: !!(label && label.htmlFor === "targetPrice"),
    text,
    off: (() => {
      const box = document.getElementById("targetBox");
      if (!box) return ["missing target"];
      const scroller = box.closest(".profile-scroll");
      if (scroller) scroller.scrollTop = Math.max(0, box.offsetTop - 88);
      return [];
    })()
  };
});
note(profile390.value === "100.00", "saved target fills the alert field", profile390.value);
note(profile390.labelled, "alert input has a label");
note(profile390.text.includes("Alert set at $100.00"), "profile says the alert is set", profile390.text.slice(0, 400));
note(profile390.text.includes("Cached raw market $80.00"), "profile uses the cached market", profile390.text.slice(0, 500));
note(!badMoney(profile390.text), "profile has no NaN, $0, or undefined", profile390.text.slice(0, 300));
await settle(page);
await shot(page, "profile_target_390");
const profileAxe = await axe(page, "profile-390");
note(!profileAxe.length, "0 axe violations on the profile at 390", profileAxe.join(" || "));

await page.evaluate(() => closeProfile());
await page.locator(".tabs [data-tab=binders]").click();
await page.locator("#openDeals").click();
await page.waitForSelector(".deal-row");
await settle(page);
const deals390 = await page.evaluate(() => {
  const root = document.getElementById("dealsBody");
  const text = root ? root.innerText : "";
  const names = [...document.querySelectorAll(".deal-row b")].map(el => el.textContent);
  const broken = [...document.querySelectorAll(".deal-art img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.src);
  const off = [...document.querySelectorAll(".deal-row, .deals-title, #backDeals")].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && (r.left < -1 || r.right > window.innerWidth + 1);
  }).map(el => el.textContent.slice(0, 40));
  return { text, names, broken, off };
});
note(deals390.names[0] === "Charizard" && deals390.names[1] === "Blastoise", "deals are sorted best first", deals390.names.join(", "));
note(deals390.text.includes("Now $80.00") && deals390.text.includes("Target $100.00"), "deal shows current price and target", deals390.text.slice(0, 400));
note(deals390.text.includes("since you saved it") && deals390.text.includes("since your last visit"), "deal shows both drops", deals390.text.slice(0, 500));
note(!badMoney(deals390.text), "deals shelf has no NaN, $0, or undefined", deals390.text.slice(0, 300));
note(!deals390.broken.length, "deal art loaded", deals390.broken.join(" "));
note(!deals390.off.length, "deal rows are not clipped sideways", deals390.off.join(" | "));
await shot(page, "deals_with_390");
const dealsAxe = await axe(page, "deals-390");
note(!dealsAxe.length, "0 axe violations on Deals at 390", dealsAxe.join(" || "));

await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => openProfile(wish.find(card => card.id === "base1-4")));
await page.waitForSelector("#targetPrice");
await page.evaluate(() => {
  const box = document.getElementById("targetBox");
  const scroller = box && box.closest(".profile-scroll");
  if (box && scroller) scroller.scrollTop = Math.max(0, box.offsetTop - 88);
});
await settle(page);
await shot(page, "profile_target_1440");
const wideProfileAxe = await axe(page, "profile-1440");
note(!wideProfileAxe.length, "0 axe violations on the profile at 1440", wideProfileAxe.join(" || "));
await page.evaluate(() => { if (typeof closeProfile === "function") closeProfile(); });
await page.waitForSelector(".deal-row");
await settle(page);
await shot(page, "deals_with_1440");
const wideDealsAxe = await axe(page, "deals-1440");
note(!wideDealsAxe.length, "0 axe violations on Deals at 1440", wideDealsAxe.join(" || "));

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => {
  BinderTargets.clearTarget(localStorage, "base1-4");
  BinderTargets.clearTarget(localStorage, "base1-2");
  refreshDeals();
});
await page.waitForSelector(".deals-empty");
const emptyText = await page.locator("#dealsBody").innerText();
note(/Alert me at a price/.test(emptyText), "empty deals explains how to set a target", emptyText.slice(0, 300));
note(!badMoney(emptyText), "empty deals has no bad prices", emptyText.slice(0, 200));
await settle(page);
await shot(page, "deals_empty_390");
const emptyAxe = await axe(page, "empty-390");
note(!emptyAxe.length, "0 axe violations on the empty Deals shelf", emptyAxe.join(" || "));
await page.setViewportSize({ width: 1440, height: 900 });
await settle(page);
await shot(page, "deals_empty_1440");
const wideEmptyAxe = await axe(page, "empty-1440");
note(!wideEmptyAxe.length, "0 axe violations on the empty shelf at 1440", wideEmptyAxe.join(" || "));

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => openProfile(wish.find(card => card.id === "base1-25")));
await page.waitForSelector("#targetPrice");
const suggestion = await page.locator("#targetPrice").inputValue();
note(suggestion === "36.00", "suggestion is about 10% under the cached market", suggestion);
await page.locator("#targetPrice").fill("30");
await page.locator("#targetPrice").press("Enter");
await page.waitForFunction(() => {
  const raw = JSON.parse(localStorage.getItem("bh.targets.v1") || "{}");
  return raw["base1-25"] && raw["base1-25"].price === 30 && raw["base1-25"].priceAtSet === 40;
});
const savedShape = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("bh.targets.v1"));
  return { keys: Object.keys(raw["base1-25"]).sort(), price: raw["base1-25"].price, at: raw["base1-25"].priceAtSet };
});
note(savedShape.price === 30 && savedShape.at === 40, "saving stores price and the market at that moment", JSON.stringify(savedShape));
note(savedShape.keys.includes("price") && savedShape.keys.includes("setAt") && savedShape.keys.includes("priceAtSet"), "stored record keeps the target fields", savedShape.keys.join(","));
await page.locator("#clearTarget").click();
await page.waitForFunction(() => !JSON.parse(localStorage.getItem("bh.targets.v1") || "{}")["base1-25"]);
note(true, "clear removes the alert");

await page.evaluate(() => openProfile(wish.find(card => card.id === "base1-44")));
await page.waitForFunction(() => {
  const text = document.getElementById("profile") ? document.getElementById("profile").innerText : "";
  return text.includes("can't be set");
});
const unpricedText = await page.locator("#profile").innerText();
note(!await page.locator("#targetPrice").count(), "a card without a cached price has no target field");
note(unpricedText.includes("No cached market price"), "the profile explains why", unpricedText.slice(0, 240));
note(!badMoney(unpricedText), "unpriced profile has no bad prices");

const keysAfter = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  value: localStorage.getItem("bh.value.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  onboard: localStorage.getItem("bh.onboard.v1")
}));
note(keysAfter.wish === keysBefore.wish, "binderhuntWish is unchanged");
note(keysAfter.binders === keysBefore.binders, "bh.binders.v1 is unchanged");
note(keysAfter.owned === keysBefore.owned, "bh.owned.v1 is unchanged");
note(keysAfter.value === keysBefore.value, "bh.value.v1 is unchanged");
note(keysAfter.filters === keysBefore.filters, "bh.filters.v3 is unchanged");
note(keysAfter.onboard === keysBefore.onboard, "bh.onboard.v1 is unchanged");

await page.evaluate(() => { closeProfile(); showTab("hunt"); });
await page.waitForSelector("#deck .card");
const beforeSwipe = await page.evaluate(() => topCard() && topCard().card && topCard().card.id);
async function swipe(pointerType, previous) {
  const box = await page.locator("#deck .card").last().boundingBox();
  note(!!box, pointerType + " swipe found a card");
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const dx = -170;
  if (pointerType === "mouse") {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 12 });
    await page.mouse.up();
  } else {
    await page.evaluate(({ x, y, dx }) => {
      const el = topCard();
      if (!el) return;
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x + dx, clientY: y, button: 0, buttons: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x + dx, clientY: y, button: 0, buttons: 0 }));
    }, { x, y, dx });
  }
  await page.waitForFunction(id => {
    const top = typeof topCard === "function" ? topCard() : null;
    const cards = document.querySelectorAll("#deck .card").length;
    return cards > 0 && top && top.card && top.card.id !== id && !document.querySelector("#deck .empty-state");
  }, previous);
}
await swipe("mouse", beforeSwipe);
const afterMouse = await page.evaluate(() => topCard() && topCard().card && topCard().card.id);
note(afterMouse && afterMouse !== beforeSwipe, "mouse swipe still moves the deck", beforeSwipe + " -> " + afterMouse);
await swipe("touch", afterMouse);
const afterTouch = await page.evaluate(() => ({
  id: topCard() && topCard().card && topCard().card.id,
  cards: document.querySelectorAll("#deck .card").length,
  dry: !!document.querySelector("#deck .empty-state")
}));
note(afterTouch.cards > 0 && !afterTouch.dry && afterTouch.id !== afterMouse, "touch swipe still moves the deck and it does not run dry", JSON.stringify(afterTouch));
note(!consoleErrors.length, "no console errors", consoleErrors.join(" | "));

if (problems.length) {
  console.log(problems.join("\n"));
  await shutdown(1);
}
console.log("targets ui ok");
await shutdown(0);
