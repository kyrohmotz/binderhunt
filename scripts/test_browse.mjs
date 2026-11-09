// Pokémon and illustrator shelves use the saved price file only.
// Run: npx -y node@22 scripts/test_browse.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Browse = require(resolve(root, "js/browse.js"));
const Daily = require(resolve(root, "js/daily-core.js"));

const names = ["Charizard", "Charizard ex", "M Charizard EX", "Pikachu VMAX", "Dark Charizard", "Team Rocket's Meowth", "Umbreon VMAX", "Latias & Latios GX", "Mewtwo", "Mew"];
names.forEach(name => assert.equal(Browse.speciesName(name), Daily.speciesName(name), name));
assert.equal(Browse.pokemonSpecies("Professor Juniper"), "");
assert.equal(Browse.pokemonSpecies("Rainbow Energy"), "");
assert.equal(Browse.pokemonSpecies("Boss's Orders"), "");
assert.equal(Browse.pokemonSpecies("Charizard ex"), "Charizard");
assert.equal(Browse.speciesHit("Mewtwo", "Mew"), false);
assert.equal(Browse.speciesHit("Mew ex", "Mew"), true);
assert.equal(Browse.speciesHit("M Alakazam-EX", "Alakazam"), true);
assert.equal(Browse.speciesHit("Iono's Bellibolt", "Iono"), false);
assert.equal(Browse.artistAllowed("", "Mitsuhiro Arita"), false);
assert.equal(Browse.artistAllowed("Mitsuhiro Arita", ""), true);
assert.equal(Browse.artistAllowed("kagemaru himeno", "Kagemaru Himeno"), true);

const priced = Browse.latestPrice({
  history: [
    { d: "2026/10/01", v: "holofoil", m: 120 },
    { d: "2026/10/28", v: "holofoil", m: 0 },
    { d: "2026/10/28", v: "holofoil", m: NaN },
    { d: "2026/09/01", v: "1stEditionHolofoil", m: 400 }
  ]
});
assert.equal(priced, 120);
assert.equal(Browse.latestPrice({ history: [{ d: "2026/10/01", v: "a", m: 0 }, { d: "nope", v: "a", m: 5 }] }), null);
assert.equal(Browse.cardsForSpecies(Browse.buildIndex({ "x-1": { name: "Pikachu", history: [{ d: "2026/10/02", v: "normal", m: 0 }] } }), "Pikachu").length, 0);

const sample = Browse.buildIndex({
  "base1-4": { name: "Charizard", history: [{ d: "2026/10/01", v: "holofoil", m: 120 }, { d: "2026/10/28", v: "holofoil", m: NaN }] },
  "base1-58": { name: "Pikachu", history: [{ d: "2026/10/20", v: "normal", m: 12.5 }] },
  "base4-4": { name: "Pikachu", history: [{ d: "2026/10/20", v: "normal", m: 4 }] },
  "swsh1-1": { name: "Professor Juniper", history: [{ d: "2026/10/20", v: "normal", m: 3 }] }
});
assert.deepEqual(Browse.suggest(sample.speciesList.concat(["Pikachu", "Charmander", "Charizard"]), "char", 8), ["Charizard", "Charmander"]);
const pikas = Browse.cardsForSpecies(sample, "Pikachu");
assert.deepEqual(pikas.map(card => card.price), [12.5, 4]);
assert.equal(Browse.cardsForSpecies(sample, "Juniper").length, 0);
assert.equal(sample.artistList.length, 0);
assert.equal(Browse.noteArtist(sample, "base1-4", "Mitsuhiro Arita", { price: 1 }), true);
assert.equal(Browse.cardsForArtist(sample, "Mitsuhiro Arita").length, 1);
assert.equal(sample.coverage.withIllustrator, 0);
assert.equal(Browse.artFor("base1-4").thumb, "https://assets.tcgdex.net/en/base/base1/4/low.webp");
assert.equal(Browse.artFor("ecard3-H30").thumb, "https://images.pokemontcg.io/ecard3/H30.png");

const cache = JSON.parse(readFileSync(resolve(root, "data/scrydex.json"), "utf8"));
const index = Browse.buildIndex(cache.cards);
console.log("illustrator coverage", index.coverage);
assert.ok(index.coverage.cards >= 2000, "cached card count");
assert.ok(index.coverage.priced >= 1500, "priced card count");
assert.ok(index.coverage.withIllustrator / index.coverage.cards >= 0.5, "illustrator coverage " + index.coverage.withIllustrator + " of " + index.coverage.cards);
assert.ok(index.artistList.length > 0, "illustrator shelf has names");
const charizards = Browse.cardsForSpecies(index, "Charizard");
assert.ok(charizards.length >= 8, "charizard shelf " + charizards.length);
assert.ok(charizards.every(card => card.price > 0 && Number.isFinite(card.price)));
assert.ok(charizards.every((card, i) => i === 0 || charizards[i - 1].price >= card.price));
index.species.forEach(group => {
  group.cards.forEach(card => assert.ok(Browse.speciesHit(card.name, group.name), card.name + " / " + group.name));
});
assert.ok(Browse.cardsForArtist(index, "Mitsuhiro Arita").length > 0, "Arita cards are on the illustrator shelf");

const PORT = 8798;
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
  window.__bhFreezeBrowse = true;
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  const iso = bag.year + "-" + bag.month + "-" + bag.day;
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("binderhuntWish","[]");
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"off",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted:iso, days:{} }));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],artist:"",min:null,max:null,pricePreset:"",graded:false,gem:false}));
})();`;

const fixture = {
  "base1-4": { name: "Charizard", illustrator: "Mitsuhiro Arita", history: [{ d: "2026/10/01", v: "holofoil", m: 120 }, { d: "2026/10/28", v: "holofoil", m: 0 }, { d: "2026/10/28", v: "holofoil", m: NaN }, { d: "2026/09/01", v: "1stEditionHolofoil", m: 400 }] },
  "base1-58": { name: "Pikachu", illustrator: "Ken Sugimori", history: [{ d: "2026/10/20", v: "normal", m: 12.5 }] },
  "base4-4": { name: "Pikachu", illustrator: "Mitsuhiro Arita", history: [{ d: "2026/10/20", v: "normal", m: 4 }] },
  "base1-2": { name: "Blastoise", illustrator: "Mitsuhiro Arita", history: [{ d: "2026/10/20", v: "holofoil", m: 80 }] },
  "base1-15": { name: "Venusaur", illustrator: "Ken Sugimori", history: [{ d: "2026/10/20", v: "holofoil", m: 70 }] },
  "swsh1-1": { name: "Professor Juniper", history: [{ d: "2026/10/20", v: "normal", m: 3 }] },
  "base1-99": { name: "Pikachu", history: [{ d: "2026/10/20", v: "normal", m: 0 }] }
};

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true });
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", err => errors.push(String(err && err.message || err).split("\n")[0]));
page.on("console", msg => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  if (!text || /logo\.webp|symbol\.webp|Failed to load resource/i.test(text)) return;
  errors.push(text.split("\n")[0]);
});
page.on("request", req => {
  if (/scrydex\.com/i.test(req.url())) errors.push("unexpected Scrydex request " + req.url());
});
page.on("response", res => {
  if (res.status() !== 404) return;
  const url = res.url();
  if (/\/(logo|symbol)\.(webp|png)($|\?)/i.test(url)) return;
  errors.push("404 " + url);
});
await page.addInitScript(boot);
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.BinderBrowse && typeof meta !== "undefined" && meta.ready && meta.complete);

const problems = [];
function note(ok, name, extra) {
  if (!ok) problems.push(name + (extra ? " — " + extra : ""));
}

await page.evaluate(cards => {
  browseBuildStarted = true;
  browseIndex = BinderBrowse.buildIndex(cards);
  browseReady = true;
}, fixture);

const kept = await page.evaluate(() => {
  const card = {
    id: "base1-15",
    name: "Venusaur",
    setId: "base1",
    artist: "Ken Sugimori",
    img: "https://assets.tcgdex.net/en/base/base1/15/high.webp",
    thumb: "https://assets.tcgdex.net/en/base/base1/15/low.webp",
    variants: [{ market: 70 }]
  };
  filters.artist = "Ken Sugimori";
  const match = keep(card);
  const missing = keep(Object.assign({}, card, { artist: "" }));
  const other = keep(Object.assign({}, card, { artist: "Mitsuhiro Arita" }));
  filters.artist = "";
  const open = keep(card);
  filters.artist = "Ken Sugimori";
  saveFilters();
  const stored = JSON.parse(localStorage.getItem("bh.filters.v3") || "{}").artist;
  filters.artist = "";
  return { match, missing, other, open, stored };
});
note(kept.match === true && kept.missing === false && kept.other === false && kept.open === true, "artist filter keeps only cards that name that illustrator", JSON.stringify(kept));
note(kept.stored === "Ken Sugimori", "illustrator filter is stored", kept.stored);

async function edges() {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const tiles = [...document.querySelectorAll(".price-tile")].map(el => {
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right, price: (el.querySelector(".tile-price") || {}).textContent || "" };
    });
    const swipe = document.getElementById("browseSwipe");
    const back = document.getElementById("browseBack");
    const find = document.getElementById("browseFind");
    const box = el => el ? el.getBoundingClientRect() : null;
    return {
      vw,
      doc: document.documentElement.scrollWidth,
      tiles,
      swipe: box(swipe),
      back: box(back),
      find: box(find)
    };
  });
}
function inside(box, vw) {
  return !!box && box.left >= -1 && box.right <= vw + 1 && box.right - box.left > 20;
}

await page.locator(".tabs [data-tab='sets']").click();
await page.locator("#modePokemon").click();
await page.locator("#browseFind").fill("char");
await page.waitForSelector("#browseList [data-browse='Charizard']");
await page.locator("#browseFind").press("ArrowDown");
await page.locator("#browseFind").press("Enter");
await page.waitForSelector(".price-tile .tile-price");
let shelf = await page.evaluate(() => ({
  title: (document.getElementById("browseTitle") || {}).textContent || "",
  prices: [...document.querySelectorAll(".tile-price")].map(node => node.textContent),
  names: [...document.querySelectorAll(".tile-name")].map(node => node.textContent),
  few: (document.querySelector(".browse-note") || {}).textContent || "",
  widen: !!document.getElementById("browseWiden")
}));
note(shelf.title === "Charizard" && shelf.names.join("|") === "Charizard", "Charizard shelf lists that Pokémon", JSON.stringify(shelf));
note(shelf.prices.length === 1 && shelf.prices[0] === "$120.00", "price tile uses the latest positive market", JSON.stringify(shelf.prices));
note(!shelf.prices.some(text => /NaN|\$0(?:\.00)?\b/.test(text)), "no NaN or $0 on the shelf", JSON.stringify(shelf.prices));
note(/Only 1 priced card/.test(shelf.few) && shelf.widen, "a short shelf says so and offers to widen", shelf.few);
await page.waitForFunction(() => {
  const img = document.querySelector(".price-tile img");
  return img && img.complete && img.naturalWidth > 40;
});
note(true, "shelf art loaded");
let box = await edges();
note(box.doc <= box.vw + 1 && box.tiles.every(tile => tile.left >= -1 && tile.right <= box.vw + 1) && inside(box.swipe, box.vw) && inside(box.back, box.vw), "390 shelf stays inside the screen", JSON.stringify(box));

await page.locator("#browseSwipe").click();
await page.waitForFunction(() => document.getElementById("viewHunt") && !document.getElementById("viewHunt").hidden && filters.names[0] === "Charizard");
await page.waitForFunction(() => {
  const top = document.querySelector("#deck .card:last-child");
  return top && top.card && top.card.id === "base1-4";
}, null, { timeout: 15000 }).catch(() => {});
const deckCard = await page.evaluate(() => {
  const row = browseIndex && BinderBrowse.cardsForSpecies(browseIndex, "Charizard")[0];
  const built = row && cardFromBrowse(row);
  const top = document.querySelector("#deck .card:last-child");
  const img = top && top.querySelector("img");
  return {
    name: top && top.card && top.card.name,
    id: top && top.card && top.card.id,
    price: (document.getElementById("capPrice") || {}).textContent || "",
    art: !!(img && img.complete && img.naturalWidth > 40),
    keep: !!(built && keep(built)),
    ready: browseReady,
    freeze: !!window.__bhFreezeBrowse,
    coverage: browseIndex && browseIndex.coverage,
    source: top && top.card && top.card.source,
    variant: top && top.card && top.card.variants && top.card.variants[0],
    pile: pile.slice(0, 4).map(card => card.id)
  };
});
const cachedDeal = await page.evaluate(() => {
  const card = pile.find(item => item && item.id === "base1-4");
  const market = card && card.variants && card.variants[0] && card.variants[0].market;
  const node = [...document.querySelectorAll("#deck .card")].find(el => el.card && el.card.id === "base1-4");
  const img = node && node.querySelector("img");
  return { source: card && card.source, market, art: !!(img && img.complete && img.naturalWidth > 40) };
});
note(cachedDeal.source === "cache" && cachedDeal.market === 120 && cachedDeal.art, "cached Charizard is in the swipe deck at its saved price", JSON.stringify(cachedDeal) + " top " + JSON.stringify(deckCard));

const before = await page.evaluate(() => pile.length);
const handle = await page.locator("#deck .card").last().boundingBox();
note(!!handle, "deck card has a box");
if (handle) {
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 180, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(start => pile.length < start || wish.some(card => card.id === "base1-4"), before);
}
const afterMouse = await page.evaluate(() => ({ pile: pile.length, wish: wish.some(card => card.id === "base1-4") }));
note(afterMouse.wish || afterMouse.pile < before, "mouse swipe moves the card", JSON.stringify(afterMouse));

await page.evaluate(cards => {
  browseBuildStarted = true;
  browseIndex = BinderBrowse.buildIndex(cards);
  browseReady = true;
  filters = blankFilters();
  filters.names = ["Pikachu"];
  saveFilters();
  restart();
}, fixture);
const pikachuTop = await page.waitForFunction(() => {
  const top = document.querySelector("#deck .card:last-child");
  return top && top.card && top.card.name === "Pikachu";
}, null, { timeout: 8000 }).then(() => true).catch(async () => {
  const dump = await page.evaluate(() => ({
    names: filters.names.slice(),
    ready: browseReady,
    pile: pile.slice(0, 6).map(card => card.id + " " + card.name),
    top: (document.querySelector("#deck .card:last-child") || {}).className || "",
    status: document.getElementById("deck").dataset.status || "",
    text: (document.getElementById("deck").innerText || "").slice(0, 180)
  }));
  console.log("pikachu deck", JSON.stringify(dump));
  return false;
});
note(pikachuTop, "pikachu deck is showing");
if (!pikachuTop) {
  if (errors.length) problems.push("page errors: " + [...new Set(errors)].slice(0, 6).join(" | "));
  console.error(problems.join("\n"));
  await shutdown(1);
}
const touched = await page.evaluate(() => {
  const el = document.querySelector("#deck .card:last-child");
  if (!el || !el.card) return { ok: false };
  const rect = el.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  const start = rect.left + rect.width / 2;
  const pointer = (type, x, buttons) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true,
    clientX: x, clientY: y, button: 0, buttons: buttons
  }));
  const beforeId = el.card.id;
  const beforeUndo = undoStack.length;
  pointer("pointerdown", start, 1);
  pointer("pointermove", start - 160, 1);
  pointer("pointerup", start - 160, 0);
  return {
    ok: true,
    beforeId,
    name: el.card.name,
    undo: undoStack.length > beforeUndo,
    gone: el.classList.contains("leaving") || !pile.some(card => card.id === beforeId)
  };
});
note(touched.ok && touched.name === "Pikachu" && touched.undo && touched.gone, "touch swipe passes a card", JSON.stringify(touched));

await page.locator(".tabs [data-tab='sets']").click();
await page.locator("#modeArtists").click();
const coverage = await page.locator("#browseNote").innerText();
note(/names an illustrator on 5 of 7 cards/.test(coverage), "illustrator directory states coverage", coverage);
await page.locator("#browseFind").fill("ken");
await page.locator("#browseList [data-browse='Ken Sugimori']").click();
await page.waitForSelector(".price-tile");
const artistShelf = await page.evaluate(() => ({
  title: (document.getElementById("browseTitle") || {}).textContent || "",
  price: (document.querySelector(".tile-price") || {}).textContent || "",
  name: (document.querySelector(".tile-name") || {}).textContent || ""
}));
note(artistShelf.title === "Ken Sugimori" && artistShelf.name === "Venusaur" && artistShelf.price === "$70.00", "illustrator shelf is price first", JSON.stringify(artistShelf));
await page.locator(".price-tile").click();
await page.waitForSelector("#browseArtist");
const artistLabel = await page.locator("#browseArtist").innerText();
note(artistLabel === "Ken Sugimori", "profile shows the illustrator as a control", artistLabel);
await page.locator("#browseArtist").click();
await page.waitForFunction(() => (document.getElementById("browseTitle") || {}).textContent === "Ken Sugimori");
await page.locator("#browseBack").click();
await page.locator("#modePokemon").click();
await page.locator("#browseFind").fill("Pik");
await page.locator("#browseFind").press("ArrowDown");
await page.locator("#browseFind").press("Enter");
await page.waitForFunction(() => (document.getElementById("browseTitle") || {}).textContent === "Pikachu");
const pikaPrices = await page.locator(".tile-price").allInnerTexts();
note(pikaPrices.length === 2 && pikaPrices[0] === "$12.50" && pikaPrices[1] === "$4.00", "Pikachu prices sort high to low and skip the zero", JSON.stringify(pikaPrices));

await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForFunction(() => document.getElementById("browseTitle") && document.getElementById("browseTitle").textContent === "Pikachu");
box = await edges();
note(box.doc <= box.vw + 1 && box.tiles.length === 2 && box.tiles.every(tile => tile.left >= -1 && tile.right <= box.vw + 1) && inside(box.back, box.vw) && inside(box.swipe, box.vw), "1440 shelf stays inside the screen", JSON.stringify(box));
await page.evaluate(() => { if (wide()) paintSide(); });
const side = await page.locator("#profile [data-side='browse'] #profileTitle").innerText();
note(side === "Pikachu", "desktop side panel names the shelf", side);

if (errors.length) problems.push("page errors: " + [...new Set(errors)].slice(0, 6).join(" | "));
if (problems.length) {
  console.error(problems.join("\n"));
  await shutdown(1);
}
console.log("browse filters ok", index.coverage);
await shutdown(0);
