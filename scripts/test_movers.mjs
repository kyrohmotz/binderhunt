// Market movers from cached Scrydex history only.
// A 7-day or 30-day change has to land inside the same lag window the
// value tab uses, end on the card's latest cached price, and clear $1.
// Run: npx -y node@22 scripts/test_movers.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Movers = require(resolve(root, "js/movers.js"));
const Value = require(resolve(root, "js/value.js"));

const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
assert.match(sw, /const VERSION = "bh-17"/);
assert.match(sw, /"js\/movers\.js"/);
assert.match(sw, /"js\/movers-ui\.js"/);
assert.match(sw, /"css\/movers\.css"/);
assert.equal(html.includes("js/movers.js"), false, "movers script stays out of the first paint");
assert.match(app, /id="openMovers"/);
assert.match(app, /bh\.movers\.v1|BinderMovers/);
assert.doesNotMatch(readFileSync(resolve(root, "js/movers.js"), "utf8"), /scrydex\.com/i);
assert.doesNotMatch(readFileSync(resolve(root, "js/movers-ui.js"), "utf8"), /scrydex\.com/i);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

function history(variant, start, end, days, latest) {
  const last = latest || Date.UTC(2026, 9, 1);
  const rows = [];
  for (let ago = days; ago >= 0; ago--) {
    const t = new Date(last - ago * 86400000);
    const iso = t.getUTCFullYear() + "/" + String(t.getUTCMonth() + 1).padStart(2, "0") + "/" + String(t.getUTCDate()).padStart(2, "0");
    const price = start + (end - start) * (days - ago) / days;
    rows.push({ d: iso, v: variant, m: Math.round(price * 100) / 100 });
  }
  return rows;
}

const cards = {
  "base1-4": { name: "Charizard", history: history("holofoil", 100, 180, 40) },
  "base1-2": { name: "Blastoise", history: history("holofoil", 90, 40, 40) },
  "base1-15": { name: "Tiny", history: history("normal", 0.4, 0.9, 40) },
  "base1-25": { name: "Quiet", history: history("normal", 10, 10.4, 40) },
  "base1-58": { name: "Flat", history: history("normal", 12, 12, 40) },
  "sv1-1": { name: "Short", history: history("holofoil", 20, 40, 5) },
  "gap-1": { name: "Gap", history: history("holofoil", 20, 50, 3).concat(history("holofoil", 50, 80, 0, Date.UTC(2026, 9, 1))) },
  "base1-999": { name: "Missing", history: [{ d: "2026/10/01", v: "holofoil", m: 0 }, { d: "nope", v: "holofoil", m: NaN }, { d: "2026/10/01", v: "holofoil", m: null }] },
  "zero-1": { name: "Zero", history: history("normal", 0, 0, 40) }
};
const wideGap = history("holofoil", 30, 30, 20, Date.UTC(2026, 8, 1)).concat([
  { d: "2026/10/01", v: "holofoil", m: 80 },
  { d: "2026/10/02", v: "holofoil", m: 80 }
]);
const lagCards = { "lag-1": { name: "Late", history: wideGap } };

const week = Movers.list(cards, { days: 7, wishIds: ["base1-4"], ownedIds: ["base1-2", "base1-2"] });
assert.equal(week.days, 7);
assert.equal(week.measuredFrom, "latest-cached-price");
assert.equal(week.minLag, 7);
assert.equal(week.maxLag, 14);
assert.equal(week.risers[0].id, "base1-4");
assert.equal(week.risers[0].wish, true);
assert.equal(week.risers[0].owned, false);
assert.equal(week.risers[0].dir, "up");
assert.ok(week.risers[0].latest >= 1);
assert.ok(Math.abs(week.risers[0].delta) >= 1);
assert.ok(week.risers[0].spanDays >= 7 && week.risers[0].spanDays <= 14);
assert.equal(week.fallers[0].id, "base1-2");
assert.equal(week.fallers[0].owned, true);
assert.equal(week.fallers[0].dir, "down");
assert.equal(week.risers.some(row => row.id === "base1-15"), false);
assert.equal(week.fallers.some(row => row.id === "base1-15"), false);
assert.equal(week.risers.concat(week.fallers).some(row => row.id === "base1-25" || row.id === "base1-58" || row.id === "sv1-1" || row.id === "base1-999" || row.id === "zero-1"), false);
assert.equal(Movers.list(lagCards, { days: 7 }).risers.length, 0);
assert.equal(Movers.list(lagCards, { days: 30 }).risers[0].id, "lag-1");

function plateau(variant, hold, holdDays, next, nextDays) {
  const last = Date.UTC(2026, 9, 1);
  const rows = [];
  for (let ago = holdDays + nextDays; ago >= 0; ago--) {
    const t = new Date(last - ago * 86400000);
    const iso = t.getUTCFullYear() + "/" + String(t.getUTCMonth() + 1).padStart(2, "0") + "/" + String(t.getUTCDate()).padStart(2, "0");
    rows.push({ d: iso, v: variant, m: ago < nextDays ? next : hold });
  }
  return rows;
}
function reasonFor(id, rec, days) {
  const series = Movers.seriesFor(rec);
  const minLag = days === 30 ? 30 : 7;
  const maxLag = days === 30 ? 45 : 14;
  const move = Movers.windowMove(series.points, days, minLag, maxLag);
  return { move, reason: Movers.outlierReason(series.points, move) };
}
const magneton = { name: "Magneton", history: plateau("unlimitedShadowlessHolofoil", 135, 14, 1.29, 1) };
const deoxys = { name: "Deoxys", history: plateau("holofoil", 500, 14, 850, 2) };
const onePrint = { name: "Togetic", history: plateau("holofoil", 129.99, 14, 209.89, 1) };
const heldJump = { name: "Togetic", history: plateau("holofoil", 129.99, 14, 209.89, 2) };
const heldDrop = { name: "Blastoise", history: plateau("holofoil", 400, 14, 100, 7) };
const spikeBaseRows = [];
for (let ago = 20; ago >= 0; ago--) {
  const t = new Date(Date.UTC(2026, 9, 1) - ago * 86400000);
  const iso = t.getUTCFullYear() + "/" + String(t.getUTCMonth() + 1).padStart(2, "0") + "/" + String(t.getUTCDate()).padStart(2, "0");
  spikeBaseRows.push({ d: iso, v: "holofoil", m: ago === 7 ? 400 : 100 });
}
const spikeBase = { name: "Spike", history: spikeBaseRows };
const magnetonGuard = reasonFor("base1-9", magneton, 7);
assert.equal(magnetonGuard.reason, "latest-spike");
assert.equal(Movers.list({ "base1-9": magneton }, { days: 7 }).fallers.length, 0);
const deoxysGuard = reasonFor("col1-SL1", deoxys, 7);
assert.equal(deoxysGuard.reason, "");
assert.equal(deoxysGuard.move.baseline, 500);
assert.equal(deoxysGuard.move.latest, 850);
assert.equal(Movers.list({ "col1-SL1": deoxys }, { days: 7 }).risers[0].id, "col1-SL1");
const loneGuard = reasonFor("ex7-14", onePrint, 7);
assert.equal(loneGuard.reason, "unconfirmed-latest");
assert.equal(Movers.list({ "ex7-14": onePrint }, { days: 7 }).risers.length, 0);
const heldGuard = reasonFor("ex7-14", heldJump, 7);
assert.equal(heldGuard.reason, "");
assert.equal(Movers.list({ "ex7-14": heldJump }, { days: 7 }).risers[0].pct > 60, true);
const dropGuard = reasonFor("ecard1-4", heldDrop, 7);
assert.equal(dropGuard.reason, "");
assert.equal(Movers.list({ "ecard1-4": heldDrop }, { days: 7 }).fallers[0].dir, "down");
const baseGuard = reasonFor("spike-1", spikeBase, 7);
assert.equal(baseGuard.reason, "baseline-spike");
assert.equal(Movers.list({ "spike-1": spikeBase }, { days: 7 }).fallers.length, 0);
assert.equal(Movers.moneyText(0), "");
assert.equal(Movers.moneyText(NaN), "");
assert.equal(Movers.moneyText(0.004), "");
assert.match(Movers.moneyText(week.risers[0].latest), /^\$\d/);
assert.doesNotMatch(Movers.moneyText(week.risers[0].delta) + Movers.pctText(week.risers[0].pct), /NaN|\$0(?:\.00)?$/);
const spark = Movers.sparkSvg(week.risers[0].points, "up", "Cached price from $100.00 to $180.00");
assert.match(spark, /aria-label=/);
assert.doesNotMatch(spark, /NaN/);
assert.equal(Movers.sparkSvg([{ t: 1, value: 0 }], "up", "nope"), "");

const month = Movers.list(cards, { days: 30, limit: 5 });
assert.equal(month.days, 30);
assert.equal(month.minLag, 30);
assert.equal(month.maxLag, 45);
assert.equal(month.risers[0].id, "base1-4");
assert.equal(month.fallers[0].id, "base1-2");
assert.ok(month.risers[0].spanDays >= 30 && month.risers[0].spanDays <= 45);
assert.equal(Movers.list(null).risers.length, 0);
assert.equal(Movers.readDays({ getItem: () => null }), 7);

const mem = new Map([
  ["binderhuntWish", "[]"],
  ["bh.owned.v1", "{\"v\":1,\"ids\":[]}"],
  ["bh.binders.v1", "{}"],
  ["bh.targets.v1", "{}"],
  ["bh.value.v1", "{}"],
  ["bh.dex.v1", "{}"]
]);
const storage = {
  getItem(key) { return mem.has(key) ? mem.get(key) : null; },
  setItem(key, value) { mem.set(key, String(value)); }
};
assert.equal(Movers.writeDays(storage, 30), true);
assert.equal(Movers.readDays(storage), 30);
assert.equal(mem.get("binderhuntWish"), "[]");
assert.equal(mem.get("bh.owned.v1"), "{\"v\":1,\"ids\":[]}");
assert.equal(mem.get("bh.binders.v1"), "{}");
assert.equal(mem.get("bh.targets.v1"), "{}");
assert.equal(mem.get("bh.value.v1"), "{}");
assert.equal(mem.get("bh.dex.v1"), "{}");
assert.equal(JSON.parse(mem.get(Movers.KEY)).days, 30);
assert.equal(Movers.writeDays(storage, 7), true);
assert.deepEqual(Movers.deckCards({ risers: [], fallers: [] }), []);
const deck = Movers.deckCards(week);
assert.equal(deck[0].id, "base1-4");
assert.equal(deck[0].mover, true);
assert.ok(deck[0].latest === undefined);
assert.ok(deck[0].price >= 1);
assert.ok(deck[0].thumb.includes("base1/4"));
assert.equal(deck[0].variants[0].market, deck[0].price);
assert.equal(deck.some(card => !(card.price >= 1)), false);

const cache = JSON.parse(readFileSync(resolve(root, "data/scrydex.json"), "utf8"));
const sampleId = "ex10-113";
const sample = cache.cards[sampleId];
assert.ok(sample && sample.history && sample.history.length > 10, "sample card has dated history");
const fromValue = Value.seriesFor(sample);
const fromMovers = Movers.seriesFor(sample);
assert.equal(fromMovers.variant, fromValue.variant);
assert.ok(Math.abs(fromMovers.latest.value - fromValue.latest.value) < 0.02);
const valueMove = Value.windowMove(fromValue.points, 7, 7, 14);
const moverMove = Movers.windowMove(fromMovers.points, 7, 7, 14);
assert.ok(valueMove && moverMove, "cached history supports a 7-day window");
assert.equal(moverMove.dir, valueMove.dir);
assert.ok(moverMove.spanDays >= 7 && moverMove.spanDays <= 14);

const real7 = Movers.list(cache.cards, { days: 7, limit: 12 });
const real30 = Movers.list(cache.cards, { days: 30, limit: 12 });
function assertRows(model) {
  const rows = model.risers.concat(model.fallers);
  assert.ok(model.risers.length > 0, model.label + " has risers");
  assert.ok(model.fallers.length > 0, model.label + " has fallers");
  rows.forEach(row => {
    assert.ok(row.latest >= 1, row.id);
    assert.ok(row.baseline >= 1, row.id);
    assert.ok(Math.abs(row.delta) >= 1, row.id);
    assert.ok(row.pct >= 1, row.id);
    assert.ok(row.spanDays >= model.minLag && row.spanDays <= model.maxLag, row.id + " " + row.spanDays);
    assert.ok(row.dir === "up" || row.dir === "down");
    assert.equal(Number.isFinite(row.latest) && Number.isFinite(row.delta) && Number.isFinite(row.pct), true);
    const money = Movers.moneyText(row.latest) + Movers.moneyText(row.delta) + Movers.pctText(row.pct);
    assert.doesNotMatch(money, /NaN|Infinity|undefined|\$0(?:\.00)?$/);
    assert.ok(row.points.length >= 2, row.id);
    assert.ok(row.points.every(point => point.value >= 0.01 && Number.isFinite(point.value)));
  });
  for (let i = 1; i < model.risers.length; i++) {
    assert.ok(model.risers[i - 1].pct >= model.risers[i].pct);
  }
}
assertRows(real7);
assertRows(real30);
assert.equal(real7.fallers.some(row => row.id === "base1-9"), false, "Magneton's one-day $1.29 print stays off the 7-day list");
assert.equal(real7.risers[0].id, "col1-SL1");
assert.equal(real7.risers[0].baseline, 500);
assert.equal(real7.risers[0].latest, 850);
assert.equal(real7.risers.some(row => row.id === "ex7-14"), false, "a single unconfirmed print over 60% stays off the list");
assert.equal(real30.fallers.some(row => row.id === "bw5-111"), false, "Pokémon Catcher's one-day $12 print stays off the 30-day list");
assert.equal(real7.measuredFrom, "latest-cached-price");
assert.equal(real30.measuredFrom, "latest-cached-price");
console.log("movers math ok", {
  week7: real7.risers.length + "/" + real7.fallers.length,
  top: real7.risers[0] && real7.risers[0].name,
  month30: real30.risers.length + "/" + real30.fallers.length
});

const PORT = 8817;
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

mkdirSync("/opt/cursor/artifacts/screenshots", { recursive: true });
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
      const res = await fetch("http://127.0.0.1:" + PORT + "/js/movers.js", { signal: AbortSignal.timeout(500) });
      if (res.ok) { await res.arrayBuffer(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

const boot = `(() => {
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:["base1-2"],sets:{"base1-2":"base1"},celebrated:[],seeded:true}));
  localStorage.setItem("binderhuntWish", JSON.stringify([
    {id:"base1-4",name:"Charizard",set:"Base",setId:"base1",number:"4",img:"https://assets.tcgdex.net/en/base/base1/4/high.webp",thumb:"https://assets.tcgdex.net/en/base/base1/4/low.webp"}
  ]));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted:"2099-01-01", days:{} }));
  window.__imgErrors = [];
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target.tagName === "IMG") window.__imgErrors.push(target.currentSrc || target.src || "img");
  }, true);
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
  const file = "/opt/cursor/artifacts/screenshots/" + name + ".png";
  await page.screenshot({ path: file, fullPage: false });
  console.log("screenshot", file);
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
  if (/NaN|Infinity|undefined/.test(text)) return true;
  const prices = text.match(/\$\d[\d,]*(?:\.\d{2})?/g) || [];
  return prices.some(price => {
    const n = Number(price.replace(/[$,]/g, ""));
    return !Number.isFinite(n) || n < 1;
  });
}

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.setDefaultTimeout(45000);
watch(page);
await page.addInitScript(boot);
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof scrydex !== "undefined" && scrydex.ready && typeof showTab === "function");
const lazy = await page.evaluate(() => ({
  defined: typeof BinderMovers !== "undefined",
  tag: !!document.querySelector('script[src="js/movers.js"]')
}));
note(lazy.defined === false && lazy.tag === false, "movers files stay unloaded until the shelf is opened", JSON.stringify(lazy));

await page.evaluate(() => {
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
  function dated(variant, early, late) {
    const last = Date.UTC(2026, 9, 1);
    const rows = [];
    for (let ago = 40; ago >= 0; ago--) {
      const t = new Date(last - ago * 86400000);
      const iso = t.getUTCFullYear() + "/" + String(t.getUTCMonth() + 1).padStart(2, "0") + "/" + String(t.getUTCDate()).padStart(2, "0");
      rows.push({ d: iso, v: variant, m: ago >= 7 ? early : late });
    }
    return rows;
  }
  scrydex.cards["base1-4"] = Object.assign({}, scrydex.cards["base1-4"], { name: "Charizard", history: dated("holofoil", 100, 500), missing: false });
  scrydex.cards["base1-2"] = Object.assign({}, scrydex.cards["base1-2"], { name: "Blastoise", history: dated("holofoil", 500, 4), missing: false });
});

await page.locator(".tabs [data-tab=binders]").click();
await page.waitForSelector("#openMovers");
const shelf = await page.evaluate(() => {
  const row = document.getElementById("openMovers");
  const r = row.getBoundingClientRect();
  return {
    text: row.innerText,
    off: r.left < -1 || r.right > window.innerWidth + 1,
    clipped: row.scrollWidth > row.clientWidth + 2
  };
});
note(/Market movers/.test(shelf.text) && /7 and 30/.test(shelf.text), "shelf row introduces market movers", shelf.text);
note(!shelf.off && !shelf.clipped, "shelf row is not clipped at 390", JSON.stringify(shelf));

const beforeKeys = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  targets: localStorage.getItem("bh.targets.v1"),
  value: localStorage.getItem("bh.value.v1"),
  dex: localStorage.getItem("bh.dex.v1")
}));

await page.locator("#openMovers").click();
await page.waitForSelector(".mover-row");
await page.waitForFunction(() => {
  const text = document.getElementById("bindersScroll").innerText;
  return text.includes("Charizard") && text.includes("Blastoise") && !text.includes("Reading cached");
});
const populated = await page.evaluate(() => {
  const root = document.getElementById("bindersScroll");
  const text = root.innerText;
  const names = [...root.querySelectorAll(".mover-name")].map(el => el.textContent.trim());
  const tabs = [...document.querySelectorAll(".tabs .tabbtn")].map(el => ({
    text: el.textContent.replace(/\s+/g, " ").trim(),
    clipped: el.scrollWidth > el.clientWidth + 1,
    box: el.getBoundingClientRect().right
  }));
  const off = [...root.querySelectorAll("h2, h3, .mover-row, .movers-swipe, .movers-windows button, #backMovers")].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.top < window.innerHeight && (r.left < -1 || r.right > window.innerWidth + 1);
  }).map(el => (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60));
  const broken = [...root.querySelectorAll("img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.src);
  const context = document.getElementById("context");
  const first = root.querySelector(".mover-row");
  return {
    text,
    names,
    tabs,
    off,
    broken,
    context: context ? context.textContent : "",
    contextClipped: context ? context.scrollWidth > context.clientWidth + 1 : false,
    pressed: document.getElementById("movers7") && document.getElementById("movers7").getAttribute("aria-checked"),
    label: first ? first.textContent.replace(/\s+/g, " ").trim() : "",
    spark: !!root.querySelector(".mover-spark")
  };
});
note(populated.names[0] === "Charizard", "biggest riser is first", populated.names.slice(0, 4).join(", "));
note(populated.text.includes("Wishlist") && populated.text.includes("Owned"), "wishlist and owned badges show", populated.text.slice(0, 400));
note(populated.text.includes("Up $400.00") && populated.text.includes("400%"), "riser shows dollars and percent", populated.text.slice(0, 500));
note(populated.text.includes("Now $500.00"), "riser shows the current price");
note(populated.text.includes("Down $496.00") && populated.text.includes("Now $4.00"), "faller shows dollars and current price", populated.text.slice(0, 700));
note(populated.text.includes("latest cached price"), "window is labeled from the cached price", populated.text.slice(0, 350));
note(!badMoney(populated.text), "no NaN or sub-dollar price", populated.text.slice(0, 400));
note(populated.pressed === "true", "7 days is selected");
note(populated.spark, "a sparkline is drawn");
note(/Charizard/.test(populated.label) && /Open profile/.test(populated.label), "row has an accessible name", populated.label);
note(!populated.tabs.some(tab => tab.clipped), "tab labels are not clipped", JSON.stringify(populated.tabs));
note(populated.tabs.every(tab => tab.box <= 391), "tabs stay inside 390px", JSON.stringify(populated.tabs));
note(populated.context === "Movers" && !populated.contextClipped, "context label fits", populated.context);
note(!populated.off.length, "movers stay inside 390px", populated.off.join(" | "));
note(!populated.broken.length, "no broken images", populated.broken.join(" "));
await page.evaluate(() => { document.getElementById("bindersScroll").scrollTop = 0; });
await page.waitForFunction(() => [...document.querySelectorAll(".mover-art img")].every(img => img.complete));
const axe390 = await axe(page, "movers-390");
note(!axe390.length, "0 axe violations on movers at 390", axe390.join(" || "));
await shot(page, "movers-390");

await page.locator("#movers30").click();
await page.waitForFunction(() => document.getElementById("movers30") && document.getElementById("movers30").getAttribute("aria-checked") === "true" && document.getElementById("bindersScroll").innerText.includes("30 days"));
const monthText = await page.locator("#bindersScroll").innerText();
note(monthText.includes("Charizard") && monthText.includes("30 days"), "30-day toggle keeps the riser", monthText.slice(0, 240));
note(!badMoney(monthText), "30-day list has no bad prices", monthText.slice(0, 240));
const storedDays = await page.evaluate(() => localStorage.getItem("bh.movers.v1"));
note(storedDays && JSON.parse(storedDays).days === 30 && JSON.parse(storedDays).v === 1, "window is stored in bh.movers.v1", storedDays);

const keys = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  targets: localStorage.getItem("bh.targets.v1"),
  value: localStorage.getItem("bh.value.v1"),
  dex: localStorage.getItem("bh.dex.v1")
}));
note(keys.wish === beforeKeys.wish, "binderhuntWish was not rewritten");
note(keys.binders === beforeKeys.binders, "bh.binders.v1 was not rewritten");
note(keys.owned === beforeKeys.owned, "bh.owned.v1 was not rewritten");
note(keys.filters === beforeKeys.filters, "bh.filters.v3 was not rewritten");
note(keys.targets === beforeKeys.targets, "bh.targets.v1 was not rewritten");
note(keys.value === beforeKeys.value, "bh.value.v1 was not rewritten");
note(keys.dex === beforeKeys.dex, "bh.dex.v1 was not rewritten");

await page.locator(".mover-row", { hasText: "Charizard" }).click();
await page.waitForSelector("#profile:not([hidden])");
const profile = await page.evaluate(() => {
  const el = document.getElementById("profile");
  return { text: el.innerText.slice(0, 400), hidden: el.hidden };
});
note(!profile.hidden && /Charizard/.test(profile.text) && !/NaN|\$0(?:\.00)?\b/.test(profile.text), "tapping a mover opens the card profile", profile.text.slice(0, 180));
await page.evaluate(() => { if (typeof closeProfile === "function") closeProfile(); });

await page.setViewportSize({ width: 1440, height: 900 });
await page.locator(".rail [data-tab=binders]").click();
await page.waitForSelector("#moversTitle");
await page.evaluate(() => { document.getElementById("bindersScroll").scrollTop = 0; });
await page.waitForFunction(() => [...document.querySelectorAll(".mover-art img")].every(img => img.complete));
await sleep(200);
const wide = await page.evaluate(() => {
  const text = document.getElementById("bindersScroll").innerText;
  const side = document.querySelector("[data-side='binders']");
  const board = document.querySelector(".movers-board");
  const cols = board ? getComputedStyle(board).gridTemplateColumns : "";
  const off = [...document.querySelectorAll("#bindersScroll h2, #bindersScroll h3, #bindersScroll .mover-row, #swipeMovers, .rail .tabbtn, #context")].filter(el => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 2 && r.height > 2)) return false;
    if (!(r.bottom > 0 && r.top < window.innerHeight)) return false;
    return r.left < -1 || r.right > window.innerWidth + 1;
  }).map(el => (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 48));
  const broken = [...document.querySelectorAll("#bindersScroll img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.src);
  const context = document.getElementById("context");
  return {
    text,
    side: side ? side.innerText.slice(0, 220) : "",
    cols,
    off,
    broken,
    wide: matchMedia("(min-width: 1024px)").matches,
    context: context ? context.textContent : "",
    contextClipped: context ? context.scrollWidth > context.clientWidth + 1 : false
  };
});
note(wide.wide && /Check back/.test(wide.side), "desktop side panel explains movers", wide.side);
note(wide.cols.split(" ").length >= 2, "risers and fallers sit side by side", wide.cols);
note(!badMoney(wide.text), "desktop list has no bad prices");
note(!wide.contextClipped && wide.context === "Movers", "desktop context label fits", wide.context);
note(!wide.off.length, "nothing is clipped at 1440x900", wide.off.join(" | "));
note(!wide.broken.length, "no broken images at 1440", wide.broken.join(" "));
const axe1440 = await axe(page, "movers-1440");
note(!axe1440.length, "0 axe violations on movers at 1440", axe1440.join(" || "));
await shot(page, "movers-1440");

await page.setViewportSize({ width: 390, height: 844 });
await page.locator("#swipeMovers").click();
await page.waitForFunction(() => {
  const count = document.getElementById("matchCount");
  return document.getElementById("viewHunt") && !document.getElementById("viewHunt").hidden && count && /usual hunt/.test(count.textContent) && pile[0] && pile[0].id === "base1-4";
});
const seeded = await page.evaluate(() => ({
  top: pile[0] && pile[0].id,
  left: typeof moverCardsLeft === "function" ? moverCardsLeft() : -1,
  label: document.getElementById("matchCount").textContent,
  context: document.getElementById("context").textContent
}));
note(seeded.top === "base1-4" && seeded.left > 1, "swipe seeds the deck from the mover list", JSON.stringify(seeded));
note(/usual hunt/.test(seeded.label) && seeded.context === "Movers", "the hunt says it will fall back", JSON.stringify(seeded));

const dry = await page.evaluate(async () => {
  moverQueue = [];
  const keeper = pile.find(card => card && card.id === "base1-4") || pile[0];
  pile = keeper ? [keeper] : [];
  renderDeck();
  if (typeof fly === "function") fly(-1);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const card = document.querySelector("#deck .card");
    const id = card && card.card && card.card.id;
    if (id && id !== "base1-4") return { ok: true, id, pile: pile.length };
    if (pile.length && pile[0] && pile[0].id !== "base1-4") return { ok: true, id: pile[0].id, pile: pile.length };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const empty = document.querySelector("#deck .empty-state");
  return { ok: false, pile: pile.length, text: empty ? empty.innerText.slice(0, 160) : "", status: document.getElementById("deck").dataset.status || "" };
});
note(dry.ok, "the deck falls back to the usual hunt instead of running dry", JSON.stringify(dry));
note(!consoleErrors.length, "no console errors", consoleErrors.slice(0, 8).join(" | "));

if (problems.length) {
  console.log("FAILED", problems.length);
  problems.forEach(item => console.log(" -", item));
  await shutdown(1);
}
console.log("movers ok");
await shutdown(0);
