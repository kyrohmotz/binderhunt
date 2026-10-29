// Stored filters must survive only when they are real, and a chip's × must be
// the thing a tap hits. Run: npx -y node@22 scripts/test_filters.mjs
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8794;
const vendor = "/tmp/binderhunt-playwright";
if (!existsSync(vendor + "/node_modules/playwright-core/package.json")) {
  mkdirSync(vendor, { recursive: true });
  const install = spawnSync("npm", ["install", "--prefix", vendor, "playwright-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
const require = createRequire(vendor + "/node_modules/playwright-core/package.json");
const { chromium } = require("playwright-core");

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const errors = [];
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
      if (res.ok) return;
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

const boot = `(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  const iso = bag.year + "-" + bag.month + "-" + bag.day;
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("binderhuntWish","[]");
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"off",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted:iso, days:{} }));
})();`;

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20000);
page.on("pageerror", err => errors.push(String(err && err.message || err).split("\n")[0]));
page.on("console", msg => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  if (text) errors.push(text.split("\n")[0]);
});
page.on("request", req => {
  const url = req.url();
  if (/scrydex\.com/i.test(url)) errors.push("unexpected Scrydex request " + url);
});
await page.addInitScript(boot);

const problems = [];
function note(ok, name, extra) {
  if (!ok) problems.push(name + (extra ? " — " + extra : ""));
}

async function show(filters) {
  await page.evaluate(payload => localStorage.setItem("bh.filters.v3", JSON.stringify(payload)), filters);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof meta !== "undefined" && meta.ready && meta.complete);
  await page.evaluate(() => document.fonts.ready);
}

const pikachu = {
  id: "base4-4",
  name: "Pikachu",
  setId: "base4",
  rarity: "Rare Holo",
  types: ["Lightning"],
  img: "https://assets.tcgdex.net/en/base/base4/4/high.webp",
  thumb: "https://assets.tcgdex.net/en/base/base4/4/low.webp",
  variants: [{ market: 4 }]
};

await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });

await show({
  set: 12,
  type: { a: 1 },
  names: [1, "  Pikachu  "],
  rarities: [1, { a: 1 }, "Rare Holo"],
  era: { a: 1 },
  pricePreset: "under10",
  graded: { a: 1 },
  min: { a: 1 },
  max: "no"
});
let got = await page.evaluate(card => ({
  filters: { set: filters.set, type: filters.type, names: filters.names.slice(), rarities: filters.rarities.slice(), era: filters.era, pricePreset: filters.pricePreset, graded: filters.graded, min: filters.min, max: filters.max },
  stored: JSON.parse(localStorage.getItem("bh.filters.v3")),
  hint: (document.querySelector("#activeChips .filter-hint") || {}).textContent || "",
  chips: [...document.querySelectorAll("#activeChips [data-clear]")].map(btn => btn.textContent.trim()),
  keepPika: keep(card),
  huntEnd: document.getElementById("deck").dataset.huntEnd || ""
}), pikachu);
note(got.filters.set === "", "number set is dropped", JSON.stringify(got.filters));
note(got.filters.type === "", "object type is dropped", JSON.stringify(got.filters));
note(got.filters.type !== "[object Object]" && got.stored.type !== "[object Object]", "type is never stringified from an object", JSON.stringify(got.stored));
note(JSON.stringify(got.filters.names) === JSON.stringify(["Pikachu"]), "names keep the trimmed string and drop the number", JSON.stringify(got.filters.names));
note(!got.filters.names.includes("1") && !got.stored.names.includes("1"), "a numeric name is not coerced to '1'", JSON.stringify(got.stored.names));
note(got.filters.era === "", "object era is dropped", JSON.stringify(got.filters));
note(got.filters.rarities.join("|") === "Rare Holo", "non-string rarities are dropped", JSON.stringify(got.filters.rarities));
note(got.filters.pricePreset === "under10", "a real price preset stays", got.filters.pricePreset);
note(got.filters.graded === false && got.filters.min == null && got.filters.max == null, "bad graded and prices are dropped", JSON.stringify(got.filters));
note(got.stored.set !== "12" && got.stored.set !== 12, "stored set is not the coerced id", JSON.stringify(got.stored));
note(got.keepPika === true, "leftover Pikachu and Under $10 still match a card", JSON.stringify(got));
note(got.huntEnd !== "none", "a corrupted filter does not end the hunt as nothing fits", got.huntEnd);
note(got.chips.some(text => text.indexOf("Pikachu") >= 0) && got.chips.some(text => text.indexOf("Under $10") >= 0), "valid leftovers stay on the chip row", got.chips.join(" | "));

await show({
  set: "12",
  type: "[object Object]",
  names: [1, "   "],
  rarities: ["[object Object]"],
  era: "nope",
  pricePreset: "nope",
  graded: false,
  min: null,
  max: null
});
got = await page.evaluate(card => ({
  filters: { set: filters.set, type: filters.type, names: filters.names.slice(), rarities: filters.rarities.slice(), era: filters.era, pricePreset: filters.pricePreset },
  hint: (document.querySelector("#activeChips .filter-hint") || {}).textContent || "",
  keepPika: keep(card),
  huntEnd: document.getElementById("deck").dataset.huntEnd || ""
}), pikachu);
note(got.filters.set === "" && got.filters.type === "" && got.filters.names.length === 0 && got.filters.era === "" && got.filters.rarities.length === 0, "string junk is dropped too", JSON.stringify(got.filters));
note(got.hint === "All physical cards", "nothing valid reads as all physical cards", got.hint);
note(got.keepPika === true, "a fully corrupted entry does not empty the hunt", JSON.stringify(got));
note(got.huntEnd !== "none", "all-physical hunt is not the empty-filter end state", got.huntEnd);

await show({
  set: "base4",
  type: "Fire",
  names: [1, "  Pikachu  "],
  rarities: ["Rare Holo", 2],
  era: "WOTC",
  pricePreset: "under10",
  graded: false,
  min: null,
  max: null
});
got = await page.evaluate(() => ({
  filters: { set: filters.set, type: filters.type, names: filters.names.slice(), rarities: filters.rarities.slice(), era: filters.era, pricePreset: filters.pricePreset }
}));
note(got.filters.set === "base4" && got.filters.type === "Fire" && got.filters.era === "WOTC" && got.filters.pricePreset === "under10", "real set, type, era, and price stay", JSON.stringify(got.filters));
note(JSON.stringify(got.filters.names) === JSON.stringify(["Pikachu"]) && got.filters.rarities.join("|") === "Rare Holo", "mixed name and rarity lists keep only real strings", JSON.stringify(got.filters));

const catalogId = await page.evaluate(() => {
  const hit = (meta.sets || []).find(s => s && s.id && s.id !== "base4" && s.id !== "me02");
  return hit ? hit.id : "";
});
note(!!catalogId, "catalog has a set id to round-trip", catalogId);
if (catalogId) {
  await show({ set: catalogId, type: "Water", names: [], rarities: [], era: "", pricePreset: "", graded: false, min: null, max: null });
  got = await page.evaluate(() => ({ set: filters.set, type: filters.type }));
  note(got.set === catalogId && got.type === "Water", "a catalog set id and a known type stay", JSON.stringify(got));
}

async function chipReport() {
  return page.evaluate(() => {
    const scroller = document.getElementById("activeChips");
    const reset = document.getElementById("resetFilters");
    const open = document.getElementById("openFilters");
    const box = el => el.getBoundingClientRect();
    function hitAt(x, y) {
      const top = document.elementFromPoint(x, y);
      return {
        id: top && top.id || "",
        clear: top && top.closest ? (top.closest("[data-clear]") || {}).dataset && top.closest("[data-clear]").dataset.clear || "" : ""
      };
    }
    function inspect(where) {
      scroller.scrollLeft = where === "end" ? scroller.scrollWidth : 0;
      const sr = box(scroller);
      const rr = box(reset);
      const or = box(open);
      const overlap = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      const marks = [...scroller.querySelectorAll(".xmark")].map(mark => {
        const chip = mark.closest("[data-clear]");
        const r = box(mark);
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const visible = r.width > 2 && r.height > 2 && cx >= sr.left + 0.5 && cx <= sr.right - 0.5 && cy >= sr.top + 0.5 && cy <= sr.bottom - 0.5;
        const hit = hitAt(cx, cy);
        return {
          key: chip ? chip.dataset.clear : "",
          label: chip ? chip.textContent.trim() : "",
          visible,
          hitId: hit.id,
          hitClear: hit.clear,
          insideReset: cx >= rr.left && cx <= rr.right && cy >= rr.top && cy <= rr.bottom,
          insideOpen: cx >= or.left && cx <= or.right && cy >= or.top && cy <= or.bottom
        };
      });
      return {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollerOverlapsReset: overlap(sr, rr),
        scrollerOverlapsOpen: overlap(sr, or),
        marks
      };
    }
    const each = [...scroller.querySelectorAll(".xmark")].map(mark => {
      mark.scrollIntoView({ inline: "nearest", block: "nearest" });
      const chip = mark.closest("[data-clear]");
      const sr = box(scroller);
      const r = box(mark);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = hitAt(cx, cy);
      return {
        key: chip ? chip.dataset.clear : "",
        visible: cx >= sr.left + 0.5 && cx <= sr.right - 0.5 && cy >= sr.top + 0.5 && cy <= sr.bottom - 0.5,
        hitId: hit.id,
        hitClear: hit.clear
      };
    });
    scroller.scrollLeft = 0;
    return { start: inspect("start"), end: inspect("end"), each };
  });
}

await show({ set: "", rarities: [], era: "WOTC", type: "Fire", names: [], min: null, max: null, pricePreset: "under10", graded: false });
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
mkdirSync("/opt/cursor/artifacts", { recursive: true });
await page.screenshot({ path: "/opt/cursor/artifacts/chip-bar-390.png" });

for (const width of [390, 320]) {
  await page.setViewportSize({ width, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const report = await chipReport();
  const visible = report.start.marks.filter(mark => mark.visible).concat(report.end.marks.filter(mark => mark.visible));
  note(report.start.scrollWidth > report.start.clientWidth + 2, width + " chip row scrolls instead of covering Clear", JSON.stringify({ scroll: report.start.scrollWidth, client: report.start.clientWidth }));
  note(!report.start.scrollerOverlapsReset && !report.end.scrollerOverlapsReset, width + " chip scroller does not sit under Clear", JSON.stringify(report.start));
  note(!report.start.scrollerOverlapsOpen && !report.end.scrollerOverlapsOpen, width + " chip scroller does not sit under Filters", JSON.stringify(report.start));
  note(visible.length > 0, width + " has a visible ×", JSON.stringify(report));
  visible.forEach(mark => {
    note(mark.hitClear === mark.key && mark.hitId !== "resetFilters" && mark.hitId !== "openFilters" && !mark.insideReset && !mark.insideOpen, width + " × for " + mark.label + " receives the tap", JSON.stringify(mark));
  });
  report.each.forEach(mark => {
    note(mark.visible && mark.hitClear === mark.key && mark.hitId !== "resetFilters", width + " scrolled × for " + mark.key + " receives the tap", JSON.stringify(mark));
  });
}

await page.setViewportSize({ width: 390, height: 844 });
const wotc = await page.evaluate(() => {
  const mark = [...document.querySelectorAll("#activeChips .xmark")].find(node => (node.closest("[data-clear]") || {}).dataset.clear === "era");
  if (!mark) return null;
  mark.scrollIntoView({ inline: "nearest", block: "nearest" });
  const r = mark.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
note(!!wotc, "WOTC × is on the row");
if (wotc) {
  const top = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    return { id: node && node.id || "", clear: node && node.closest && node.closest("[data-clear]") ? node.closest("[data-clear]").dataset.clear : "" };
  }, wotc);
  note(top.clear === "era" && top.id !== "resetFilters", "elementFromPoint on the WOTC × is that chip", JSON.stringify(top));
  await page.mouse.click(wotc.x, wotc.y);
  await page.waitForFunction(() => filters.era === "" && filters.type === "Fire" && filters.pricePreset === "under10");
  const after = await page.evaluate(() => ({ era: filters.era, type: filters.type, price: filters.pricePreset }));
  note(after.era === "" && after.type === "Fire" && after.price === "under10", "tapping the WOTC × clears only that filter", JSON.stringify(after));
}

if (errors.length) problems.push("page errors: " + errors.slice(0, 4).join(" | "));
if (problems.length) {
  console.error(problems.join("\n"));
  await shutdown(1);
}
console.log("filter store and chip taps ok");
await shutdown(0);
