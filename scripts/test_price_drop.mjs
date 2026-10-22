// Price-drop badges use cached Scrydex history only.
// A badge appears at a 10%+ drop versus about 30 days earlier, and nowhere
// else: short history, a stale baseline, a rise, a missing printing, or a
// non-finite price stays blank. Mouse and touch swipes still move the deck.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof WebSocket !== "function") {
  throw new Error("test_price_drop.mjs requires Node.js 22+ (global WebSocket).");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8776;
const CDP = 9229;
mkdirSync("/opt/cursor/artifacts/screenshots", { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const chrome = spawn("google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--remote-debugging-port=" + CDP, "--user-data-dir=/tmp/chrome-price-drop", "about:blank"
], { stdio: "ignore" });
const errors = [];
process.on("exit", () => {
  try { chrome.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
});
function sendFactory(socket) {
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method) listeners.forEach(fn => fn(msg));
  });
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(fn) { listeners.push(fn); }
  };
}
async function waitPort() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch("http://127.0.0.1:" + CDP + "/json/version"); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error("Chrome did not open a debugging port");
}
function shutdown(code) {
  try { chrome.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
  process.exit(code);
}

await waitPort();
const pages = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
const page = pages.find(p => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
const cdp = sendFactory(ws);
cdp.on(msg => {
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    errors.push((d.exception && d.exception.description || d.text || "exception").split("\n")[0]);
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    const text = (msg.params.args || []).map(a => a.value || a.description || "").join(" ");
    if (text) errors.push(text.split("\n")[0]);
  }
});
async function ev(expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 1600));
  return result.result.value;
}
async function shot(name) {
  const png = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync("/opt/cursor/artifacts/screenshots/" + name + ".png", Buffer.from(png.data, "base64"));
}
async function size(width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await ev("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
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

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: boot });
await size(390, 844);
await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/index.html" });
await ev(`new Promise((resolve, reject) => {
  const start = Date.now();
  const t = setInterval(() => {
    if (typeof scrydex !== "undefined" && scrydex.ready && typeof meta !== "undefined" && meta.ready && typeof priceDrop === "function") { clearInterval(t); resolve(true); }
    else if (Date.now() - start > 20000) { clearInterval(t); reject(new Error("page did not finish loading")); }
  }, 50);
})`);

const report = await ev(`(() => {
  const problems = [];
  const note = (ok, name, extra) => { if (!ok) problems.push(name + (extra ? " — " + extra : "")); };
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
  const day = (iso, market) => ({ d: iso.replace(/-/g, "/"), v: "holofoil", m: market });
  const card = (id, key) => ({ id, name: id, variants: [{ key: key || "holofoil", label: "Holofoil", market: 10 }] });
  scrydex.ready = true;
  scrydex.cards["logic-drop"] = { history: [day("2026-09-01", 100), day("2026-10-01", 80)] };
  scrydex.cards["logic-exact"] = { history: [day("2026-09-01", 100), day("2026-10-01", 90)] };
  scrydex.cards["logic-round"] = { history: [day("2026-09-01", 100), day("2026-10-01", 89.6)] };
  scrydex.cards["logic-under"] = { history: [day("2026-09-01", 100), day("2026-10-01", 90.4)] };
  scrydex.cards["logic-up"] = { history: [day("2026-09-01", 80), day("2026-10-01", 100)] };
  scrydex.cards["logic-short"] = { history: [day("2026-09-20", 100), day("2026-10-01", 50)] };
  scrydex.cards["logic-stale"] = { history: [day("2026-07-01", 100), day("2026-10-01", 50)] };
  scrydex.cards["logic-bad"] = { history: [day("2026-09-01", 0), day("2026-10-01", 0), { d: "2026/09/01", v: "holofoil", m: NaN }] };
  scrydex.cards["logic-miss"] = { history: [] };
  scrydex.cards["logic-other"] = { history: [{ d: "2026/09/01", v: "firstEditionHolofoil", m: 100 }, { d: "2026/10/01", v: "firstEditionHolofoil", m: 40 }] };
  const read = id => { const d = priceDrop(card(id)); return d ? d.shown + " @" + d.days : ""; };
  note(read("logic-drop") === "20 @30", "20% over 30 days", read("logic-drop"));
  note(read("logic-exact") === "10 @30", "exactly 10%", read("logic-exact"));
  note(read("logic-round") === "10 @30", "10.4% rounds onto the badge", read("logic-round"));
  note(read("logic-under") === "", "9.6% stays blank", read("logic-under"));
  note(read("logic-up") === "", "a rise stays blank", read("logic-up"));
  note(read("logic-short") === "", "a window under 30 days stays blank", read("logic-short"));
  note(read("logic-stale") === "", "a baseline older than 45 days stays blank", read("logic-stale"));
  note(read("logic-bad") === "", "zero and NaN prices stay blank", read("logic-bad"));
  note(read("logic-miss") === "", "missing history stays blank", read("logic-miss"));
  note(read("logic-other") === "", "a different printing stays blank", read("logic-other"));
  note(priceDrop(null) == null && priceDrop({ id: "nope" }) == null, "unknown cards stay blank");
  scrydex.ready = false;
  note(priceDrop(card("logic-drop")) == null, "a cache that has not loaded stays blank");
  scrydex.ready = true;
  const html = dropBadgeMarkup(priceDrop(card("logic-drop")));
  note(html.includes("↓20%") && !html.includes("NaN") && !html.includes("$0"), "badge text is a percent", html);
  note(droppedCount([card("logic-drop"), card("logic-up"), card("logic-miss")]) === 1, "wishlist count ignores cards that did not drop");
  note(droppedCountMarkup(0) === "" && droppedCountMarkup(2).includes("Dropped 2"), "count pill");
  const edge = marketBlock(card("logic-stale"), card("logic-stale").variants[0], { amount: 12.5, currency: "USD" }, null);
  note(edge.includes("$12.50") && !edge.includes("drop-badge") && !edge.includes("NaN"), "price stays without a badge", edge);
  return problems;
})()`);
if (report && report.length) {
  console.log(report.join("\n"));
  shutdown(1);
}

const live = await ev(`(async () => {
  try {
  const problems = [];
  const note = (ok, name, extra) => { if (!ok) problems.push(name + (extra ? " — " + extra : "")); };
  generation++;
  pumpEpoch++;
  if (typeof clearHuntWatch === "function") clearHuntWatch();
  huntInflight.forEach(job => job.ctrl.abort());
  huntInflight.clear();
  streamDone = true;
  paused = true;
  loading = false;
  const ids = ["sv08.5-161", "me02-130"];
  const cards = [];
  for (const id of ids) {
    try { cards.push(await hydrate({ id })); }
    catch (e) { problems.push("hydrate " + id + " — " + (e && e.message || e)); }
  }
  const described = cards.map(card => {
    const drop = priceDrop(card);
    const variant = selectedVariant(card);
    return { id: card.id, name: card.name, key: variant && variant.key, price: variant && variant.market, drop: drop ? drop.shown : 0, days: drop ? drop.days : 0 };
  });
  const drops = cards.filter(card => priceDrop(card));
  const quiet = {
    id: "quiet-card", name: "Bulbasaur", set: "Base", setId: "base1", number: "44",
    img: "https://assets.tcgdex.net/en/base/base1/44/high.webp", thumb: "https://assets.tcgdex.net/en/base/base1/44/low.webp",
    variants: [{ key: "normal", label: "Normal", market: 2.5 }], rarity: "Common"
  };
  cards.push(quiet);
  note(drops.length >= 1, "at least one cached card qualifies", JSON.stringify(described));
  note(!priceDrop(quiet), "a card missing from the cache has no drop");
  catalogBusy = false;
  busyHold = false;
  pumpError = "";
  const hero = drops[0];
  if (!hero) return { problems, described, cache: Object.keys(scrydex.cards || {}).length, hero: null };
  const rest = cards.filter(card => card !== hero);
  pile = [hero].concat(rest);
  matched = pile.length;
  seen = new Set(pile.map(card => card.id));
  deck.innerHTML = "";
  showTab("hunt");
  renderDeck();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const top = topCard();
  const badge = top && top.querySelector(".drop-badge");
  if (!top || !top.card) return { problems, described, diag: { nodes: [...deck.querySelectorAll(".card")].map(el => ({ id: el.card && el.card.id, cls: el.className, html: el.outerHTML.slice(0, 180) })) } };
  note(top.card.id === hero.id, "drop card is on top of the deck", top.card.id);
  note(!!badge && badge.textContent.includes("↓" + priceDrop(hero).shown + "%"), "deck card shows the percent", badge && badge.textContent);
  note(!badge.textContent.includes("NaN") && !document.body.innerText.includes("NaN"), "no NaN on the deck");
  note(!document.body.innerText.includes("$0"), "no $0 on the deck");
  const quietCard = rest.find(card => !priceDrop(card));
  if (quietCard) {
    const el = [...deck.querySelectorAll(".card")].find(node => node.card === quietCard);
    note(!!el && !el.querySelector(".drop-badge"), "a card without a qualifying drop has no badge", quietCard.id);
  }
  const save = getComputedStyle(document.getElementById("save"));
  const skip = getComputedStyle(document.getElementById("skip"));
  note(save.backgroundColor === "rgb(171, 178, 141)", "save stays green", save.backgroundColor);
  note(skip.backgroundColor === "rgb(246, 201, 201)", "skip stays rose", skip.backgroundColor);
  wish = [];
  binderState = { discoveryId: "", binders: [{ id: "drop-binder", name: "Favorites", color: "#E9D5C0", charm: "toad", cards: [], theme: { kind: "none" } }] };
  cards.forEach(card => { addWish(card); addToBinder(binderState.binders[0], card); });
  const count = droppedCount(wish);
  note(count === drops.length && count >= 1, "wishlist count matches qualifying cards", String(count));
  return { problems, described, hero: hero && hero.id, count };
  } catch (e) { return { problems: [String(e && e.stack || e)] }; }
})()`);
if (!live || live.diag) { console.log(JSON.stringify(live, null, 2)); shutdown(1); }
if (live.problems.length) {
  console.log(JSON.stringify(live, null, 2));
  shutdown(1);
}
console.log(JSON.stringify(live.described));

async function settle() {
  await ev(`(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const imgs = [...document.images];
    await Promise.all(imgs.map(img => img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
  await sleep(150);
}
function auditName(label) {
  const name = JSON.stringify(String(label));
  return ev(`(() => {
    const label = ${name};
    const problems = [];
    const viewH = window.innerHeight, viewW = window.innerWidth;
    const shown = el => {
      if (!el || el.hidden) return false;
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    };
    const visible = [...document.querySelectorAll(".drop-badge")].filter(shown);
    if (!visible.length) problems.push(label + " has no visible badge");
    visible.forEach(el => {
      const r = el.getBoundingClientRect();
      const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
      if (!(r.width > 8 && r.height > 8)) problems.push(label + " badge has no size: " + text);
      if (r.top < -1 || r.left < -1 || r.bottom > viewH + 1 || r.right > viewW + 1) problems.push(label + " badge outside viewport: " + text + " " + JSON.stringify({ t: Math.round(r.top), l: Math.round(r.left), b: Math.round(r.bottom), right: Math.round(r.right), w: viewW, h: viewH }));
      const face = el.querySelector("[aria-hidden='true']") || el;
      if (face.scrollWidth > face.clientWidth + 2) problems.push(label + " badge text clipped: " + text);
      if (/NaN|\\$0(?:\\.00)?/.test(text)) problems.push(label + " bad badge text: " + text);
    });
    const broken = [...document.images].filter(img => img.src && img.complete && img.naturalWidth === 0 && !img.closest("[hidden]")).map(img => img.src);
    if (broken.length) problems.push(label + " broken images: " + broken.slice(0, 4).join(", "));
    if (document.body.innerText.includes("NaN")) problems.push(label + " page contains NaN");
    return problems;
  })()`);
}

await settle();
await shot("drop-390-deck");
let audits = await auditName("390 deck");

await ev(`openProfile(pile[0]); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await settle();
const profileOk = await ev(`(() => {
  const price = document.querySelector("#profile .market-price");
  const badge = document.querySelector("#profile .price-row .drop-badge");
  const row = document.querySelector("#profile .price-row");
  if (!price || !badge || !row) return "profile price row missing";
  const pr = price.getBoundingClientRect();
  const br = badge.getBoundingClientRect();
  if (!(pr.width > 20)) return "price has no size";
  if (br.left + 2 < pr.left) return "badge is before the price";
  if (!badge.textContent.includes("↓")) return "profile badge missing percent";
  return "";
})()`);
if (profileOk) { console.log(profileOk); shutdown(1); }
await shot("drop-390-profile");
audits = audits.concat(await auditName("390 profile"));
await ev(`closeProfile()`);

await ev(`showTab("binders"); binderView = null; renderBinders(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await settle();
const shelfOk = await ev(`(() => {
  const row = document.getElementById("openWish");
  const badge = row && row.querySelector(".drop-badge");
  if (!badge || !badge.textContent.includes("Dropped")) return "wishlist entry has no Dropped indicator";
  return "";
})()`);
if (shelfOk) { console.log(shelfOk); shutdown(1); }
await shot("drop-390-wishlist");
audits = audits.concat(await auditName("390 wishlist"));

await ev(`document.getElementById("openWish").click(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await settle();
const sleeveOk = await ev(`(() => {
  const sleeves = [...document.querySelectorAll("#bindersScroll .sleeve")].filter(el => !el.classList.contains("empty"));
  const badged = sleeves.filter(el => el.querySelector(".drop-badge"));
  if (!sleeves.length) return "wishlist has no sleeves";
  if (!badged.length) return "no sleeve badge";
  const plain = sleeves.filter(el => !el.querySelector(".drop-badge"));
  if (!plain.length) return "every sleeve has a badge; expected a card without one";
  return "";
})()`);
if (sleeveOk) { console.log(sleeveOk); shutdown(1); }
await shot("drop-390-sleeves");
audits = audits.concat(await auditName("390 sleeves"));

await size(1440, 900);
await ev(`closeProfile(); binderView = null; showTab("hunt"); renderDeck(); openProfile(pile[0]); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await settle();
const wideOk = await ev(`(() => {
  if (!wide()) return "desktop layout did not engage";
  const deckBadge = topCard() && topCard().querySelector(".drop-badge");
  const profileBadge = document.querySelector("#profile .price-row .drop-badge");
  if (!deckBadge) return "desktop deck card has no badge";
  if (!profileBadge) return "desktop profile has no badge";
  return "";
})()`);
if (wideOk) { console.log(wideOk); shutdown(1); }
await shot("drop-1440-deck-profile");
audits = audits.concat(await auditName("1440 deck"));

await ev(`showTab("binders"); binderView = { kind: "wish" }; flipPage = 0; renderBinders(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await settle();
const railOk = await ev(`(() => {
  const rail = document.getElementById("railWish");
  const badge = rail && rail.querySelector(".drop-badge");
  const sleeve = document.querySelector("#bindersScroll .sleeve .drop-badge");
  if (!badge || !badge.textContent.includes("Dropped")) return "rail wishlist has no Dropped indicator";
  if (!sleeve) return "desktop sleeves have no badge";
  const cloth = document.querySelector(".binder-book, .book.folio, .book.leather");
  if (!cloth) return "binder pages are missing";
  return "";
})()`);
if (railOk) { console.log(railOk); shutdown(1); }
await shot("drop-1440-wishlist");
audits = audits.concat(await auditName("1440 wishlist"));

await ev(`showTab("hunt"); closeProfile(); renderDeck();`);
await size(390, 844);
await ev(`showTab("hunt"); renderDeck(); new Promise(r => requestAnimationFrame(r))`);
const swipes = await ev(`(async () => {
  const problems = [];
  const note = (ok, name, extra) => { if (!ok) problems.push(name + (extra ? " — " + extra : "")); };
  wish = [];
  saveWish();
  const before = pile.map(card => card.id);
  function swipe(el, dx, pointerType) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const pid = pointerType === "touch" ? 7 : 3;
    const opts = (cx) => ({ pointerId: pid, clientX: cx, clientY: y, pointerType, bubbles: true, button: 0, buttons: 1, isPrimary: true });
    el.dispatchEvent(new PointerEvent("pointerdown", opts(x)));
    window.dispatchEvent(new PointerEvent("pointermove", opts(x + dx / 3)));
    window.dispatchEvent(new PointerEvent("pointermove", opts(x + dx)));
    window.dispatchEvent(new PointerEvent("pointerup", opts(x + dx)));
  }
  const mouseTop = topCard();
  swipe(mouseTop, -160, "mouse");
  await new Promise(r => setTimeout(r, 400));
  note(!pile.some(card => card.id === before[0]), "mouse swipe passes the top card", pile.map(c => c.id).join(","));
  note(pile.length >= 2, "deck still has cards after a mouse swipe", String(pile.length));
  const touchTop = topCard();
  swipe(touchTop, 160, "touch");
  await new Promise(r => setTimeout(r, 400));
  note(!pile.some(card => card.id === before[1]) && wish.some(card => card.id === before[1]), "touch swipe saves the next card", pile.map(c => c.id).join(",") + " wish " + wish.map(c => c.id).join(","));
  note(!!document.querySelector("#deck .card"), "a card remains on the table");
  note(!document.body.innerText.includes("NaN"), "swipe did not surface NaN");
  return problems;
})()`);
audits = audits.concat(swipes || []);
if (audits.length || errors.length) {
  console.log(audits.concat(errors).join("\n"));
  shutdown(1);
}
console.log("price drop checks passed");
console.log("screenshots in /opt/cursor/artifacts/screenshots");
shutdown(0);
