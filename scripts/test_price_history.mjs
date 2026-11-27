// Price history on the card profile. The chart reads data/price-history.json,
// a rolling view of prices the Scrydex sync already stored. It does not call
// Scrydex. Run: npx -y node@22 scripts/test_price_history.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const History = require(resolve(root, "js/price-history.js"));
const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
const file = JSON.parse(readFileSync(resolve(root, "data/price-history.json"), "utf8"));

assert.match(sw, /const VERSION = "bh-24"/);
assert.match(sw, /"js\/price-history\.js"/);
assert.match(sw, /"data\/price-history\.json"/);
assert.match(sw, /data\/price-history\.json/);
assert.equal(html.includes("js/price-history.js"), false);
assert.equal(html.includes("data/price-history.json"), false);
assert.match(app, /ensurePriceHistory/);
assert.doesNotMatch(app + sw + html, /api\.scrydex\.com/);

const gzipped = gzipSync(readFileSync(resolve(root, "data/price-history.json")));
assert.ok(gzipped.length < 300 * 1024, "price history gzip is " + gzipped.length);
assert.equal(file.v, 1);
assert.equal(file.days, 90);
assert.equal(file.source, "Scrydex cache");
assert.ok(file.cards["base1-4"].unlimitedHolofoil.length >= 4);

function money(n) {
  if (!(n >= 0.01) || !Number.isFinite(n)) return "";
  return "$" + n.toFixed(2);
}

const dense = History.present(History.unpack(file.cards["base1-4"].unlimitedHolofoil), { money });
assert.equal(dense.status, "ready");
assert.equal(dense.tracking, false);
assert.equal(dense.active, "90d");
assert.equal(dense.moves["7d"].dir, "up");
assert.equal(dense.moves["30d"].dir, "up");
assert.equal(dense.moves["90d"].dir, "up");
assert.ok(dense.low >= 0.01 && dense.high >= dense.low);
assert.match(dense.summary, /7 day up/);
assert.match(dense.summary, /30 day up/);
assert.match(dense.summary, /90 day up/);
assert.doesNotMatch(dense.summary, /NaN|undefined|\$0(?:\.00)?\b/);

const sparsePacked = file.cards["ex15-98"].holofoil;
const sparse = History.present(History.unpack(sparsePacked), { money });
assert.equal(sparse.status, "tracking");
assert.equal(sparse.tracking, true);
assert.equal(sparse.moves["7d"], null);
assert.equal(sparse.moves["30d"], null);
assert.equal(sparse.moves["90d"], null);
assert.match(sparse.summary, /^Tracking since Oct 16, 2026/);
assert.equal(sparse.drawn.length, 2);
assert.doesNotMatch(sparse.summary, /NaN|undefined|\$0(?:\.00)?\b/);

const gapped = History.unpack([20261101, 1000, -20, 500]);
assert.equal(gapped[1].bridge, "gap");
assert.equal(History.present(gapped, { money }).moves["7d"], null);
assert.equal(History.priceOn(gapped, gapped[0].t + 5 * 86400000), null);
assert.equal(History.unpack([20261101, 0]).length, 0);
assert.equal(History.unpack([20261101, 1000, 1, -1000]).length, 0);
assert.equal(History.present([], { money }).status, "none");

const held = History.unpack([20261101, 1000, 10, 0]);
const week = History.windowMove(held, 7);
assert.ok(week && week.dir === "flat" && week.shown === 0);
assert.equal(History.priceOn(held, held[0].t + 7 * 86400000), 10);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

const PORT = 8842;
const vendor = "/tmp/binderhunt-playwright";
if (!existsSync(vendor + "/node_modules/playwright-core/package.json")) {
  mkdirSync(vendor, { recursive: true });
  const install = spawnSync("npm", ["install", "--prefix", vendor, "playwright-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
const pwRequire = createRequire(vendor + "/node_modules/playwright-core/package.json");
const { chromium } = pwRequire("playwright-core");

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
let browser;
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
      const res = await fetch("http://127.0.0.1:" + PORT + "/index.html", { signal: AbortSignal.timeout(500) });
      if (res.ok) { await res.arrayBuffer(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

const boot = `(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  const iso = bag.year + "-" + bag.month + "-" + bag.day;
  localStorage.setItem("bh.onboard.v1", JSON.stringify({ done:true, skipped:true }));
  localStorage.setItem("bh.filters.v3", JSON.stringify({ set:"", rarities:[], era:"", type:"", names:[], min:null, max:null, pricePreset:"", graded:false }));
  localStorage.setItem("bh.settings.v1", JSON.stringify({ sound:false, haptics:false, reduce:"on", currency:"USD" }));
  localStorage.setItem("bh.owned.v1", JSON.stringify({ v:1, ids:[], sets:{}, celebrated:[], seeded:true }));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted:iso, days:{} }));
  localStorage.setItem("bh.pwa.v1", JSON.stringify({ swipes:0, dismissed:true }));
  localStorage.setItem("binderhuntWish", JSON.stringify([]));
  localStorage.setItem("bh.binders.v1", JSON.stringify({ discoveryId:"", binders:[] }));
})();`;

await waitServer();
mkdirSync("/opt/cursor/artifacts", { recursive: true });
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

const problems = [];
function note(ok, name, extra) {
  if (ok) console.log("ok", name);
  else {
    problems.push(name + (extra ? " — " + extra : ""));
    console.log("FAIL", name, extra || "");
  }
}

function badMoney(text) {
  return /NaN|undefined/.test(text) || /\$0\.00\b|\$0(?!\.|\d)/.test(text);
}

async function openCard(page, id) {
  const hits = [];
  page.removeAllListeners("request");
  page.on("request", req => {
    if (/scrydex\.com/i.test(req.url()) && !req.url().includes("/data/")) hits.push(req.url());
  });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html?card=" + id, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const root = document.getElementById("profile");
    return root && !root.hidden && root.querySelector(".history .sparkline, .history .history-callout, .history .history-note");
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const img = document.querySelector("#profile .thumb img, #profileThumb img");
    return !img || (img.complete && img.naturalWidth > 0);
  }, null, { timeout: 15000 }).catch(() => {});
  return hits;
}

async function profileFacts(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#profile .profile-scroll");
    const text = root ? root.innerText : "";
    const price = (document.querySelector("#profile .market-price") || {}).textContent || "";
    const chips = [...document.querySelectorAll("#profile .history-chips button")].map(el => ({
      text: el.textContent.trim(),
      label: el.getAttribute("aria-label") || "",
      pressed: el.getAttribute("aria-pressed")
    }));
    const chart = document.querySelector("#profile .sparkline");
    const note = (document.querySelector("#profile .history-note") || {}).textContent || "";
    const range = (document.querySelector("#profile .history-range") || {}).textContent || "";
    const scrub = (document.querySelector("#profile .scrub") || {}).textContent || "";
    const aria = chart ? chart.getAttribute("aria-label") || "" : "";
    let clipped = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) clipped.push("page");
    if (root && root.scrollWidth > root.clientWidth + 2) clipped.push("profile");
    const priceBox = document.querySelector("#profile .market-price");
    const chartBox = chart || document.querySelector("#profile .history");
    const view = { top: 0, bottom: window.innerHeight };
    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.height > 8 && r.top < view.bottom - 8 && r.bottom > view.top + 8;
    };
    return {
      text, price: price.trim(), chips, note: note.trim(), range: range.trim(), scrub: scrub.trim(), aria,
      chart: !!chart, path: !!(chart && chart.querySelector("path")),
      tab: chart ? chart.getAttribute("tabindex") : "",
      clipped, priceVisible: visible(priceBox), chartVisible: visible(chartBox)
    };
  });
}

async function frameHistory(page) {
  await page.evaluate(() => {
    const scroller = document.querySelector("#profile .profile-scroll");
    const block = document.querySelector("#profile .history");
    if (!scroller || !block) return;
    const tools = document.querySelector("#profile .profile-tools");
    const stick = tools ? tools.getBoundingClientRect().height + 8 : 8;
    const top = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const price = document.querySelector("#profile .price-hero");
    const priceTop = price ? price.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
    const room = scroller.clientHeight - stick;
    const blockBottom = top + block.offsetHeight;
    if (blockBottom - priceTop <= room) scroller.scrollTop = Math.max(0, priceTop - stick);
    else scroller.scrollTop = Math.max(0, top - stick);
  });
  await sleep(80);
}

const sizes = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 }
];

try {
  const hunt = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const early = [];
  hunt.on("request", req => { if (/price-history\.json/.test(req.url())) early.push(req.url()); });
  await hunt.addInitScript(boot);
  await hunt.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
  await hunt.waitForSelector("#deck .card", { timeout: 25000 }).catch(() => {});
  await sleep(600);
  note(!early.length, "deck does not fetch price history", early.join(" "));
  await hunt.close();

  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(25000);
    await page.addInitScript(boot);
    const hits = await openCard(page, "base1-4");
    await frameHistory(page);
    const facts = await profileFacts(page);
    note(!hits.length, size.name + " no Scrydex API", hits.join(" "));
    note(!!facts.price && facts.price !== "—" && !badMoney(facts.price), size.name + " headline", facts.price);
    note(facts.chart && facts.path && facts.tab === "0", size.name + " sparkline", facts.tab);
    note(facts.chips.length === 3, size.name + " three chips", JSON.stringify(facts.chips));
    note(facts.chips.some(chip => chip.text.startsWith("7d") && /↑|↓/.test(chip.text) && /%/.test(chip.text)), size.name + " 7d chip", JSON.stringify(facts.chips));
    note(facts.chips.some(chip => chip.text.startsWith("30d") && /%/.test(chip.text)), size.name + " 30d chip", JSON.stringify(facts.chips));
    note(facts.chips.some(chip => chip.text.startsWith("90d") && /%/.test(chip.text) && chip.pressed === "true"), size.name + " 90d chip", JSON.stringify(facts.chips));
    note(/Low \$/.test(facts.range) && /High \$/.test(facts.range), size.name + " low high", facts.range);
    note(/7 day/.test(facts.aria) && /90 day/.test(facts.aria), size.name + " chart summary", facts.aria.slice(0, 180));
    note(!badMoney(facts.text), size.name + " no NaN or $0");
    note(!facts.clipped.length, size.name + " nothing clipped", facts.clipped.join(", "));
    const reached = await page.evaluate(() => {
      const chart = document.querySelector("#profile .sparkline");
      if (!chart) return false;
      chart.focus();
      return document.activeElement === chart;
    });
    note(reached, size.name + " chart focuses");
    const before = await page.locator("#profile .scrub").innerText();
    await page.keyboard.press("ArrowLeft");
    const after = await page.locator("#profile .scrub").innerText();
    note(after !== before && /\$\d/.test(after) && !badMoney(after), size.name + " arrow key reads a day", after);
    await frameHistory(page);
    const shot = "/opt/cursor/artifacts/price-history-" + size.name + ".png";
    await page.screenshot({ path: shot });
    const png = readFileSync(shot);
    note(png.readUInt32BE(16) === size.width && png.readUInt32BE(20) === size.height, size.name + " screenshot size");
    const seen = await profileFacts(page);
    const chipHit = await page.evaluate(() => {
      const btn = document.querySelector("#profile .history-chips button");
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
      return !!(top && (top === btn || btn.contains(top)));
    });
    note(chipHit, size.name + " chips are on top of the chart");
    note(seen.priceVisible && seen.chartVisible, size.name + " price and chart on screen");

    const sparseHits = await openCard(page, "ex15-98");
    await frameHistory(page);
    const thin = await profileFacts(page);
    note(!sparseHits.length, size.name + " sparse no Scrydex API");
    note(/Tracking since Oct 16, 2026/.test(thin.text), size.name + " tracking since", thin.note + " | " + thin.text.slice(0, 240));
    note(thin.chips.length === 3 && thin.chips.every(chip => !/%|↑|↓|NaN/.test(chip.text)), size.name + " sparse chips stay blank", JSON.stringify(thin.chips));
    note(!badMoney(thin.text), size.name + " sparse no NaN or $0");
    note(!thin.clipped.length, size.name + " sparse nothing clipped", thin.clipped.join(", "));
    note(thin.chart || /Tracking since/.test(thin.text), size.name + " sparse shows the points");
    const sparseShot = "/opt/cursor/artifacts/price-history-sparse-" + size.name + ".png";
    await page.screenshot({ path: sparseShot });
    const sparsePng = readFileSync(sparseShot);
    note(sparsePng.readUInt32BE(16) === size.width && sparsePng.readUInt32BE(20) === size.height, size.name + " sparse screenshot size");
    await page.close();
  }
} catch (error) {
  problems.push(String(error && error.stack || error));
  console.log("FAIL", error);
}

console.log(problems.length ? "\n" + problems.length + " failed" : "\nall price history checks passed");
await shutdown(problems.length ? 1 : 0);
