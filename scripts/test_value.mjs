// Collection value is computed from cached Scrydex history only.
// Unpriced cards are counted and never shown as $0 or NaN. The visit
// snapshot is bh.value.v1 and does not rewrite the other storage keys.
// Run: npx -y node@22 scripts/test_value.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Value = require(resolve(root, "js/value.js"));

const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
assert.match(sw, /const VERSION = "bh-19"/);
assert.match(sw, /"js\/value\.js"/);
assert.match(sw, /"js\/value-ui\.js"/);
assert.match(sw, /"css\/value\.css"/);
assert.equal(html.includes("js/value.js"), false, "value script stays out of the first paint");
assert.match(html, /data-tab="value"/);
assert.match(html, /id="viewValue"/);

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
  "base1-4": {
    name: "Charizard",
    history: history("holofoil", 100, 140, 40).concat([
      { d: "2026/10/01", v: "holofoil", m: 0 },
      { d: "2026/10/01", v: "holofoil", m: NaN },
      { d: "2026/10/01", v: "firstEditionHolofoil", m: 900 }
    ])
  },
  "base1-2": { name: "Blastoise", history: history("holofoil", 80, 50, 40) },
  "base1-25": { name: "Pikachu", history: history("normal", 20, 22, 40) },
  "base1-999": { name: "Missingno", history: [{ d: "2026/10/01", v: "holofoil", m: 0 }, { d: "nope", v: "holofoil", m: NaN }] },
  "base1-998": { name: "Wishgap", history: [] },
  "tiny-1": { name: "Speck", history: [{ d: "2026/09/01", v: "normal", m: 0.004 }, { d: "2026/10/01", v: "normal", m: 0.004 }] }
};

const portfolio = Value.build({
  cards,
  ownedIds: ["base1-4", "base1-2", "base1-999", "base1-4", "nope"],
  wishIds: ["base1-4", "base1-25", "base1-998", "base1-25"]
});
assert.equal(portfolio.owned.priced, 2);
assert.equal(portfolio.owned.unpriced, 2);
assert.equal(portfolio.owned.total, 190);
assert.equal(portfolio.wish.priced, 1);
assert.equal(portfolio.wish.unpriced, 1);
assert.equal(portfolio.wish.heldBack, 1);
assert.equal(portfolio.wish.total, 22);
assert.equal(portfolio.owned.key, "base1-2,base1-4");
assert.ok(portfolio.owned.move7 && portfolio.owned.move7.dir === "up");
assert.ok(portfolio.owned.move30 && portfolio.owned.move30.delta > portfolio.owned.move7.delta);
assert.equal(portfolio.owned.move7.priced, 2);
assert.equal(portfolio.owned.move7.n, 2);
assert.ok(portfolio.owned.spark.points.length >= 8);
assert.equal(portfolio.owned.spark.mode, "shared");
assert.ok(portfolio.owned.spark.points.every(point => point.value >= 0.01 && Number.isFinite(point.value)));
assert.equal(portfolio.movers.gainers[0].id, "base1-4");
assert.equal(portfolio.movers.decliners[0].id, "base1-2");
assert.equal(portfolio.movers.gainers.some(row => row.id === "base1-999"), false);
assert.match(Value.unpricedLine(portfolio.owned.rows.concat(portfolio.wish.rows)), /^3 cards have no price yet/);
assert.match(Value.unpricedLine([{ priced: false, name: "Solo" }]), /^1 card has no price yet/);
assert.equal(Value.moneyText(0), "");
assert.equal(Value.moneyText(NaN), "");
assert.equal(Value.moneyText(0.004), "");
assert.match(Value.moneyText(portfolio.owned.total), /^\$190\.00$/);
assert.doesNotMatch(Value.moveLine(portfolio.owned.move7, 7), /NaN|\$0(?:\.00)?$/);
assert.match(Value.moveLine(null, 7), /Not enough history/);
assert.match(Value.finishLine(portfolio.wish), /What it would cost to finish/);
assert.match(Value.finishLine(portfolio.wish), /already in your hands/);
assert.match(Value.sparkSvg(portfolio.owned.spark), /aria-label=/);
assert.doesNotMatch(Value.sparkSvg(portfolio.owned.spark), /NaN/);
assert.equal(Value.sparkSvg({ points: [{ t: 1, value: 1 }] }), "");
assert.equal(Value.cardStub(portfolio.owned.rows[0]).variants[0].market, 140);
assert.equal(Value.cardStub(portfolio.owned.rows[0]).variants[0].key, "holofoil");
assert.equal(Value.artFor("base1-4").thumb, "https://assets.tcgdex.net/en/base/base1/4/low.webp");

const tiny = Value.build({ cards, ownedIds: ["tiny-1"], wishIds: [] });
assert.equal(tiny.owned.total, null);
assert.equal(tiny.owned.tiny, true);
assert.match(Value.coverageLine(tiny.owned, "owned"), /under one cent/);
assert.equal(Value.moneyText(tiny.owned.total), "");

const short = Value.build({
  cards: { "s-1": { name: "Short", history: history("holofoil", 10, 12, 5) } },
  ownedIds: ["s-1"],
  wishIds: []
});
assert.equal(short.owned.move30, null);
assert.equal(short.owned.move7, null);
assert.match(Value.moveLine(short.owned.move30, 30), /Not enough history/);
assert.equal(short.owned.spark.points.length, 0);

const calls = [];
const mem = new Map([
  ["bh.owned.v1", "{\"v\":1,\"ids\":[\"base1-4\"]}"],
  ["binderhuntWish", "[]"],
  ["bh.binders.v1", "{\"binders\":[]}"],
  ["bh.value.v1", JSON.stringify({ v: 1, at: 50, ownedTotal: 0, wishTotal: 10, ownedKey: "", wishKey: "" })]
]);
const storage = {
  getItem(key) { return mem.has(key) ? mem.get(key) : null; },
  setItem(key, value) { calls.push(key); mem.set(key, String(value)); }
};
assert.equal(Value.readSnapshot(storage), null, "a stored 0 is not a real total");
mem.set("bh.value.v1", JSON.stringify({ v: 1, at: 50, ownedTotal: 150, wishTotal: null, ownedKey: "base1-2,base1-4", wishKey: "" }));
const previous = Value.readSnapshot(storage);
assert.equal(previous.ownedTotal, 150);
assert.equal(previous.wishTotal, null);
const report = Value.visitDelta(previous, portfolio);
assert.equal(report.kind, "return");
assert.equal(report.owned.same, true);
assert.equal(report.owned.delta, 40);
assert.match(Value.visitLine(report, "owned"), /Up \$40\.00 since your last visit\./);
assert.equal(report.wish.kind, "unknown");
assert.match(Value.visitLine({ kind: "first" }, "owned"), /next visit/);
assert.equal(Value.writeSnapshot(storage, portfolio, 80), true);
assert.deepEqual(calls, [Value.KEY]);
assert.equal(storage.getItem("bh.owned.v1"), "{\"v\":1,\"ids\":[\"base1-4\"]}");
assert.equal(storage.getItem("binderhuntWish"), "[]");
assert.equal(JSON.parse(storage.getItem(Value.KEY)).ownedTotal, 190);
const again = Value.visitDelta(Value.readSnapshot(storage), portfolio);
assert.equal(again.owned.dir, "flat");
assert.match(Value.visitLine(again, "owned"), /Unchanged since your last visit/);

const changed = Value.visitDelta({
  v: 1,
  at: 10,
  ownedTotal: 10,
  wishTotal: 10,
  ownedKey: "other",
  wishKey: "base1-25"
}, portfolio);
assert.equal(changed.owned.same, false);
assert.match(Value.visitLine(changed, "owned"), /including cards you added or removed/);

const cache = JSON.parse(readFileSync(resolve(root, "data/scrydex.json"), "utf8"));
const real = Value.build({ cards: cache.cards, ownedIds: ["base1-4", "base1-2", "not-a-card"], wishIds: ["base1-15"] });
assert.ok(real.owned.priced >= 1, "cached charizard has a price");
assert.equal(real.owned.unpriced, 1);
assert.ok(real.owned.total >= 0.01);
assert.equal(Number.isFinite(real.owned.total), true);
assert.ok(real.owned.rows.filter(row => row.priced).every(row => row.latest > 0));
assert.equal(Value.moneyText(real.owned.total).includes("NaN"), false);
console.log("value math ok", {
  owned: real.owned.total,
  move7: real.owned.move7 && real.owned.move7.delta,
  move30: real.owned.move30 && real.owned.move30.delta,
  spark: real.owned.spark.points.length
});

const PORT = 8804;
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
      const res = await fetch("http://127.0.0.1:" + PORT + "/js/value.js", { signal: AbortSignal.timeout(500) });
      if (res.ok) { await res.arrayBuffer(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

const boot = `(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:["base1-4","base1-2","base1-999"],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("binderhuntWish", JSON.stringify([
    {id:"base1-4",name:"Charizard",set:"Base",setId:"base1",number:"4",img:"https://assets.tcgdex.net/en/base/base1/4/high.webp",thumb:"https://assets.tcgdex.net/en/base/base1/4/low.webp"},
    {id:"base1-25",name:"Pikachu",set:"Base",setId:"base1",number:"25",img:"https://assets.tcgdex.net/en/base/base1/25/high.webp",thumb:"https://assets.tcgdex.net/en/base/base1/25/low.webp"}
  ]));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
  localStorage.setItem("bh.value.v1", JSON.stringify({ v:1, at: Date.now() - 86400000, ownedTotal: 150, wishTotal: 10, ownedKey: "base1-2,base1-4", wishKey: "base1-25" }));
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
  await page.screenshot({ path: file });
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

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.setDefaultTimeout(25000);
watch(page);
await page.addInitScript(boot);
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof scrydex !== "undefined" && scrydex.ready && document.querySelector("#deck .card img"));
const lazy = await page.evaluate(() => ({
  defined: typeof BinderValue !== "undefined",
  tag: !!document.querySelector('script[src="js/value.js"]')
}));
note(lazy.defined === false && lazy.tag === false, "value files stay unloaded until the tab is opened", JSON.stringify(lazy));

await page.evaluate(() => {
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
  function history(variant, start, end, days) {
    const last = Date.UTC(2026, 9, 1);
    const rows = [];
    for (let ago = days; ago >= 0; ago--) {
      const t = new Date(last - ago * 86400000);
      const iso = t.getUTCFullYear() + "/" + String(t.getUTCMonth() + 1).padStart(2, "0") + "/" + String(t.getUTCDate()).padStart(2, "0");
      const price = start + (end - start) * (days - ago) / days;
      rows.push({ d: iso, v: variant, m: Math.round(price * 100) / 100 });
    }
    return rows;
  }
  function put(id, name, rows) {
    const prev = scrydex.cards[id] || {};
    scrydex.cards[id] = Object.assign({}, prev, { name: name || prev.name || id, history: rows, missing: false });
  }
  put("base1-4", "Charizard", history("holofoil", 100, 140, 40));
  put("base1-2", "Blastoise", history("holofoil", 80, 50, 40));
  put("base1-25", "Pikachu", history("normal", 20, 22, 40));
  put("base1-999", "Missingno", []);
});

const beforeKeys = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  onboard: localStorage.getItem("bh.onboard.v1")
}));

await page.locator(".tabs [data-tab=value]").click();
await page.waitForSelector(".value-title");
await page.waitForFunction(() => {
  const text = document.getElementById("valueScroll").innerText;
  return text.includes("Collection value") && !text.includes("Adding up");
});
const populated = await page.evaluate(() => {
  const root = document.getElementById("valueScroll");
  const text = root.innerText;
  const prices = [...root.querySelectorAll(".market-price")].map(el => el.textContent.trim());
  const tabs = [...document.querySelectorAll(".tabs .tabbtn")].map(el => ({
    text: el.textContent.replace(/\s+/g, " ").trim(),
    clipped: el.scrollWidth > el.clientWidth + 1,
    box: el.getBoundingClientRect().right
  }));
  const off = [...root.querySelectorAll("h2, h3, .market-price, .value-gap, .value-row, .go")].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && (r.left < -1 || r.right > window.innerWidth + 1);
  }).map(el => el.textContent.slice(0, 40));
  const broken = [...root.querySelectorAll("img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.src);
  const context = document.getElementById("context");
  return {
    text,
    prices,
    tabs,
    off,
    broken,
    current: document.querySelector('.tabs [data-tab="value"]').getAttribute("aria-current"),
    context: context ? context.textContent : "",
    contextClipped: context ? context.scrollWidth > context.clientWidth + 1 : false
  };
});
note(populated.current === "page", "Value tab is the current page");
note(populated.prices.includes("$190.00"), "owned total is the priced cards", populated.prices.join(" | "));
note(populated.prices.includes("$22.00"), "wishlist total is the cost to finish", populated.prices.join(" | "));
note(populated.text.includes("1 card has no price yet"), "unpriced cards are called out", populated.text.slice(0, 500));
note(populated.text.includes("Up $40.00 since your last visit"), "visit delta uses the stored snapshot", populated.text);
note(populated.text.includes("What it would cost to finish"), "wishlist explains the finish cost");
note(/Biggest gainers/.test(populated.text) && /Charizard/.test(populated.text) && /Blastoise/.test(populated.text), "movers list both directions");
note(!populated.text.includes("NaN"), "no NaN in the value view");
note(!populated.prices.some(price => price === "$0" || price === "$0.00"), "no $0 price", populated.prices.join(" | "));
note(!populated.tabs.some(tab => tab.clipped), "tab labels are not clipped", JSON.stringify(populated.tabs));
note(!populated.contextClipped && populated.context === "Value", "context label fits", populated.context);
note(populated.tabs.every(tab => tab.box <= 391), "tabs stay inside 390px", JSON.stringify(populated.tabs));
note(!populated.off.length, "value text stays inside the viewport", populated.off.join(" | "));
note(!populated.broken.length, "no broken images in the value view", populated.broken.join(" | "));
await page.evaluate(() => { document.getElementById("valueScroll").scrollTop = 0; });
const huntAxe = await axe(page, "value-390");
note(!huntAxe.length, "0 axe violations on the value view at 390", huntAxe.join(" || "));
await shot(page, "after-value-390");
await page.evaluate(() => {
  const spark = document.querySelector(".value-spark");
  if (spark) spark.scrollIntoView({ block: "center" });
});
await shot(page, "after-value-390-detail");

await page.locator(".value-row", { hasText: "Charizard" }).click();
await page.waitForSelector("#profile:not([hidden])");
const profile = await page.evaluate(() => {
  const el = document.getElementById("profile");
  return { text: el.innerText.slice(0, 500), hidden: el.hidden };
});
note(!profile.hidden && /Charizard/.test(profile.text) && !profile.text.includes("NaN"), "mover opens the card profile", profile.text.slice(0, 180));
await page.evaluate(() => { if (typeof closeProfile === "function") closeProfile(); });

const keys = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  onboard: localStorage.getItem("bh.onboard.v1"),
  value: JSON.parse(localStorage.getItem("bh.value.v1") || "null")
}));
note(keys.wish === beforeKeys.wish, "binderhuntWish was not rewritten");
note(keys.binders === beforeKeys.binders, "bh.binders.v1 was not rewritten");
note(keys.owned === beforeKeys.owned, "bh.owned.v1 was not rewritten");
note(keys.filters === beforeKeys.filters, "bh.filters.v3 was not rewritten");
note(keys.onboard === beforeKeys.onboard, "bh.onboard.v1 was not rewritten");
note(keys.value && keys.value.v === 1 && keys.value.ownedTotal === 190 && keys.value.wishTotal === 22, "bh.value.v1 stores the new totals", JSON.stringify(keys.value));

await page.setViewportSize({ width: 1440, height: 900 });
await page.locator(".rail [data-tab=value]").click();
await page.waitForSelector(".value-title");
await page.evaluate(() => { document.getElementById("valueScroll").scrollTop = 0; });
await sleep(250);
const wide = await page.evaluate(() => {
  const text = document.getElementById("valueScroll").innerText;
  const side = document.querySelector("[data-side='value']");
  const off = [...document.querySelectorAll("#valueScroll h2, #valueScroll .market-price, #valueScroll .value-row, .rail .tabbtn, #context")].filter(el => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 2 && r.height > 2)) return false;
    const visible = r.bottom > 0 && r.top < window.innerHeight;
    if (!visible) return false;
    return r.left < -1 || r.right > window.innerWidth + 1;
  }).map(el => el.textContent.replace(/\s+/g, " ").trim().slice(0, 48));
  const context = document.getElementById("context");
  return {
    text,
    side: side ? side.innerText.slice(0, 160) : "",
    off,
    wide: matchMedia("(min-width: 1024px)").matches,
    contextClipped: context ? context.scrollWidth > context.clientWidth + 1 : false,
    context: context ? context.textContent : ""
  };
});
note(wide.wide && /What you hold/.test(wide.side), "desktop side panel explains the total", wide.side);
note(wide.text.includes("$190.00") && wide.text.includes("$22.00"), "desktop shows both totals");
note(!wide.contextClipped, "context label is not clipped", wide.context);
note(!wide.off.length, "nothing is clipped at 1440x900", wide.off.join(" | "));
const wideAxe = await axe(page, "value-1440");
note(!wideAxe.length, "0 axe violations at 1440", wideAxe.join(" || "));
await shot(page, "after-value-1440");

await page.setViewportSize({ width: 390, height: 844 });
await page.locator(".tabs [data-tab=hunt]").click();
await page.waitForSelector("#deck .card");
const swipes = await page.evaluate(async () => {
  const problems = [];
  const before = pile.map(card => card.id);
  function swipe(el, dx, pointerType) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const pid = pointerType === "touch" ? 7 : 3;
    const opts = cx => ({ pointerId: pid, clientX: cx, clientY: y, pointerType, bubbles: true, button: 0, buttons: 1, isPrimary: true });
    el.dispatchEvent(new PointerEvent("pointerdown", opts(x)));
    window.dispatchEvent(new PointerEvent("pointermove", opts(x + dx / 3)));
    window.dispatchEvent(new PointerEvent("pointermove", opts(x + dx)));
    window.dispatchEvent(new PointerEvent("pointerup", Object.assign(opts(x + dx), { buttons: 0 })));
  }
  const mouseTop = topCard();
  if (!mouseTop) return ["no card to swipe"];
  swipe(mouseTop, -180, "mouse");
  await new Promise(r => setTimeout(r, 450));
  if (pile.some(card => card.id === before[0])) problems.push("mouse swipe did not pass " + before[0]);
  if (pile.length < 1) problems.push("deck ran dry after a mouse swipe");
  const touchTop = topCard();
  if (!touchTop) return problems.concat(["no card for the touch swipe"]);
  const touchId = touchTop.card && touchTop.card.id;
  swipe(touchTop, 180, "touch");
  await new Promise(r => setTimeout(r, 450));
  if (pile.some(card => card.id === touchId)) problems.push("touch swipe did not save " + touchId);
  if (!wish.some(card => card.id === touchId)) problems.push("touch swipe did not reach the wishlist");
  if (!document.querySelector("#deck .card")) problems.push("no card left on the table");
  return problems;
});
note(!swipes.length, "mouse and touch swipes still move the deck", (swipes || []).join(" | "));
note(!consoleErrors.length, "no console errors on the populated value view", consoleErrors.slice(0, 6).join(" | "));

const empty = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
empty.setDefaultTimeout(20000);
watch(empty);
await empty.addInitScript(boot.replace(
  'localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:["base1-4","base1-2","base1-999"],sets:{},celebrated:[],seeded:true}));',
  'localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));'
).replace(
  /localStorage\.setItem\("binderhuntWish", JSON\.stringify\(\[[\s\S]*?\]\)\);/,
  'localStorage.setItem("binderhuntWish", "[]");'
));
await empty.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await empty.waitForFunction(() => typeof showTab === "function" && document.querySelector("#deck .card, #deck .empty-state"));
await empty.evaluate(() => {
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
});
await empty.locator(".tabs [data-tab=value]").click();
await empty.waitForSelector("#valueHunt");
const emptyText = await empty.locator("#valueScroll").innerText();
note(/Nothing in your hands yet/.test(emptyText) && /Got it/.test(emptyText), "empty owned state points at swiping", emptyText.slice(0, 240));
note(!emptyText.includes("NaN") && !/\$0(?:\.00)?\b/.test(emptyText), "empty state has no price figure", emptyText.slice(0, 240));
const emptyAxe = await axe(empty, "empty-390");
note(!emptyAxe.length, "0 axe violations on the empty state", emptyAxe.join(" || "));
await shot(empty, "after-value-empty-390");
await empty.locator("#valueHunt").click();
await empty.waitForSelector("#viewHunt:not([hidden]) #deck");
const back = await empty.evaluate(() => document.getElementById("viewValue").hidden && !document.getElementById("viewHunt").hidden);
note(back, "Start swiping returns to the hunt");

if (problems.length || consoleErrors.length) {
  console.log("FAILED\n" + problems.concat(consoleErrors).join("\n"));
  await shutdown(1);
}
console.log("value checks passed");
await shutdown(0);
