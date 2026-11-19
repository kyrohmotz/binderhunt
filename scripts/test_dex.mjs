// Pokédex completion counts species that have a card in the saved catalog.
// National numbers come from data/dex.json. No Scrydex calls.
// Run: npx -y node@22 scripts/test_dex.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Dex = require(resolve(root, "js/dex.js"));
const Browse = require(resolve(root, "js/browse.js"));

const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
const dexJs = readFileSync(resolve(root, "js/dex.js"), "utf8");
const dexUi = readFileSync(resolve(root, "js/dex-ui.js"), "utf8");
assert.match(sw, /const VERSION = "bh-19"/);
for (const file of ["js/dex.js", "js/dex-ui.js", "css/dex.css", "data/dex.json"]) {
  assert.match(sw, new RegExp(file.replace(/[.]/g, "\\.")), file);
}
assert.equal(html.includes("js/dex.js"), false, "dex script stays out of the first paint");
assert.match(html, /data-tab="dex"/);
assert.match(html, /id="viewDex"/);
assert.match(app, /bh\.dex\.v1|BinderDex/);
assert.doesNotMatch(dexJs + dexUi, /scrydex\.com/i);
assert.doesNotMatch(readFileSync(resolve(root, "css/dex.css"), "utf8"), /scrydex\.com/i);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

const table = Dex.loadTable(JSON.parse(readFileSync(resolve(root, "data/dex.json"), "utf8")));
assert.equal(table.length, 1025);
assert.equal(table[0].name, "Bulbasaur");
assert.equal(table[0].dex, 1);
assert.equal(table[0].gen, 1);
assert.equal(table[24].name, "Pikachu");
assert.equal(table[24].dex, 25);
assert.equal(table[121].name, "Mr. Mime");
assert.equal(table[150].name, "Mew");
assert.equal(table[150].gen, 1);
assert.equal(table[151].name, "Chikorita");
assert.equal(table[151].gen, 2);
assert.equal(table[1024].name, "Pecharunt");
assert.equal(table[1024].dex, 1025);
assert.equal(table[1024].gen, 9);

assert.equal(Dex.phraseHit("Mewtwo", "Mew"), false);
assert.equal(Dex.phraseHit("Mew ex", "Mew"), true);
assert.equal(Dex.phraseHit("Mr. Mime", "Mr. Mime"), true);
assert.equal(Dex.phraseHit("Raging Bolt ex", "Raging Bolt"), true);
assert.equal(Dex.cellLabel({ name: "Bulbasaur", dex: 1, status: "owned" }), "Bulbasaur #001, owned");
assert.equal(Dex.cellLabel({ name: "Ivysaur", dex: 2, status: "wish" }), "Ivysaur #002, wishlisted");
assert.equal(Dex.cellLabel({ name: "Venusaur", dex: 3, status: "missing" }), "Venusaur #003, missing");
assert.equal(Dex.countLabel(1, 0, 100), "Gen 1: 0/100");
assert.equal(Dex.pctOf(0, 100), 0);
assert.equal(Dex.pctOf(1, 0), 0);
assert.equal(Dex.pctOf(NaN, 10), 0);
assert.deepEqual(Dex.marksReached(0, 4), []);
assert.deepEqual(Dex.marksReached(1, 0), []);
assert.deepEqual(Dex.marksReached(1, 4), [25]);
assert.deepEqual(Dex.marksReached(1, 3), [25]);
assert.deepEqual(Dex.marksReached(2, 4), [25, 50]);
assert.deepEqual(Dex.marksReached(3, 4), [25, 50, 75]);
assert.deepEqual(Dex.marksReached(4, 4), [25, 50, 75, 100]);

const fixture = {
  "base1-1": { name: "Alakazam" },
  "base1-4": { name: "Charizard" },
  "base1-4b": { name: "Charizard ex" },
  "base2-6": { name: "Mr. Mime" },
  "sv-bolt": { name: "Raging Bolt ex" },
  "mew": { name: "Mew ex" },
  "mewtwo": { name: "Mewtwo" },
  "bulb": { name: "Bulbasaur" },
  "train": { name: "Professor Juniper" },
  "ace": { name: "Acerola" },
  "gone": { name: "Pikachu", missing: true },
  "blank": { name: "" }
};
const built = Dex.buildSpecies(fixture, table, Browse.pokemonSpecies, id => ({ thumb: "https://assets.tcgdex.net/en/base/base1/4/low.webp", img: "" }));
const names = built.species.map(entry => entry.name).sort();
assert.deepEqual(names, ["Alakazam", "Bulbasaur", "Charizard", "Mew", "Mewtwo", "Mr. Mime", "Raging Bolt"]);
const zard = built.species.find(entry => entry.name === "Charizard");
assert.equal(zard.dex, 6);
assert.equal(zard.browseName, "Charizard");
assert.deepEqual(zard.ids, ["base1-4", "base1-4b"]);
const mime = built.species.find(entry => entry.name === "Mr. Mime");
assert.equal(mime.dex, 122);
assert.equal(mime.browseName, "Mime");
assert.equal(mime.gen, 1);
const bolt = built.species.find(entry => entry.name === "Raging Bolt");
assert.equal(bolt.dex, 1021);
assert.equal(bolt.browseName, "Bolt");
assert.equal(bolt.gen, 9);
assert.ok(!built.species.some(entry => entry.ids.includes("gone")));
assert.ok(built.unmatched.includes("Acerola"));

const model = Dex.collection(built.species, ["base1-4", "base1-4"], ["base2-6", "base1-4", "not-a-card"]);
assert.equal(model.species.find(entry => entry.name === "Charizard").status, "owned");
assert.equal(model.species.find(entry => entry.name === "Mr. Mime").status, "wish");
assert.equal(model.species.find(entry => entry.name === "Bulbasaur").status, "missing");
assert.equal(model.overall.owned, 1);
assert.equal(model.overall.wish, 1);
assert.equal(model.overall.total, 7);
assert.equal(model.overall.missing, 5);
assert.equal(model.overall.owned + model.overall.wish + model.overall.missing, model.overall.total);
const gen1 = model.generations.find(gen => gen.id === 1);
assert.equal(gen1.owned, 1);
assert.equal(gen1.wish, 1);
assert.equal(gen1.total, 6);
assert.equal(gen1.missing, 4);
assert.equal(gen1.owned + gen1.wish + gen1.missing, gen1.total);
assert.equal(Number.isFinite(gen1.pct), true);
assert.equal(JSON.stringify(model).includes("NaN"), false);
assert.equal(Dex.countLabel(1, gen1.owned, gen1.total), "Gen 1: 1/6");
assert.deepEqual(Dex.visibleSpecies(model, "owned", "").map(entry => entry.name), ["Charizard"]);
assert.deepEqual(Dex.visibleSpecies(model, "wish", "").map(entry => entry.name), ["Mr. Mime"]);
assert.equal(Dex.visibleSpecies(model, "missing", "").some(entry => entry.name === "Charizard"), false);
assert.deepEqual(Dex.visibleSpecies(model, "all", "mime").map(entry => entry.name), ["Mr. Mime"]);
assert.deepEqual(Dex.visibleSpecies(model, "all", "bolt").map(entry => entry.name), ["Raging Bolt"]);
assert.deepEqual(Dex.visibleSpecies(model, "all", "#006").map(entry => entry.name), ["Charizard"]);
assert.equal(Dex.visibleSpecies(model, "owned", "mew").length, 0);

const fresh = Dex.pendingMilestones([{ id: 1, name: "Kanto", owned: 2, total: 4 }], new Set());
assert.equal(fresh.length, 1);
assert.equal(fresh[0].milestone, 50);
assert.deepEqual(fresh[0].marks, [25, 50]);
assert.equal(Dex.celebrateCopy(fresh), "Gen 1 is halfway there.");
const again = Dex.pendingMilestones([{ id: 1, name: "Kanto", owned: 2, total: 4 }], new Set(["1:25", "1:50"]));
assert.equal(again.length, 0);
assert.equal(Dex.celebrateCopy(again), "");
const done = Dex.pendingMilestones([{ id: 9, name: "Paldea", owned: 1, total: 1 }], new Set());
assert.equal(done[0].milestone, 100);
assert.equal(Dex.celebrateCopy(done), "Gen 9 is complete.");
assert.equal(Dex.celebrateCopy(fresh.concat(done)), "Gen 9 is complete. 2 generations reached a new mark.");
const stored = Dex.payload(new Set(["9:100", "1:50", "1:25", "nope"]));
assert.deepEqual(stored, { v: 1, seen: ["1:25", "1:50", "9:100"] });
assert.equal(stored.ids, undefined);
const seen = Dex.readSeen({ v: 1, seen: ["nope", "1:25", 4, "2:10"], ids: ["base1-4"] });
assert.deepEqual([...seen], ["1:25"]);
const empty = Dex.collection([], [], []);
assert.equal(empty.overall.total, 0);
assert.equal(empty.overall.pct, 0);
assert.equal(empty.generations.length, 0);
assert.equal(JSON.stringify(empty).includes("NaN"), false);

const cache = JSON.parse(readFileSync(resolve(root, "data/scrydex.json"), "utf8"));
const catalog = Dex.buildSpecies(cache.cards, table, Browse.pokemonSpecies, Browse.artFor);
const catalogModel = Dex.collection(catalog.species, [], []);
const dexNames = new Set(table.map(entry => Dex.fold(entry.name)));
const leaked = catalog.unmatched.filter(name => dexNames.has(Dex.fold(name)));
assert.deepEqual(leaked, []);
assert.equal(catalog.species.length, 366, "species with a catalog card");
assert.ok(catalog.species.every(entry => entry.ids.length >= 1 && entry.dex >= 1 && entry.gen >= 1 && entry.gen <= 9));
assert.ok(catalog.species.every(entry => !entry.art || /^https:\/\/(?:assets\.tcgdex\.net|images\.pokemontcg\.io)\//.test(entry.art)));
assert.equal(catalog.species.find(entry => entry.name === "Charizard").dex, 6);
assert.equal(catalog.species.find(entry => entry.name === "Pikachu").dex, 25);
assert.equal(catalog.species.find(entry => entry.name === "Mr. Mime").browseName, "Mime");
assert.equal(catalog.species.find(entry => entry.name === "Raging Bolt").browseName, "Bolt");
assert.equal(catalog.species.find(entry => entry.name === "Farfetch'd").dex, 83);
assert.equal(catalog.species.find(entry => entry.name === "Porygon-Z").dex, 474);
assert.equal(catalog.species.find(entry => entry.name === "Ho-Oh").dex, 250);
assert.equal(catalogModel.generations.reduce((sum, gen) => sum + gen.total, 0), 366);
assert.deepEqual(catalogModel.generations.map(gen => [gen.id, gen.total]), [
  [1, 100], [2, 65], [3, 70], [4, 43], [5, 28], [6, 12], [7, 16], [8, 7], [9, 25]
]);
assert.equal(catalogModel.generations.find(gen => gen.id === 1).total, 100);

const fixed = [
  ["neo4-8", "Dark Porygon2", "Porygon2", 233],
  ["dp6-1", "Deoxys Normal Forme", "Deoxys", 386],
  ["pl3-2", "Blaziken FB", "Blaziken", 257],
  ["pl3-142", "Blaziken FB LV.X", "Blaziken", 257],
  ["pl3-144", "Electivire FB LV.X", "Electivire", 466],
  ["pl3-147", "Staraptor FB LV.X", "Staraptor", 398],
  ["pl2-8", "Lucario GL", "Lucario", 448],
  ["pl2-104", "Floatzel GL LV.X", "Floatzel", 419],
  ["pl2-109", "Luxray GL LV.X", "Luxray", 405],
  ["pl2-110", "Mismagius GL LV.X", "Mismagius", 429]
];
fixed.forEach(([id, name, species, dex]) => {
  assert.equal(Browse.pokemonSpecies(name), species, name);
  const row = catalog.species.find(entry => entry.ids.includes(id));
  assert.ok(row, id + " is on the board");
  assert.equal(row.name, species, id);
  assert.equal(row.dex, dex, id);
});
assert.equal(Browse.pokemonSpecies("Rayquaza C"), "Rayquaza");
assert.equal(Browse.pokemonSpecies("Rayquaza C LV.X"), "Rayquaza");
assert.equal(Browse.pokemonSpecies("Absol G"), "Absol");
assert.equal(Browse.pokemonSpecies("Charizard G LV.X"), "Charizard");
assert.equal(Browse.pokemonSpecies("Alakazam E4 LV.X"), "Alakazam");
assert.equal(Browse.pokemonSpecies("Infernape 4"), "Infernape");
assert.equal(Browse.pokemonSpecies("Mewtwo LV.X"), "Mewtwo");
assert.equal(Browse.pokemonSpecies("Garchomp LVX"), "Garchomp");
assert.equal(Browse.pokemonSpecies("Mr. Mime"), "Mime");
assert.equal(Browse.pokemonSpecies("Farfetch'd"), "Farfetch'd");
assert.equal(Browse.pokemonSpecies("Raging Bolt ex"), "Bolt");
assert.equal(Browse.pokemonSpecies("Porygon-Z"), "Porygon-Z");
assert.equal(Browse.pokemonSpecies("Ho-Oh"), "Ho-Oh");
assert.equal(Browse.pokemonSpecies("Dark Charizard"), "Charizard");
assert.equal(Browse.pokemonSpecies("Light Arcanine"), "Arcanine");
assert.equal(Browse.pokemonSpecies("Team Rocket's Meowth"), "Meowth");
assert.equal(Browse.pokemonSpecies("Alolan Vulpix"), "Vulpix");
assert.equal(Browse.pokemonSpecies("Galarian Mr. Mime"), "Mime");
assert.equal(Browse.pokemonSpecies("Origin Forme Dialga V"), "Dialga");
assert.equal(Browse.pokemonSpecies("Origin Forme Palkia V"), "Palkia");
assert.equal(Browse.pokemonSpecies("Porygon2"), "Porygon2");
assert.equal(Browse.pokemonSpecies("Charizard ex"), "Charizard");
assert.equal(Browse.pokemonSpecies("Charizard VMAX"), "Charizard");
assert.equal(Browse.pokemonSpecies("Charizard-GX"), "Charizard");

const browseIndex = Browse.buildIndex(cache.cards);
fixed.forEach(([id, name, species]) => {
  assert.ok(Browse.cardsForSpecies(browseIndex, species).some(card => card.id === id), name + " is on the " + species + " shelf");
});

const unmapped = [];
Object.keys(cache.cards).forEach(id => {
  const rec = cache.cards[id];
  if (!rec || rec.missing || typeof rec.name !== "string") return;
  const rows = Array.isArray(rec.history) ? rec.history : [];
  const priced = rows.some(row => row && Number(row.m) > 0 && /\d{4}/.test(String(row.d || "")));
  if (!priced) return;
  const name = rec.name.replace(/\s+/g, " ").trim();
  if (/\b(?:energy|professor|boss'?s orders)\b/i.test(name)) return;
  const hits = table.filter(entry => Dex.phraseHit(name, entry.name));
  if (!hits.length) return;
  if (!catalog.species.some(entry => entry.ids.includes(id))) unmapped.push(id + " " + name);
});
assert.deepEqual(unmapped, []);
assert.equal(catalogModel.overall.owned, 0);
assert.equal(catalogModel.overall.pct, 0);
assert.equal(JSON.stringify(catalogModel).includes("NaN"), false);
console.log("dex math ok", {
  species: catalog.species.length,
  unmatched: catalog.unmatched.length,
  generations: catalogModel.generations.map(gen => gen.id + ":" + gen.total).join(" ")
});

const PORT = 8826;
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
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("binderhuntWish", "[]");
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
  localStorage.removeItem("bh.dex.v1");
})();`;

function watch(page) {
  page.on("pageerror", err => consoleErrors.push("pageerror: " + String(err && err.message || err).split("\n")[0]));
  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!text || /Failed to load resource|logo\.webp|symbol\.webp/i.test(text)) return;
    consoleErrors.push(text.split("\n")[0]);
  });
  page.on("request", req => {
    if (/api\.scrydex\.com|scrydex\.com\/v/i.test(req.url())) consoleErrors.push("unexpected Scrydex request " + req.url());
  });
}

async function shot(page, name) {
  const file = "/opt/cursor/artifacts/" + name + ".png";
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

async function settleImages(page) {
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll("#dexScroll img")].filter(img => {
      const box = img.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight && box.width > 2;
    });
    return imgs.length > 0 && imgs.every(img => img.complete);
  }, { timeout: 15000 }).catch(() => {});
  await sleep(200);
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
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof scrydex !== "undefined" && scrydex.ready && document.querySelector("#deck .card img"));
const beforeKeys = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  dex: localStorage.getItem("bh.dex.v1")
}));

await page.locator(".tabs [data-tab=dex]").click();
await page.waitForFunction(() => {
  const node = document.querySelector(".dex-caught");
  return node && /^Caught 0 of \d+$/.test(node.textContent.trim());
});
const emptyView = await page.evaluate(() => {
  const root = document.getElementById("dexScroll");
  const text = root.innerText;
  const tabs = [...document.querySelectorAll(".tabs .tabbtn")].map(el => ({
    text: el.textContent.replace(/\s+/g, " ").trim(),
    clipped: el.scrollWidth > el.clientWidth + 1,
    box: el.getBoundingClientRect()
  }));
  const off = [...root.querySelectorAll("h2, h3, .dex-caught, .dex-count, .dex-genchip, .dex-cell, .chip, input")].filter(el => {
    const box = el.getBoundingClientRect();
    return box.width > 2 && box.height > 2 && box.top < window.innerHeight && box.bottom > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
  }).map(el => el.textContent.replace(/\s+/g, " ").trim().slice(0, 40));
  const broken = [...root.querySelectorAll("img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.src);
  const clippedNames = [...root.querySelectorAll(".dex-name")].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent);
  const bulb = document.querySelector(".dex-cell");
  return {
    text: text.slice(0, 400),
    caught: document.querySelector(".dex-caught").textContent.trim(),
    label: bulb ? bulb.getAttribute("aria-label") : "",
    tabs,
    off,
    broken,
    clippedNames,
    scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    context: document.getElementById("context").textContent,
    contextClipped: document.getElementById("context").scrollWidth > document.getElementById("context").clientWidth + 1,
    current: document.querySelector('.tabs [data-tab="dex"]').getAttribute("aria-current")
  };
});
note(emptyView.current === "page", "Dex tab is current");
note(emptyView.caught === "Caught 0 of 366", "empty board counts catalog species", emptyView.caught);
note(emptyView.text.includes("Gen 1: 0/100"), "gen 1 progress uses catalog species", emptyView.text);
note(emptyView.label === "Bulbasaur #001, missing", "first cell is labelled", emptyView.label);
note(!emptyView.text.includes("NaN") && !emptyView.text.includes("$0"), "no NaN or $0 on the empty board");
note(!emptyView.tabs.some(tab => tab.clipped), "tab labels are not clipped", JSON.stringify(emptyView.tabs));
note(emptyView.tabs.every(tab => tab.box.right <= 391 && tab.box.left >= -1), "tabs stay inside 390px", JSON.stringify(emptyView.tabs.map(tab => tab.text + ":" + Math.round(tab.box.right))));
note(!emptyView.contextClipped && emptyView.context === "Pokédex", "context label fits", emptyView.context);
note(!emptyView.off.length, "nothing is clipped at 390x844", emptyView.off.join(" | "));
note(emptyView.scroll, "page does not scroll sideways");
note(!emptyView.broken.length, "no broken images on the empty board", emptyView.broken.slice(0, 4).join(" | "));
note(!emptyView.clippedNames.length, "Pokémon names are fully visible", emptyView.clippedNames.slice(0, 8).join(", "));
await settleImages(page);
const emptyAxe = await axe(page, "dex-empty-390");
note(!emptyAxe.length, "0 axe violations on the empty Pokédex at 390", emptyAxe.join(" || "));
await shot(page, "dex_empty_390x844");

await page.setViewportSize({ width: 1440, height: 900 });
await page.locator(".rail [data-tab=dex]").click();
await page.waitForSelector("[data-side='dex']");
await sleep(200);
const wideEmpty = await page.evaluate(() => {
  const side = document.querySelector("[data-side='dex']");
  const off = [...document.querySelectorAll("#dexScroll h2, #dexScroll h3, #dexScroll .dex-caught, #dexScroll .dex-cell, .rail .tabbtn, #context, [data-side='dex'] h2")].filter(el => {
    const box = el.getBoundingClientRect();
    if (!(box.width > 2 && box.height > 2 && box.bottom > 0 && box.top < window.innerHeight)) return false;
    return box.left < -1 || box.right > window.innerWidth + 1;
  }).map(el => el.textContent.replace(/\s+/g, " ").trim().slice(0, 48));
  const rail = [...document.querySelectorAll(".rail .tabbtn")].map(el => ({
    text: el.textContent.replace(/\s+/g, " ").trim(),
    clipped: el.scrollWidth > el.clientWidth + 1
  }));
  return {
    side: side ? side.innerText.slice(0, 240) : "",
    off,
    rail,
    wide: matchMedia("(min-width: 1024px)").matches
  };
});
note(wideEmpty.wide && /Caught 0 of 366/.test(wideEmpty.side), "desktop side panel shows the empty total", wideEmpty.side);
note(!wideEmpty.rail.some(tab => tab.clipped), "rail labels are not clipped", JSON.stringify(wideEmpty.rail));
note(!wideEmpty.off.length, "nothing is clipped at 1440x900 empty", wideEmpty.off.join(" | "));
const wideEmptyAxe = await axe(page, "dex-empty-1440");
note(!wideEmptyAxe.length, "0 axe violations on the empty Pokédex at 1440", wideEmptyAxe.join(" || "));
await shot(page, "dex_empty_1440x900");

await page.evaluate(() => {
  ownedIds.clear();
  ["base1-15", "base1-4", "base1-2", "bw1-115"].forEach(id => ownedIds.add(id));
  wish.length = 0;
  wish.push(
    { id: "sv03.5-167", name: "Ivysaur" },
    { id: "ex3-98", name: "Charmander" },
    { id: "base3-20", name: "Gengar" }
  );
  saveOwned();
  saveWish();
});
await page.waitForFunction(() => {
  const node = document.querySelector(".dex-caught");
  return node && node.textContent.includes("Caught 4 of 366");
});
await settleImages(page);
const seededWide = await page.evaluate(() => {
  const text = document.getElementById("dexScroll").innerText;
  const side = document.querySelector("[data-side='dex']");
  const cells = [...document.querySelectorAll(".dex-cell")].slice(0, 4).map(el => ({
    label: el.getAttribute("aria-label"),
    state: el.classList.contains("owned") ? "owned" : el.classList.contains("wish") ? "wish" : el.classList.contains("missing") ? "missing" : ""
  }));
  const off = [...document.querySelectorAll("#dexScroll h2, #dexScroll .dex-caught, #dexScroll .dex-cell, .rail .tabbtn, [data-side='dex'] h2")].filter(el => {
    const box = el.getBoundingClientRect();
    if (!(box.width > 2 && box.height > 2 && box.bottom > 0 && box.top < window.innerHeight)) return false;
    return box.left < -1 || box.right > window.innerWidth + 1;
  }).map(el => el.textContent.replace(/\s+/g, " ").trim().slice(0, 40));
  return { text: text.slice(0, 500), side: side ? side.innerText.slice(0, 200) : "", cells, off };
});
note(seededWide.cells[0] && seededWide.cells[0].label === "Bulbasaur #001, missing" && seededWide.cells[0].state === "missing", "Bulbasaur stays grey", JSON.stringify(seededWide.cells[0]));
note(seededWide.cells[1] && seededWide.cells[1].label === "Ivysaur #002, wishlisted" && seededWide.cells[1].state === "wish", "Ivysaur is wishlisted", JSON.stringify(seededWide.cells[1]));
note(seededWide.cells[2] && seededWide.cells[2].label === "Venusaur #003, owned" && seededWide.cells[2].state === "owned", "Venusaur is owned", JSON.stringify(seededWide.cells[2]));
note(/3 wishlisted/.test(seededWide.text), "wishlisted count is on the board", seededWide.text.slice(0, 180));
note(/Caught 4 of 366/.test(seededWide.side), "desktop side panel updates after seeding", seededWide.side);
note(!seededWide.text.includes("NaN") && !seededWide.text.includes("$0"), "no NaN or $0 after seeding");
note(!seededWide.off.length, "nothing is clipped at 1440x900 seeded", seededWide.off.join(" | "));
const seededWideAxe = await axe(page, "dex-seeded-1440");
note(!seededWideAxe.length, "0 axe violations on the seeded Pokédex at 1440", seededWideAxe.join(" || "));
await shot(page, "dex_seeded_1440x900");

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => { document.getElementById("dexScroll").scrollTop = 0; });
await settleImages(page);
const seeded = await page.evaluate(() => {
  const root = document.getElementById("dexScroll");
  const off = [...root.querySelectorAll("h2, h3, .dex-caught, .dex-count, .dex-genchip, .dex-cell, .chip, input")].filter(el => {
    const box = el.getBoundingClientRect();
    return box.width > 2 && box.height > 2 && box.top < window.innerHeight && box.bottom > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
  }).map(el => el.textContent.replace(/\s+/g, " ").trim().slice(0, 40));
  const broken = [...root.querySelectorAll("img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.currentSrc || img.src);
  const clippedNames = [...root.querySelectorAll(".dex-name")].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent);
  return {
    off,
    broken,
    clippedNames,
    scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  };
});
note(!seeded.off.length, "nothing is clipped at 390x844 seeded", seeded.off.join(" | "));
note(!seeded.clippedNames.length, "seeded names are fully visible", seeded.clippedNames.slice(0, 8).join(", "));
note(seeded.scroll, "seeded page does not scroll sideways");
note(!seeded.broken.length, "no broken images on the seeded board", seeded.broken.slice(0, 4).join(" | "));
const seededAxe = await axe(page, "dex-seeded-390");
note(!seededAxe.length, "0 axe violations on the seeded Pokédex at 390", seededAxe.join(" || "));
await shot(page, "dex_seeded_390x844");

await page.locator(".dex-filters [data-dex-filter=owned]").click();
await page.waitForFunction(() => {
  const node = document.getElementById("dexShowing");
  return node && node.textContent.includes("Showing 4");
});
const ownedOnly = await page.evaluate(() => ({
  showing: document.getElementById("dexShowing").textContent,
  names: [...document.querySelectorAll(".dex-name")].map(el => el.textContent.trim()),
  caught: document.querySelector(".dex-caught").textContent.trim()
}));
note(ownedOnly.showing.includes("Showing 4") && ownedOnly.names.some(name => name.startsWith("Venusaur")) && !ownedOnly.names.some(name => name.startsWith("Bulbasaur")) && !ownedOnly.names.some(name => name.startsWith("Ivysaur")), "owned filter keeps caught Pokémon", ownedOnly.names.join(", "));
note(ownedOnly.caught === "Caught 4 of 366", "filter does not change the caught total", ownedOnly.caught);

await page.locator(".dex-filters [data-dex-filter=wish]").click();
await page.waitForFunction(() => {
  const node = document.getElementById("dexShowing");
  return node && node.textContent.includes("Showing 3");
});
const wished = await page.evaluate(() => [...document.querySelectorAll(".dex-cell")].map(el => el.getAttribute("aria-label")));
note(wished.includes("Ivysaur #002, wishlisted") && wished.includes("Gengar #094, wishlisted") && !wished.some(label => /, owned$/.test(label)), "wishlist filter is the rose cells", wished.join(" | "));

await page.locator("#dexFind").fill("char");
await page.waitForFunction(() => {
  const labels = [...document.querySelectorAll(".dex-cell")].map(el => el.getAttribute("aria-label") || "");
  return labels.length === 1 && labels[0].indexOf("Charmander") === 0;
});
const found = await page.evaluate(() => [...document.querySelectorAll(".dex-cell")].map(el => el.getAttribute("aria-label")));
note(found.some(label => label.startsWith("Charmander")) && found.every(label => /char/i.test(label)), "search stays inside the wishlist filter", found.join(" | "));

await page.locator(".dex-filters [data-dex-filter=all]").click();
await page.locator("#dexFind").fill("");
await page.waitForFunction(() => {
  const first = document.querySelector(".dex-cell");
  return first && first.getAttribute("aria-label") === "Bulbasaur #001, missing";
});
await page.locator(".dex-cell").first().focus();
await page.keyboard.press("ArrowRight");
const moved = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label"));
note(moved === "Ivysaur #002, wishlisted", "arrow key moves to the next Pokémon", moved);

await page.locator(".dex-cell", { hasText: "Ivysaur" }).first().click();
await page.waitForSelector("#browseTitle");
const browse = await page.evaluate(() => ({
  title: document.getElementById("browseTitle") ? document.getElementById("browseTitle").textContent : "",
  tab: document.querySelector('.tabs [data-tab="sets"]').getAttribute("aria-current"),
  dexHidden: document.getElementById("viewDex").hidden
}));
note(browse.title === "Ivysaur" && browse.tab === "page" && browse.dexHidden, "tapping a species opens its browse shelf", JSON.stringify(browse));

const keys = await page.evaluate(() => ({
  wish: localStorage.getItem("binderhuntWish"),
  binders: localStorage.getItem("bh.binders.v1"),
  owned: localStorage.getItem("bh.owned.v1"),
  filters: localStorage.getItem("bh.filters.v3"),
  dex: localStorage.getItem("bh.dex.v1")
}));
note(keys.binders === beforeKeys.binders, "bh.binders.v1 was not rewritten");
note(keys.filters === beforeKeys.filters, "bh.filters.v3 was not rewritten");
note(keys.dex == null, "no milestone key is written below 25%", keys.dex);
const ownedStored = JSON.parse(keys.owned);
const wishStored = JSON.parse(keys.wish);
note(ownedStored && ownedStored.v === 1 && Array.isArray(ownedStored.ids) && ownedStored.ids.includes("base1-4"), "owned key keeps its shape", keys.owned.slice(0, 180));
note(Array.isArray(wishStored) && wishStored.some(card => card.id === "sv03.5-167"), "wishlist key keeps its shape");
note(!consoleErrors.length, "no console errors on the Pokédex", consoleErrors.slice(0, 8).join(" | "));

if (problems.length) {
  console.log("FAILED", problems.length);
  problems.forEach(line => console.log(" -", line));
  await shutdown(1);
}
console.log("dex view ok");
await shutdown(0);
