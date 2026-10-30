// Gemfinder: the gem heuristic, and a pocket that deals again instead of
// going empty. The browser half checks the mode, wishlist, images, and
// both pointer and mouse swipes.
// Run: npx -y node@22 scripts/test_gems.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import gems from "../js/gems.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  judgeGem, buildCatalog, dealGems, takeGemCycle, saveHeat, gemArt, typeMatches,
  GEM_MIN, GEM_MAX, GEM_HEAT, EXPLAIN, WRAP_MESSAGE
} = gems;

const problems = [];
function check(name, fn) {
  try {
    fn();
    console.log("ok", name);
  } catch (error) {
    const line = name + " — " + (error && error.message ? error.message : error);
    problems.push(line);
    console.error("FAIL", line);
  }
}

function card(extra) {
  return Object.assign({
    id: "dp7-6",
    name: "Magnezone",
    set: "Stormfront",
    setId: "dp7",
    number: "6",
    rarity: "Rare Holo",
    price: 24
  }, extra);
}

check("price band and printing rules", () => {
  assert.equal(EXPLAIN, "Hand-picked eras and rarities that fly under the radar.");
  const holo = judgeGem(card());
  assert.equal(holo.gem, true);
  assert.equal(holo.reason, "mid-era");
  assert.equal(holo.hint, "DP holo");
  assert.match(holo.why, /Not a grade population/);
  assert.equal(holo.usd, 24);

  const sky = judgeGem(card({
    id: "ecard3-H18", setId: "ecard3", set: "Skyridge", number: "H18",
    name: "Magneton", rarity: "Holo Rare", price: 76.28
  }));
  assert.equal(sky.gem, true);
  assert.equal(sky.hint, "Skyridge holo");

  const aqua = judgeGem(card({
    id: "ecard2-H03", setId: "ecard2", set: "Aquapolis", number: "H03",
    name: "Ariados", rarity: "Holo Rare", price: 74.96
  }));
  assert.equal(aqua.gem, true);
  assert.equal(aqua.hint, "Aquapolis holo");

  const expedition = judgeGem(card({
    id: "ecard1-14", setId: "ecard1", set: "Expedition Base Set", number: "14",
    name: "Golem", rarity: "Holo Rare", price: 29.59
  }));
  assert.equal(expedition.hint, "Expedition holo");

  assert.equal(judgeGem(card({ rarity: "Illustration rare", setId: "sm1", id: "sm1-1", price: 40 })).gem, false);
  assert.equal(judgeGem(card({ rarity: "Illustration rare", setId: "sm1", id: "sm1-1", price: 40 })).reason, "chase-rarity");
  assert.equal(judgeGem(card({ id: "base1-4", setId: "base1", rarity: "Rare Holo", price: 400 })).gem, false);
  assert.equal(judgeGem(card({ id: "ecard2-1", setId: "ecard2", number: "1", rarity: "Rare", price: 31 })).gem, false);
  assert.equal(judgeGem(card({ price: 0 })).gem, false);
  assert.equal(judgeGem(card({ price: NaN })).gem, false);
  assert.equal(judgeGem(card({ price: 3 })).reason, "band");
  assert.equal(judgeGem(card({ price: 900, rarity: "Holo Rare", setId: "ecard3", number: "H30", id: "ecard3-H30" })).reason, "band");
  assert.equal(judgeGem(card({ tier: "A", price: 40 })).reason, "chase-tier");
  assert.equal(judgeGem(card({ setId: "base4", id: "base4-4", rarity: "Rare Holo" })).reason, "opening");
  assert.equal(judgeGem(card({ setId: "sm3.5", id: "sm3.5-57", rarity: "Ultra Rare", price: 20 })).reason, "no-scan");
  assert.equal(judgeGem(card({ price: null, variants: [{ market: 0 }] })).reason, "price");

  const eur = judgeGem({
    id: "ex5-1", setId: "ex5", number: "1", name: "Hidden", rarity: "Rare Holo",
    quoteCurrency: "EUR", quoteAmount: 20
  }, { fx: 1.1 });
  assert.equal(eur.gem, true);
  assert.equal(eur.usd, 22);
  assert.equal(judgeGem({
    id: "ex5-1", setId: "ex5", number: "1", rarity: "Rare Holo",
    quoteCurrency: "EUR", quoteAmount: 20
  }).reason, "price");

  const topps = judgeGem(card({
    id: "topps-4", setId: "toppschrome", set: "Topps Chrome", name: "Pikachu",
    number: "4", rarity: "Chrome", price: 18
  }));
  assert.equal(topps.gem, true);
  assert.equal(topps.hint, "Topps Chrome");
  const tekno = judgeGem(card({
    id: "tekno-2", setId: "toppschrome", set: "Topps Chrome", name: "Mew Tekno",
    number: "2", rarity: "Chrome", price: 22
  }));
  assert.equal(tekno.hint, "Tekno Chrome");

  assert.equal(judgeGem(card({ id: "xy2-12", setId: "xy2", name: "Charizard EX", rarity: "Ultra Rare", price: 20 })).reason, "printing");
  assert.equal(judgeGem(card({ id: "sm9-165", setId: "sm9", name: "Lugia GX", rarity: "Ultra Rare", price: 40 })).gem, false);
  assert.equal(judgeGem(card({ id: "bw1-114", setId: "bw1", name: "Zekrom", rarity: "Ultra Rare", price: 40 })).reason, "printing");
  assert.equal(judgeGem(card({ id: "xy1-5", setId: "xy1", rarity: "Rare Holo", price: 18 })).hint, "XY holo");
  assert.equal(judgeGem(card({ id: "bw4-8", setId: "bw4", rarity: "Holo Rare", price: 16 })).hint, "BW holo");
  assert.equal(judgeGem(card({ id: "col1-17", setId: "col1", name: "Ninetales", rarity: "Holo Rare", price: 71 })).hint, "Call of Legends holo");
  assert.equal(judgeGem(card({ id: "hgss1-7", setId: "hgss1", name: "Ninetales", rarity: "Holo Rare", price: 60 })).hint, "HGSS holo");
  assert.equal(judgeGem(card({ id: "dp3-3", setId: "dp3", rarity: "Rare Holo LV.X", price: 30 })).hint, "DP LV.X");
  assert.equal(judgeGem(card({ id: "hgss1-110", setId: "hgss1", rarity: "Rare PRIME", price: 40 })).hint, "HGSS Prime");
  assert.equal(judgeGem(card({ id: "hgss2-1", setId: "hgss2", rarity: "LEGEND", price: 40 })).hint, "HGSS LEGEND");
  assert.equal(judgeGem(card({ id: "hgss1-ONE", setId: "hgss1", rarity: "Ultra Rare", price: 40 })).hint, "HGSS ultra");
  assert.equal(judgeGem(card({ id: "ex5-100", setId: "ex5", rarity: "Rare Holo EX", price: 30 })).gem, true);

  const warm = saveHeat([{ k: "save", id: "dp7-6" }, { k: "save", id: "dp7-6" }, { k: "own", id: "dp7-6" }]);
  assert.equal(judgeGem(card(), { heat: warm }).gem, true);
  warm["dp7-6"] = GEM_HEAT;
  assert.equal(judgeGem(card(), { heat: warm }).reason, "saved-often");
});

check("e-Card holo art does not point at a missing TCGdex scan", () => {
  const art = gemArt("ecard2", "H03");
  assert.equal(art.img, "https://images.pokemontcg.io/ecard2/H3.png");
  assert.equal(art.thumb, art.img);
  const plain = gemArt("dp7", "6");
  assert.match(plain.thumb, /\/dp\/dp7\/6\/low\.webp$/);
  assert.match(plain.backup, /images\.pokemontcg\.io\/dp7\/6\.png$/);
});

check("a small pocket deals again and never comes back empty", () => {
  const pool = [
    card({ id: "a" }),
    card({ id: "b", setId: "ex1", number: "1" }),
    card({ id: "c", setId: "bw1", number: "2", rarity: "Ultra Rare" })
  ];
  const cycle = { cards: pool, cursor: 0, lap: 0 };
  const seen = [];
  let wraps = 0;
  for (let n = 0; n < 9; n++) {
    const pull = takeGemCycle(cycle, 1, new Set());
    assert.equal(pull.dry, false);
    assert.equal(pull.cards.length, 1, "pull " + n);
    if (pull.wrapped) wraps += 1;
    seen.push(pull.cards[0].id);
  }
  assert.equal(new Set(seen).size, 3);
  assert.ok(wraps >= 2, "wraps " + wraps);
  const stacked = takeGemCycle({ cards: pool.slice(0, 2), cursor: 0, lap: 0 }, 5, new Set());
  assert.equal(stacked.cards.length, 2);
  assert.equal(stacked.wrapped, false);
  assert.equal(stacked.dry, false);
  const held = takeGemCycle(stacked && { cards: pool.slice(0, 2), cursor: 0, lap: 0 }, 1, new Set(["a", "b"]));
  assert.equal(held.cards.length, 0);
  assert.equal(held.dry, false);
  const empty = takeGemCycle({ cards: [], cursor: 0, lap: 0 }, 3, new Set());
  assert.equal(empty.dry, true);
  assert.equal(empty.cards.length, 0);
  assert.equal(WRAP_MESSAGE.length > 10, true);
});

check("a pocket of four sets wrapped when the next lap deals a card", () => {
  const four = ["a", "b", "c", "d"].map((id, index) => card({
    id, setId: "ecard3", set: "Skyridge", number: "H" + (index + 1), rarity: "Holo Rare", price: 40
  }));
  const cycle = { cards: four, cursor: 0, lap: 0 };
  const first = takeGemCycle(cycle, 5, new Set());
  assert.equal(first.cards.length, 4);
  assert.equal(first.wrapped, false);
  assert.equal(first.dry, false);
  assert.equal(cycle.cursor, four.length);
  const next = takeGemCycle(cycle, 1, new Set(["b", "c", "d"]));
  assert.equal(next.wrapped, true);
  assert.equal(next.cards.length, 1);
  assert.equal(next.cards[0].id, "a");
  assert.equal(next.dry, false);
  const solo = { cards: [card({ id: "only" })], cursor: 0, lap: 0 };
  const fill = takeGemCycle(solo, 5, new Set());
  assert.equal(fill.cards.length, 1);
  assert.equal(fill.wrapped, false);
  const again = takeGemCycle(solo, 1, new Set());
  assert.equal(again.wrapped, true);
  assert.equal(again.cards[0].id, "only");
});

check("local types fill a gem and an unknown type still matches a filter", () => {
  const seed = [
    "B ecard1-21  # Ninetales · Holo Rare · 40 USD",
    "B ex2-5  # Flareon · Holo Rare · 40 USD",
    "B dp7-6  # Magnezone · Rare Holo · 24 USD",
    "B hgss3-5  # Houndoom · Holo Rare · 38 USD",
    "B ecard1-26  # Rapidash · Holo Rare · 40 USD"
  ].join("\n");
  const dailyPool = [
    { id: "lc-17", name: "Ninetales", setId: "lc", num: "17", rarity: "Holo Rare", price: 10, types: ["Fire"] },
    { id: "lc-10", name: "Flareon", setId: "lc", num: "10", rarity: "Holo Rare", price: 10, types: ["Fire"] },
    { id: "dp7-6", name: "Magnezone", setId: "dp7", num: "6", rarity: "Rare Holo", price: 24, types: ["Metal"] },
    { id: "xy-fire", name: "Houndoom", setId: "xy8", num: "1", rarity: "Rare Holo", price: 12, types: ["Fire"] },
    { id: "col-dark", name: "Houndoom", setId: "col1", num: "10", rarity: "Holo Rare", price: 12, types: ["Darkness"] }
  ];
  const pocket = buildCatalog({ seedText: seed, dailyPool, fx: 1 });
  const byId = Object.fromEntries(pocket.map(row => [row.id, row]));
  assert.deepEqual(byId["ecard1-21"].types, ["Fire"]);
  assert.deepEqual(byId["ex2-5"].types, ["Fire"]);
  assert.deepEqual(byId["dp7-6"].types, ["Metal"]);
  assert.deepEqual(byId["hgss3-5"].types, []);
  assert.deepEqual(byId["ecard1-26"].types, []);
  assert.equal(typeMatches(byId["ecard1-21"], "Fire"), true);
  assert.equal(typeMatches(byId["ecard1-21"], "Water"), false);
  assert.equal(typeMatches(byId["dp7-6"], "Fire"), false);
  assert.equal(typeMatches(byId["hgss3-5"], "Fire"), true);
  assert.equal(typeMatches(byId["ecard1-26"], "Fire"), true);
  assert.equal(typeMatches(byId["ecard1-26"], ""), true);
});

const fx = JSON.parse(readFileSync(resolve(root, "data/fx.json"), "utf8"));
const seedText = readFileSync(resolve(root, "data/scrydex-seed.txt"), "utf8");
const daily = JSON.parse(readFileSync(resolve(root, "data/daily.json"), "utf8"));
const catalog = buildCatalog({ seedText, dailyPool: daily.pool, fx: fx.eurUsd });
const hints = {};
catalog.forEach(card => { hints[card.gemHint] = (hints[card.gemHint] || 0) + 1; });
console.log("gem pool", catalog.length, "hints", JSON.stringify(hints));

check("the saved lists produce a real pocket inside the band", () => {
  assert.ok(catalog.length >= 200, "pool " + catalog.length);
  assert.ok(catalog.some(card => card.setId === "ecard2" && card.gemHint === "Aquapolis holo"));
  assert.ok(catalog.some(card => card.setId === "ecard3" && card.gemHint === "Skyridge holo"));
  assert.ok(catalog.some(card => card.setId === "ecard1"));
  ["XY ultra", "SM ultra", "BW ultra"].forEach(hint => assert.equal(hints[hint] || 0, 0, hint));
  assert.equal(hints["Call of Legends holo"], 13);
  assert.ok(hints["Skyridge holo"] >= 1);
  assert.ok(hints["Aquapolis holo"] >= 1);
  assert.ok(hints["Expedition holo"] >= 1);
  assert.ok(hints["EX holo"] >= 1);
  assert.ok(hints["DP holo"] >= 1);
  assert.ok(hints["DP LV.X"] >= 1);
  assert.ok(hints["HGSS holo"] >= 1);
  assert.ok(hints["HGSS Prime"] >= 1);
  assert.ok(hints["HGSS LEGEND"] >= 1);
  const fireNames = catalog.filter(row => row.name === "Ninetales" || row.name === "Flareon");
  assert.ok(fireNames.length >= 2);
  fireNames.forEach(row => assert.ok(row.types.includes("Fire"), row.id + " " + JSON.stringify(row.types)));
  const unknown = catalog.filter(row => !row.types.length);
  assert.ok(unknown.length > 0, "unknown types");
  unknown.forEach(row => assert.equal(typeMatches(row, "Fire"), true));
  const other = catalog.filter(row => row.types.length && !row.types.includes("Fire"));
  assert.ok(other.length > 0);
  other.forEach(row => assert.equal(typeMatches(row, "Fire"), false));
  catalog.forEach(card => {
    assert.ok(card.price >= GEM_MIN && card.price <= GEM_MAX, card.id + " " + card.price);
    assert.equal(Number.isFinite(card.price), true);
    assert.notEqual(card.price, 0);
    assert.ok(card.gemHint);
    assert.equal(/^(XY|SM|BW) ultra$/.test(card.gemHint), false, card.id + " " + card.gemHint);
    if (card.setId === "col1") assert.equal(card.gemHint, "Call of Legends holo", card.id);
    assert.ok(card.thumb && card.img);
    assert.equal(/Illustration rare|Special illustration rare|Hyper rare/.test(card.rarity), false);
  });
  const sky = catalog.filter(row => row.setId === "ecard3");
  assert.equal(sky.length, 4);
  const skyCycle = { cards: sky, cursor: 0, lap: 0 };
  const skyFill = takeGemCycle(skyCycle, 5, []);
  assert.equal(skyFill.cards.length, 4);
  assert.equal(skyFill.wrapped, false);
  const skyLap = takeGemCycle(skyCycle, 1, new Set(skyFill.cards.slice(1).map(row => row.id)));
  assert.equal(skyLap.wrapped, true);
  assert.equal(skyLap.cards.length, 1);
  assert.equal(skyLap.cards[0].id, skyFill.cards[0].id);
  const order = dealGems(catalog, () => 0.5);
  assert.equal(order[0].setId.slice(0, 5), "ecard");
  const cycle = { cards: order, cursor: 0, lap: 0 };
  let wraps = 0;
  const ids = new Set();
  for (let n = 0; n < order.length + 3; n++) {
    const pull = takeGemCycle(cycle, 1, []);
    assert.equal(pull.dry, false);
    assert.equal(pull.cards.length, 1);
    ids.add(pull.cards[0].id);
    if (pull.wrapped) wraps += 1;
  }
  assert.equal(ids.size, order.length);
  assert.ok(wraps >= 1);
});

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const PORT = 8798;
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
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false,gem:false}));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted:iso, days:{} }));
  localStorage.setItem("bh.log.v1", JSON.stringify({v:1,days:[],events:[]}));
})();`;

function note(ok, name, extra) {
  if (ok) console.log("ok", name);
  else {
    const line = name + (extra ? " — " + extra : "");
    problems.push(line);
    console.error("FAIL", line);
  }
}

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true
});
const page = await context.newPage();
page.setDefaultTimeout(25000);
page.on("pageerror", err => errors.push(String(err && err.message || err).split("\n")[0]));
page.on("console", msg => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  if (!text || /Failed to load resource|net::ERR/i.test(text)) return;
  errors.push(text.split("\n")[0]);
});
page.on("request", req => {
  const url = req.url();
  if (/scrydex\.com/i.test(url)) errors.push("unexpected Scrydex request " + url);
});
await page.addInitScript(boot);
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof BinderGems !== "undefined" && typeof meta !== "undefined" && meta.ready);

await page.locator("#gemMode").click();
await page.waitForFunction(() => {
  const top = typeof topCard === "function" ? topCard() : null;
  const img = top && top.querySelector("img");
  const hint = top && top.querySelector(".gem-hint");
  const price = document.getElementById("capPrice");
  return !!(filters.gem === true && img && img.complete && img.naturalWidth > 40 && hint && hint.textContent && price && price.textContent && price.textContent !== "—");
});

const phone = await page.evaluate(() => {
  const top = topCard();
  const card = top && top.card;
  const hint = top.querySelector(".gem-hint");
  const frame = hint.closest(".frame").getBoundingClientRect();
  const box = hint.getBoundingClientRect();
  const lead = document.getElementById("gemLead");
  const price = document.getElementById("capPrice").textContent;
  const text = document.body.innerText;
  return {
    id: card.id,
    name: card.name,
    hint: hint.textContent,
    why: card.gemWhy,
    price,
    lead: lead.textContent,
    leadHidden: lead.hidden,
    inside: box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
    offscreen: box.right > window.innerWidth + 1 || box.bottom > window.innerHeight + 1 || box.top < 0,
    nan: /NaN|\$0(?:\.00)?\b/.test(text),
    pocket: (gemCatalog || []).length
  };
});
console.log("phone card", JSON.stringify(phone));
note(phone.pocket >= 200, "browser pocket matches the saved lists", String(phone.pocket));
note(/holo|ultra|Prime|LV\.X|LEGEND|EX|Chrome/i.test(phone.hint), "card shows why it is a gem", phone.hint);
note(phone.inside && !phone.offscreen, "gem hint stays inside the card and the screen", JSON.stringify(phone));
note(phone.leadHidden === false && /fly under the radar/.test(phone.lead), "explanation is on the hunt", phone.lead);
note(!phone.nan && !/NaN/.test(phone.price) && !/^\$0(?:\.00)?$/.test(phone.price), "no NaN or $0 price", phone.price);
const broken = await page.evaluate(() => [...document.images].filter(img => img.complete && img.naturalWidth === 0).map(img => img.currentSrc || img.src));
note(!broken.length, "no broken images at 390x844", broken.slice(0, 4).join(" | "));
await page.screenshot({ path: shotDir + "/gemfinder-phone.png" });
console.log("screenshot", shotDir + "/gemfinder-phone.png");

const before = phone.id;
await page.mouse.move(200, 420);
const box = await page.locator("#deck .card").last().boundingBox();
note(!!box, "top card has a box for the mouse swipe");
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}
await page.waitForFunction(id => {
  const wish = JSON.parse(localStorage.getItem("binderhuntWish") || "[]");
  return wish.some(card => card.id === id);
}, before);
const wished = await page.evaluate(id => JSON.parse(localStorage.getItem("binderhuntWish") || "[]").some(card => card.id === id), before);
note(wished, "mouse swipe right saves to the master wishlist", before);
const afterSave = await page.evaluate(() => {
  const top = topCard();
  return top && top.card ? top.card.id : "";
});

await page.evaluate(() => {
  const el = topCard();
  const rect = el.getBoundingClientRect();
  const sx = rect.left + rect.width / 2;
  const sy = rect.top + rect.height / 2;
  const fire = (type, x) => {
    const target = type === "pointerdown" ? el : window;
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: sy,
      pointerId: 7, pointerType: "touch", isPrimary: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1
    }));
  };
  fire("pointerdown", sx);
  fire("pointermove", sx - 40);
  fire("pointermove", sx - 180);
  fire("pointerup", sx - 180);
});
await page.waitForFunction(id => {
  const top = topCard();
  return top && top.card && top.card.id !== id;
}, afterSave);
note(true, "touch swipe left passes to the next gem");

await page.setViewportSize({ width: 1440, height: 900 });
await sleep(400);
await page.waitForFunction(() => {
  const top = topCard();
  const note = document.querySelector("#profile .gem-note");
  const img = top && top.querySelector("img");
  return !!(note && note.textContent && img && img.complete && img.naturalWidth > 40);
});
const desk = await page.evaluate(() => {
  const note = document.querySelector("#profile .gem-note");
  const rect = note.getBoundingClientRect();
  const text = document.body.innerText;
  const top = topCard();
  return {
    id: top && top.card && top.card.id,
    why: note.textContent.replace(/\s+/g, " ").trim(),
    clipped: rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1 || rect.height < 8,
    nan: /NaN|\$0(?:\.00)?\b/.test(text)
  };
});
console.log("desktop", JSON.stringify(desk));
note(/Why it's a gem/.test(desk.why) && /Not a grade population/.test(desk.why), "desktop profile explains the gem", desk.why);
note(!desk.clipped, "desktop gem note is not clipped", JSON.stringify(desk));
note(!desk.nan, "no NaN or $0 on desktop");
const brokenWide = await page.evaluate(() => [...document.images].filter(img => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)).map(img => img.currentSrc || img.src));
note(!brokenWide.length, "no broken images at 1440x900", brokenWide.slice(0, 4).join(" | "));
await page.screenshot({ path: shotDir + "/gemfinder-desktop.png" });
console.log("screenshot", shotDir + "/gemfinder-desktop.png");
await page.setViewportSize({ width: 390, height: 844 });
await sleep(200);

await page.evaluate(() => {
  const cards = (gemCatalog || []).slice(0, 2);
  gemCycle = { cards: cards, cursor: 0, lap: 0 };
  pile = cards.slice();
  matched = cards.length;
  streamDone = false;
  paused = false;
  pumpError = "";
  deck.innerHTML = "";
  renderDeck();
});
let dry = false;
for (let n = 0; n < 4; n++) {
  const ready = await page.evaluate(() => {
    const top = topCard();
    return !!(top && top.card && !document.getElementById("skip").disabled);
  });
  if (!ready) { dry = true; break; }
  await page.locator("#skip").click();
  await page.waitForFunction(() => {
    const top = topCard();
    return !!(top && top.card);
  });
  const empty = await page.evaluate(() => !!document.querySelector("#deck .empty-state"));
  if (empty) dry = true;
}
note(!dry, "gem deck never runs dry while the pocket has cards");
await page.evaluate(async () => {
  const cards = (gemCatalog || []).slice(0, 2);
  gemCycle = { cards: cards, cursor: cards.length, lap: 0 };
  gemNote = "";
  pile = [cards[0]];
  matched = 1;
  streamDone = false;
  paused = false;
  pumpError = "";
  deck.innerHTML = "";
  renderDeck();
  await pumpGems(generation);
});
const wrapped = await page.evaluate(() => {
  const lead = (document.getElementById("gemLead") || {}).textContent || "";
  const count = (document.getElementById("matchCount") || {}).textContent || "";
  return {
    lead, count,
    card: !!(topCard() && topCard().card),
    empty: !!document.querySelector("#deck .empty-state")
  };
});
console.log("wrap", JSON.stringify(wrapped));
note(wrapped.card && !wrapped.empty, "a new lap still has a card on the table");
note(/shuffled back in/.test(wrapped.lead) || /shuffled back in/.test(wrapped.count), "a finished lap tells you the gems were shuffled back", wrapped.lead + " | " + wrapped.count);

await page.locator("#openFilters").click();
await page.waitForSelector("#gemSheetToggle");
const sheet = await page.evaluate(() => {
  const node = document.querySelector("#filter-gem .fine");
  const rect = node.getBoundingClientRect();
  return {
    text: node.textContent,
    visible: rect.height > 8 && rect.top >= 0 && rect.bottom <= window.innerHeight + 2
  };
});
note(/Not a grade-population report/.test(sheet.text) && /Aquapolis/.test(sheet.text) && /Call of Legends/.test(sheet.text) && /LV\.X/.test(sheet.text), "filter sheet explains the pocket honestly", sheet.text);
await page.screenshot({ path: shotDir + "/gemfinder-sheet-phone.png" });
console.log("screenshot", shotDir + "/gemfinder-sheet-phone.png");
await page.locator("#filterDone").click();

await page.keyboard.press("ArrowUp");
await page.waitForFunction(() => {
  const close = document.getElementById("closeProfile");
  if (!close || document.activeElement !== close) return false;
  window.__gemClose = close;
  return true;
});
await page.waitForFunction(() => {
  const old = window.__gemClose;
  if (!old || old.isConnected) return false;
  const note = document.querySelector("#profile .gem-note");
  return !!(document.activeElement && document.activeElement.id === "closeProfile" && note && /Why it's a gem/.test(note.textContent));
});
note(true, "Close stays focused after the gem profile hydrates");
await page.evaluate(() => closeProfile());

const typed = await page.evaluate(() => {
  filters.type = "Fire";
  const cards = gemsForHunt();
  const names = cards.map(row => row.name);
  return {
    count: cards.length,
    ninetales: cards.filter(row => row.name === "Ninetales").map(row => ({ id: row.id, types: row.types })),
    flareon: cards.filter(row => row.name === "Flareon").map(row => ({ id: row.id, types: row.types })),
    water: cards.filter(row => (row.types || []).includes("Water") && !(row.types || []).includes("Fire")).length,
    unknown: cards.filter(row => !(row.types || []).length).length,
    chase: cards.filter(row => /^(XY|SM|BW) ultra$/.test(row.gemHint)).length,
    hasNinetales: names.includes("Ninetales"),
    hasFlareon: names.includes("Flareon")
  };
});
console.log("fire filter", JSON.stringify(typed));
note(typed.hasNinetales && typed.ninetales.every(row => row.types.includes("Fire")), "Fire filter keeps Ninetales holos", JSON.stringify(typed.ninetales));
note(typed.hasFlareon && typed.flareon.every(row => row.types.includes("Fire")), "Fire filter keeps Flareon", JSON.stringify(typed.flareon));
note(typed.water === 0, "Fire filter hides gems whose stored type is not Fire", String(typed.water));
note(typed.unknown > 0, "Fire filter keeps gems with no stored type", String(typed.unknown));
note(typed.chase === 0 && typed.count > 2, "Fire filter is not just the two Charizard EX", String(typed.count));
await page.evaluate(() => restart());
await page.waitForFunction(() => {
  const top = topCard();
  const img = top && top.querySelector("img");
  return !!(filters.type === "Fire" && filters.gem && top && top.card && img && img.complete && img.naturalWidth > 40);
});
const fireTop = await page.evaluate(() => {
  const top = topCard();
  return { id: top.card.id, name: top.card.name, types: top.card.types || [], hint: top.card.gemHint };
});
console.log("fire top", JSON.stringify(fireTop));
note(!/^(XY|SM|BW) ultra$/.test(fireTop.hint), "the Fire deck deals a gem, not a dropped ultra", fireTop.hint);

const pageErrors = errors.filter(line => !/scrydex\.json/i.test(line));
note(!pageErrors.length, "no console errors", pageErrors.slice(0, 6).join(" | "));

if (problems.length) {
  console.error(problems.join("\n"));
  await shutdown(1);
}
console.log("gemfinder ok");
await shutdown(0);
