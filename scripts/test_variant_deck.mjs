// The deck caption and price-drop badge stay on the printing selected in the panel.
// Dark Charizard (base5-4) is switched between 1st Edition Holofoil and
// Unlimited Holofoil. Each time, the caption price and the deck badge have to
// match the panel, at 390x844 and at 1440x900.
// Run: npx -y node@22 scripts/test_variant_deck.mjs
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8791;
const vendor = "/tmp/binderhunt-playwright";
const shotDir = "/opt/cursor/artifacts";
const shotPrefix = process.env.SHOT_PREFIX || "variant";
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

const boot = `localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
localStorage.setItem("binderhuntWish","[]");
localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
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
await page.addInitScript(boot);
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof scrydex !== "undefined" && scrydex.ready && typeof meta !== "undefined" && meta.ready && typeof priceDrop === "function" && typeof selectedVariant === "function");

const problems = [];
function note(ok, name, extra) {
  if (!ok) problems.push(name + (extra ? " — " + extra : ""));
}

const planted = await page.evaluate(async () => {
  generation++;
  pumpEpoch++;
  if (typeof clearHuntWatch === "function") clearHuntWatch();
  huntInflight.forEach(job => job.ctrl.abort());
  huntInflight.clear();
  streamDone = true;
  paused = true;
  loading = false;
  catalogBusy = false;
  busyHold = false;
  pumpError = "";
  clearTimeout(busyRenderTimer);
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
  variantChoice.delete("base5-4");
  let card;
  try { card = await hydrate({ id: "base5-4" }); }
  catch (e) { return { error: "hydrate base5-4 — " + (e && e.message || e) }; }
  if (!card || card.id !== "base5-4") return { error: "hydrate returned " + (card && card.id) };
  const labels = (card.variants || []).filter(v => v && v.market > 0).map(v => v.label + " @" + v.market);
  pile = [card];
  matched = 1;
  seen = new Set([card.id]);
  deck.innerHTML = "";
  showTab("hunt");
  renderDeck();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { id: card.id, name: card.name, labels };
});
if (!planted || planted.error) {
  console.log(planted && planted.error || "card did not plant");
  await shutdown(1);
}
console.log("planted", JSON.stringify(planted));
await page.waitForFunction(() => {
  const top = typeof topCard === "function" ? topCard() : null;
  return !!(top && top.card && top.card.id === "base5-4" && document.querySelector("#profile [data-variant]"));
});

async function settle() {
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const imgs = [...document.querySelectorAll("#deck img, #profile img")];
    await Promise.all(imgs.map(img => img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function shot(name) {
  await settle();
  const file = shotDir + "/" + shotPrefix + "-" + name + ".png";
  await page.screenshot({ path: file });
  console.log("screenshot", file);
}

function readSnap() {
  return page.evaluate(() => {
    const face = el => {
      if (!el) return "";
      const shown = el.querySelector("[aria-hidden='true']");
      return (shown ? shown.textContent : el.textContent || "").replace(/\s+/g, " ").trim();
    };
    const top = topCard();
    const card = top && top.card;
    const variant = card ? selectedVariant(card) : null;
    const drop = card ? priceDrop(card) : null;
    const panelPrice = document.querySelector("#profile .market-price");
    const panelBadge = document.querySelector("#profile .price-row .drop-badge");
    const deckBadge = top && top.querySelector(":scope .frame > .drop-badge");
    const caption = document.getElementById("capPrice");
    const pressed = [...document.querySelectorAll("#profile [data-variant]")].filter(btn => btn.getAttribute("aria-pressed") === "true").map(btn => btn.textContent.trim());
    return {
      id: card && card.id || "",
      key: variant && variant.key || "",
      label: variant && variant.label || "",
      modelPrice: variant && pos(variant.market) ? priceText(variant.market, "USD") : "",
      modelBadge: drop ? "↓" + drop.shown + "%" : "",
      panelPrice: panelPrice ? panelPrice.textContent.trim() : "",
      panelBadge: face(panelBadge),
      caption: caption ? caption.textContent.trim() : "",
      deckBadge: face(deckBadge),
      pressed
    };
  });
}

async function choose(label) {
  const buttons = page.locator("#profile button[data-variant]");
  const count = await buttons.count();
  let target = null;
  for (let i = 0; i < count; i++) {
    const text = (await buttons.nth(i).innerText()).replace(/\s+/g, " ").trim();
    if (text === label) target = buttons.nth(i);
  }
  if (!target) {
    const texts = await buttons.allInnerTexts();
    throw new Error("expected one " + label + " button, saw " + JSON.stringify(texts));
  }
  await target.click();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function checkPrinting(label, width, slug) {
  await choose(label);
  const snap = await readSnap();
  console.log(width, label, JSON.stringify(snap));
  const where = width + " " + label;
  note(snap.id === "base5-4", where + " stays on Dark Charizard", snap.id);
  note(snap.pressed.length === 1 && snap.pressed[0] === label, where + " button is pressed", JSON.stringify(snap.pressed));
  note(snap.label === label, where + " selected printing", snap.label);
  note(snap.caption === snap.panelPrice, where + " caption matches the panel", snap.caption + " vs " + snap.panelPrice);
  note(snap.deckBadge === snap.panelBadge, where + " deck badge matches the panel", JSON.stringify(snap.deckBadge) + " vs " + JSON.stringify(snap.panelBadge));
  note(snap.panelPrice === snap.modelPrice && snap.panelPrice !== "—" && snap.panelPrice !== "", where + " panel price is the selected printing", snap.panelPrice + " vs " + snap.modelPrice);
  note(snap.panelBadge === snap.modelBadge, where + " panel badge is the selected printing", JSON.stringify(snap.panelBadge) + " vs " + JSON.stringify(snap.modelBadge));
  note(!/NaN|\$0(?:\.00)?/.test(snap.caption + " " + snap.panelPrice + " " + snap.deckBadge + " " + snap.panelBadge), where + " has no NaN or $0");
  await shot(width + "-" + slug);
  if (width === 390) {
    await page.evaluate(() => { document.getElementById("profile").hidden = true; });
    await shot(width + "-" + slug + "-deck");
    await page.evaluate(() => { document.getElementById("profile").hidden = false; });
  }
  return snap;
}

const order = [
  ["1st Edition Holofoil", "first"],
  ["Unlimited Holofoil", "unlimited"],
  ["1st Edition Holofoil", "first-again"],
  ["Unlimited Holofoil", "unlimited-again"]
];

const wideSnaps = [];
for (const [label, slug] of order) wideSnaps.push(await checkPrinting(label, 1440, slug));
note(wideSnaps[0].panelPrice === wideSnaps[2].panelPrice && wideSnaps[0].panelBadge === wideSnaps[2].panelBadge, "1440 return to 1st Edition matches the first visit", JSON.stringify(wideSnaps[0]) + " vs " + JSON.stringify(wideSnaps[2]));
note(wideSnaps[1].panelPrice === wideSnaps[3].panelPrice && wideSnaps[1].deckBadge === wideSnaps[3].deckBadge && wideSnaps[1].caption === wideSnaps[3].caption, "1440 return to Unlimited matches the first visit");
note(wideSnaps[0].panelPrice !== wideSnaps[1].panelPrice || wideSnaps[0].panelBadge !== wideSnaps[1].panelBadge, "1440 printings differ", wideSnaps[0].panelPrice + " " + wideSnaps[0].panelBadge + " vs " + wideSnaps[1].panelPrice + " " + wideSnaps[1].panelBadge);

await page.evaluate(() => { openProfile(topCard().card); });
await page.waitForSelector("#profile #closeProfile");
const pinned = [];
for (const [label, slug] of order) pinned.push(await checkPrinting(label, 1440, "profile-" + slug));
note(pinned[0].caption === pinned[0].panelPrice && pinned[1].deckBadge === pinned[1].panelBadge, "1440 full profile keeps the deck with the panel");
note(pinned[0].panelPrice !== pinned[1].panelPrice || pinned[0].panelBadge !== pinned[1].panelBadge, "1440 full profile printings differ");
await page.evaluate(() => { closeProfile(); });

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
await page.evaluate(() => { openProfile(topCard().card); });
await page.waitForSelector("#profile button[data-variant]");
const narrow = [];
for (const [label, slug] of order) narrow.push(await checkPrinting(label, 390, slug));
note(narrow[0].panelPrice === narrow[2].panelPrice && narrow[0].deckBadge === narrow[2].deckBadge && narrow[0].caption === narrow[2].caption, "390 return to 1st Edition matches the first visit");
note(narrow[1].panelPrice === narrow[3].panelPrice && narrow[1].deckBadge === narrow[3].deckBadge && narrow[1].caption === narrow[3].caption, "390 return to Unlimited matches the first visit");
note(narrow[0].panelPrice !== narrow[1].panelPrice || narrow[0].panelBadge !== narrow[1].panelBadge, "390 printings differ", narrow[0].panelPrice + " " + narrow[0].panelBadge + " vs " + narrow[1].panelPrice + " " + narrow[1].panelBadge);
note(narrow[1].caption === wideSnaps[1].caption && narrow[1].deckBadge === wideSnaps[1].deckBadge, "390 Unlimited deck matches the desktop deck", narrow[1].caption + " " + narrow[1].deckBadge + " vs " + wideSnaps[1].caption + " " + wideSnaps[1].deckBadge);

if (problems.length || errors.length) {
  console.log(problems.concat(errors).join("\n"));
  await shutdown(1);
}
console.log("variant deck checks passed");
await shutdown(0);
