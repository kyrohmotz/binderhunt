// Regression checks for the daily and price polish:
// 1. Guess errors follow the current field. "0" and "0.00" keep
//    "Enter a price above zero." "-" and "nope" keep "That isn't a price."
//    ".5" parses as 0.50 and clears the error. An emptied field clears it.
//    Checked at 390x844 and 1440x900.
// 2. Morpeko V-UNION (and the other V-UNION names) resolve to the Pokémon,
//    the same way BREAK and the other suffixes already do.
// 3. The Daily streak stays put while the price line still says sealed, then
//    updates after the 720ms reveal. Same hold at 390x844 and 1440x900.
// 4. Hisuian Zoroark shows its TCGplayer market. That price is on the printing,
//    not the card record. A card with no market still shows the same em dash
//    as any other unpriced card.
// No Scrydex requests. Run: npx -y node@22 scripts/test_polish.mjs
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8796;
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
const imageErrors = [];
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
  const prev = new Date(Date.UTC(+bag.year, +bag.month - 1, +bag.day) - 86400000);
  const y = prev.getUTCFullYear() + "-" + String(prev.getUTCMonth() + 1).padStart(2, "0") + "-" + String(prev.getUTCDate()).padStart(2, "0");
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
  localStorage.setItem("binderhuntWish","[]");
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"off",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:4, best:4, lastPlayed:y, prompted:iso, days:{} }));
  window.__imgErrors = [];
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target.tagName === "IMG") window.__imgErrors.push(target.currentSrc || target.src || target.alt || "img");
  }, true);
})();`;

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
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
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof meta !== "undefined" && meta.ready && typeof BinderDaily !== "undefined" && document.getElementById("deck") && typeof scrydex !== "undefined" && scrydex.ready);

const problems = [];
function note(ok, name, extra) {
  if (!ok) problems.push(name + (extra ? " — " + extra : ""));
}

await page.evaluate(() => {
  generation++;
  if (typeof clearHuntWatch === "function") clearHuntWatch();
  huntInflight.forEach(job => job.ctrl.abort());
  huntInflight.clear();
  streamDone = true;
  paused = true;
  loading = false;
  catalogBusy = false;
  busyHold = false;
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
  showTab("daily");
});
await page.waitForSelector("#dailyGuess");

async function checkGuess(width) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const snap = await page.evaluate(() => {
    const input = document.getElementById("dailyGuess");
    const err = () => document.getElementById("dailyError");
    const read = () => {
      const node = err();
      const parsed = BinderDaily.parseGuess(input.value);
      return {
        value: input.value,
        hidden: !node || node.hidden,
        text: node ? node.textContent : "",
        ok: parsed.ok,
        parsed: parsed.value,
        message: parsed.message
      };
    };
    const type = (value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return read();
    };
    const zero = type("0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const zeroAgain = read();
    const zeroCents = type("0.00");
    document.getElementById("dailyForm").requestSubmit();
    const submitted = read();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const submittedAgain = read();
    const dash = type("-");
    const nope = type("nope");
    const half = type(".5");
    const wiped = type("");
    type("0");
    const cleared = type("");
    return { zero, zeroAgain, zeroCents, submitted, submittedAgain, dash, nope, half, wiped, cleared };
  });
  console.log(width, "guess", JSON.stringify(snap));
  const above = (row, label) => {
    note(row.hidden === false && /above zero/.test(row.text) && row.ok === false, width + " " + label + " keeps the above-zero error", JSON.stringify(row));
    note(row.message === row.text, width + " " + label + " error matches what that value parses to", JSON.stringify(row));
  };
  above(snap.zero, "0");
  above(snap.zeroAgain, "0 still");
  above(snap.zeroCents, "0.00");
  above(snap.submitted, "submitting 0.00");
  above(snap.submittedAgain, "0.00 after submit");
  note(snap.dash.value === "-" && snap.dash.hidden === false && /isn't a price/.test(snap.dash.text), width + " - stays an invalid price", JSON.stringify(snap.dash));
  note(snap.nope.value === "nope" && snap.nope.hidden === false && /isn't a price/.test(snap.nope.text), width + " nope shows the price error", JSON.stringify(snap.nope));
  note(snap.half.value === ".5" && snap.half.ok && snap.half.parsed === 0.5, width + " .5 parses as 0.50", JSON.stringify(snap.half));
  note(snap.half.hidden === true && snap.half.text === "", width + " editing to .5 clears the error", JSON.stringify(snap.half));
  note(snap.wiped.value === "" && snap.wiped.hidden === true && snap.wiped.text === "", width + " emptying the field clears the error", JSON.stringify(snap.wiped));
  note(snap.cleared.hidden === true && snap.cleared.text === "", width + " wiping a zero clears the above-zero error", JSON.stringify(snap.cleared));
}

await checkGuess(1440);
await checkGuess(390);

const species = await page.evaluate(() => {
  const names = ["Morpeko V-UNION", "Zacian V-UNION", "Greninja V-UNION", "Mewtwo V-UNION", "Pikachu VUNION", "Morpeko V UNION", "Pyroar BREAK", "Hisuian Zoroark"];
  return names.map(name => ({
    name,
    species: BinderDaily.speciesName(name),
    hunt: window.BHDailyHost.speciesFor(name)
  }));
});
console.log("species", JSON.stringify(species));
species.forEach(row => {
  const want = row.name === "Pyroar BREAK" ? "Pyroar" : row.name === "Hisuian Zoroark" ? "Zoroark" : row.name.split(" ")[0];
  note(row.species === want, "species " + row.name, row.species);
  note(row.hunt === want, "hunt species " + row.name, row.hunt);
  note(row.species !== "V-UNION" && row.species !== "UNION", row.name + " is not the suffix");
});

async function resetDaily() {
  await page.evaluate(() => {
    const bag = {};
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
    const iso = bag.year + "-" + bag.month + "-" + bag.day;
    const prev = new Date(Date.UTC(+bag.year, +bag.month - 1, +bag.day) - 86400000);
    const y = prev.getUTCFullYear() + "-" + String(prev.getUTCMonth() + 1).padStart(2, "0") + "-" + String(prev.getUTCDate()).padStart(2, "0");
    localStorage.setItem("bh.daily.v1", JSON.stringify({ v: 1, current: 4, best: 4, lastPlayed: y, prompted: iso, days: {} }));
    renderDaily();
  });
  await page.waitForSelector("#dailyGuess");
}

async function checkStreak(width) {
  const narrow = width === 390;
  await page.setViewportSize({ width, height: narrow ? 844 : 900 });
  await page.evaluate(() => showTab("daily"));
  await resetDaily();
  const answer = await page.evaluate(async () => {
    const data = await (await fetch("data/daily.json", { cache: "no-store" })).json();
    const iso = BinderDaily.nyDateISO(new Date());
    const quote = BinderDaily.quoteForPlay(data, iso, null);
    const drop = BinderDaily.pickDrop(data, iso);
    return { price: (quote && quote.price) || (drop && drop.card && drop.card.price), name: drop && drop.card && drop.card.name };
  });
  console.log(width, "answer", JSON.stringify(answer));
  note(answer.price > 0, width + " drop has a price", JSON.stringify(answer));
  await page.evaluate(async (amount) => {
    const before = dailySideModel().streak;
    window.__streakBefore = before;
    document.getElementById("dailyGuess").value = String(amount);
    document.getElementById("dailyForm").requestSubmit();
    const start = Date.now();
    while (document.getElementById("dailyForm") && Date.now() - start < 8000) {
      await new Promise(r => setTimeout(r, 20));
    }
  }, answer.price);
  const mid = await page.evaluate(() => {
    const model = dailySideModel();
    const side = document.querySelector("[data-side='daily']");
    const pageStreak = document.querySelector("#dailyScroll .daily-streak b");
    const ticket = document.querySelector("#priceTicket .ticket-front");
    const profile = document.getElementById("profile");
    return {
      before: window.__streakBefore,
      sideStreak: model.streak,
      best: model.best,
      done: model.done,
      pageStreak: pageStreak ? pageStreak.textContent : "",
      side: side ? side.innerText.replace(/\s+/g, " ") : "",
      front: ticket ? ticket.textContent.replace(/\s+/g, " ") : "",
      profileHidden: !profile || profile.hidden
    };
  });
  console.log(width, "mid-reveal", JSON.stringify(mid));
  note(mid.before === 4, width + " streak started at 4", String(mid.before));
  note(mid.done === false, width + " price stays sealed during the reveal", mid.front);
  note(/sealed/i.test(mid.front), width + " ticket still says sealed", mid.front);
  note(mid.sideStreak === 4 && mid.pageStreak === "4", width + " streak waits for the reveal", JSON.stringify(mid));
  if (narrow) note(mid.profileHidden === true, width + " the on-screen streak is the daily counter", JSON.stringify(mid));
  if (!narrow) note(/sealed/i.test(mid.side), width + " side price line still says sealed", mid.side);
  await sleep(900);
  const later = await page.evaluate(() => {
    const model = dailySideModel();
    const side = document.querySelector("[data-side='daily']");
    const pageStreak = document.querySelector("#dailyScroll .daily-streak b");
    const price = side ? side.querySelector(".market-price") : null;
    return {
      sideStreak: model.streak,
      best: model.best,
      done: model.done,
      pageStreak: pageStreak ? pageStreak.textContent : "",
      price: price ? price.textContent.trim() : "",
      side: side ? side.innerText.replace(/\s+/g, " ") : ""
    };
  });
  console.log(width, "revealed", JSON.stringify(later));
  note(later.done === true && later.sideStreak === 5 && later.best === 5, width + " streak updates after the reveal", JSON.stringify(later));
  note(later.pageStreak === "5", width + " daily streak updates after the reveal", later.pageStreak);
  if (!narrow) note(later.price && later.price !== "—", width + " revealed panel shows the price", later.price);
}

await checkStreak(1440);
await checkStreak(390);

await page.setViewportSize({ width: 1440, height: 900 });
const priced = await page.evaluate(async () => {
  generation++;
  if (typeof clearHuntWatch === "function") clearHuntWatch();
  huntInflight.forEach(job => job.ctrl.abort());
  huntInflight.clear();
  streamDone = true;
  paused = true;
  loading = false;
  showTab("hunt");
  const synthetic = normalizeDex({
    id: "swsh11-076",
    name: "Hisuian Zoroark",
    image: "https://assets.tcgdex.net/en/swsh/swsh11/076",
    localId: "076",
    set: { id: "swsh11", name: "Lost Origin" },
    pricing: { tcgplayer: null, cardmarket: { avg: 2.96 } },
    variants: { holo: true, reverse: true, normal: true },
    variants_detailed: [
      { type: "holo", pricing: { tcgplayer: { unit: "USD", holofoil: { marketPrice: 0.34, productId: 283957 }, "reverse-holofoil": { marketPrice: 0.42, productId: 283957 } } } },
      { type: "reverse", pricing: { tcgplayer: { unit: "USD", holofoil: { marketPrice: 0.34 }, "reverse-holofoil": { marketPrice: 0.42 } } } }
    ]
  });
  const kept = normalizeDex({
    id: "keep-top",
    name: "Kept",
    pricing: { tcgplayer: { holofoil: { marketPrice: 3 } } },
    variants_detailed: [{ type: "holo", pricing: { tcgplayer: { holofoil: { marketPrice: 9 } } } }]
  });
  const empty = normalizeDex({
    id: "no-market",
    name: "No Market",
    pricing: { cardmarket: { avg: 1.5 } },
    variants_detailed: [{ type: "holo", pricing: { cardmarket: { avg: 1.5 } } }]
  });
  const shaped = {
    synthetic: (synthetic.variants || []).map(v => v.key + ":" + v.market),
    syntheticUsd: usdOf(synthetic),
    keptUsd: usdOf(kept),
    emptyUsd: usdOf(empty),
    emptyText: priceText(usdOf(empty), "USD")
  };
  let live;
  try { live = await hydrate({ id: "swsh11-076" }); }
  catch (e) { return Object.assign(shaped, { error: String(e && e.message || e) }); }
  cardCache.delete("swsh11-076");
  pile = [live];
  matched = 1;
  seen = new Set([live.id]);
  deck.innerHTML = "";
  summaryId = "";
  renderDeck();
  const caption = document.getElementById("capPrice");
  const panel = document.querySelector("#profile .market-price");
  return Object.assign(shaped, {
    liveMarkets: (live.variants || []).map(v => v.key + ":" + v.market),
    liveUsd: usdOf(live),
    expected: priceText(usdOf(live), "USD"),
    caption: caption ? caption.textContent.trim() : "",
    missing: caption ? caption.classList.contains("missing") : null,
    panel: panel ? panel.textContent.trim() : ""
  });
});
console.log("zoroark", JSON.stringify(priced));
note(!priced.error, "Hisuian Zoroark loaded", priced.error || "");
note(priced.syntheticUsd === 0.34 && priced.synthetic.includes("holofoil:0.34") && priced.synthetic.includes("reverse-holofoil:0.42"), "printing table supplies the Hisuian Zoroark market", JSON.stringify(priced.synthetic));
note(priced.keptUsd === 3, "a card-level market still wins", String(priced.keptUsd));
note(priced.emptyUsd == null && priced.emptyText === "—", "a card with no market stays an em dash", priced.emptyText);
if (!priced.error) {
  note(priced.liveUsd > 0 && priced.expected !== "—" && priced.caption === priced.expected, "live Hisuian Zoroark shows its cached market", JSON.stringify(priced));
  note(priced.missing === false, "Hisuian Zoroark is not marked missing", String(priced.missing));
  note(priced.panel.replace(/\s+/g, " ").includes(priced.caption), "desktop panel matches the caption", priced.panel + " vs " + priced.caption);
}

await page.setViewportSize({ width: 390, height: 844 });
const narrow = await page.evaluate(() => {
  summaryId = "";
  renderDeck();
  const caption = document.getElementById("capPrice");
  const card = (typeof currentTop === "function" && currentTop()) || (pile && pile[0]);
  const shown = card ? printingMoney(card) : null;
  return {
    caption: caption ? caption.textContent.trim() : "",
    missing: caption ? caption.classList.contains("missing") : null,
    amount: shown ? shown.amount : null
  };
});
console.log("zoroark 390", JSON.stringify(narrow));
note(narrow.amount > 0 && narrow.caption !== "—" && narrow.missing === false, "390 caption shows the Hisuian Zoroark market", JSON.stringify(narrow));

const blank = await page.evaluate(() => {
  const art = "https://assets.tcgdex.net/en/base/base1/58";
  const make = (id, name) => ({ id, name, set: "Base", setId: "base1", number: "1", rarity: "Common", img: art + "/high.webp", thumb: art + "/low.webp", variants: [] });
  const first = make("noprice-1", "No Price");
  const second = make("noprice-2", "Also No Price");
  pile = [first];
  deck.innerHTML = "";
  summaryId = "";
  renderDeck();
  const read = () => {
    const caption = document.getElementById("capPrice");
    return { text: caption ? caption.textContent.trim() : "", missing: caption ? caption.classList.contains("missing") : false };
  };
  const a = read();
  pile = [second];
  deck.innerHTML = "";
  summaryId = "";
  renderDeck();
  const b = read();
  return { a, b };
});
console.log("no price", JSON.stringify(blank));
note(blank.a.text === "—" && blank.b.text === "—" && blank.a.missing && blank.b.missing && blank.a.text === blank.b.text, "unpriced cards share the em dash", JSON.stringify(blank));

await page.waitForFunction(() => {
  const imgs = [...document.querySelectorAll("#deck img")];
  return imgs.length > 0 && imgs.every(img => img.complete);
});
const broken = await page.evaluate(() => (window.__imgErrors || []).slice());
imageErrors.push(...broken);
const deckImgs = await page.evaluate(() => [...document.querySelectorAll("#deck img")].map(img => ({ src: img.currentSrc || img.src, ok: img.complete && img.naturalWidth > 0 })));
note(deckImgs.length > 0 && deckImgs.every(img => img.ok), "deck images loaded", JSON.stringify(deckImgs));

if (problems.length || errors.length || imageErrors.length) {
  console.log(problems.concat(errors, imageErrors).join("\n"));
  await shutdown(1);
}
console.log("polish checks passed");
await shutdown(0);
