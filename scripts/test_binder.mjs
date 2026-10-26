// Binder: a dragged sheet turns once its edge crosses the spine, an early
// release settles back, arrow keys turn pages, empty pockets stay in the
// grid, cards inspect in 3D, card art never asks for CORS and falls back
// through every URL, and a card can live in more than one binder without
// leaving the wishlist.
// Run: npx -y node@22 scripts/test_binder.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

if (typeof WebSocket !== "function") {
  throw new Error("test_binder.mjs requires Node.js 22+ (global WebSocket).");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8788;
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}
const CDP = await freePort();
const profileDir = mkdtempSync(join(tmpdir(), "chrome-binder-"));
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const chrome = spawn("google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--remote-debugging-port=" + CDP, "--user-data-dir=" + profileDir, "about:blank"
], { stdio: "ignore" });
const errors = [];
const extraProcs = [];
const extraProfiles = [];
function cleanup() {
  try { chrome.kill(); } catch (e) {}
  extraProcs.forEach(proc => { try { proc.kill(); } catch (e) {} });
  try { server.kill(); } catch (e) {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  extraProfiles.forEach(dir => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
}
process.on("exit", cleanup);
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
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error("Chrome did not open a debugging port");
}
function shutdown(code) {
  cleanup();
  process.exit(code);
}

const cards = Array.from({ length: 19 }, (_, i) => ({
  id: "bh-" + i,
  name: "Card " + (i + 1),
  set: "Base",
  setId: "base1",
  number: String(i + 1),
  rarity: i === 0 ? "Rare Holo" : "Common",
  price: i === 0 ? 4400 : (i + 1) * 3.25
}));
const binders = {
  discoveryId: "",
  binders: [
    { id: "jungle", name: "Jungle", color: "#ABB28D", theme: { kind: "none" }, charm: "none", cards },
    { id: "water", name: "Water", color: "#86DEFF", theme: { kind: "none" }, charm: "toad", cards: [cards[0], cards[4]] }
  ]
};

await waitPort(CDP);
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
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

const boot = `localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
localStorage.setItem("binderhuntWish", ${JSON.stringify(JSON.stringify(cards))});
localStorage.setItem("bh.binders.v1", ${JSON.stringify(JSON.stringify(binders))});
localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:true,reduce:"off",currency:"USD"}));
localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
})();`;
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: boot });

const problems = [];
function note(ok, name, extra) {
  if (ok) console.log("ok", name);
  else {
    const line = name + (extra ? " — " + extra : "");
    problems.push(line);
    console.log("FAIL", line);
  }
}

await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/index.html" });
const ready = await ev(`(async () => {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (typeof meta !== "undefined" && meta.ready && document.getElementById("deck") && typeof renderBinders === "function") return "";
    await new Promise(r => setTimeout(r, 100));
  }
  return "app was not ready";
})()`);
if (ready) { console.log(ready); shutdown(1); }

await ev(`showTab("binders"); binderView = { kind: "binder", id: "jungle" }; flipPage = 0; renderBinders(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await sleep(80);

const opened = await ev(`(() => {
  const book = document.querySelector(".book");
  const sleeves = [...document.querySelectorAll("#bindersScroll .leaf > .face.front .sleeve")];
  const filled = sleeves.filter(el => !el.classList.contains("empty"));
  const empty = sleeves.filter(el => el.classList.contains("empty"));
  const pill = document.querySelector(".price-pill");
  return {
    layout: book && book.dataset.layout,
    flip: book && book.dataset.flip,
    filled: filled.length,
    empty: empty.length,
    holo: !!(filled[0] && filled[0].classList.contains("wanted") && filled[0].classList.contains("holo")),
    pill: pill ? pill.textContent : "",
    pages: document.querySelectorAll(".leaf > .face.front .page-num").length
  };
})()`);
note(opened.layout === "solo" && opened.flip === "0", "phone shows one page", JSON.stringify(opened));
note(opened.filled === 9 && opened.empty === 0, "first phone page is a full 3x3", JSON.stringify(opened));
note(opened.holo, "holo card keeps its sleeve class", JSON.stringify(opened));
note(opened.pill === "$4.4K", "price pill uses the compact showcase format", opened.pill);
note(opened.pages === 1, "a phone page has one page number", String(opened.pages));

await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
const controls = await ev(`(() => {
  const ears = [...document.querySelectorAll("#pagePrev, #pageCorner")];
  const buttons = [...document.querySelectorAll("#bindersScroll .leaf > .face.front .gotbtn, #bindersScroll .leaf > .face.front .iconish.more")];
  const overlap = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
  let hits = 0;
  buttons.forEach(btn => {
    const r = btn.getBoundingClientRect();
    if (r.width < 1) return;
    ears.forEach(ear => { if (overlap(r, ear.getBoundingClientRect())) hits++; });
  });
  let blocked = 0;
  let aimed = 0;
  buttons.forEach(btn => {
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (r.width < 1 || cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
    aimed++;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || (hit !== btn && !btn.contains(hit))) blocked++;
  });
  const hit = document.querySelector("#bindersScroll .cardhit");
  if (hit) hit.focus({ focusVisible: true });
  const ring = hit ? getComputedStyle(hit) : null;
  return {
    hits,
    blocked,
    aimed,
    widths: ears.map(ear => Math.round(ear.getBoundingClientRect().width)),
    active: !!(hit && document.activeElement === hit),
    visible: !!(hit && hit.matches(":focus-visible")),
    outline: ring ? ring.outlineColor : "",
    style: ring ? ring.outlineStyle : "",
    offset: ring ? ring.outlineOffset : ""
  };
})()`);
note(controls.hits === 0 && controls.blocked === 0 && controls.aimed > 0, "card controls sit outside the page-turn hit area", JSON.stringify(controls));
note(controls.widths.every(w => w > 0 && w <= 20), "page-turn edges stay a thin strip", JSON.stringify(controls.widths));
note(controls.visible && controls.outline === "rgb(243, 237, 200)" && controls.offset === "2px", "card focus ring is visible on the dark page", JSON.stringify(controls));

const printing = await ev(`(() => {
  scrydex.ready = true;
  scrydex.cards["bh-0"] = { history: [
    { d: "2026/09/01", v: "holofoil", m: 500 },
    { d: "2026/10/01", v: "holofoil", m: 420.5 },
    { d: "2026/09/01", v: "1stEditionHolofoil", m: 4000 },
    { d: "2026/10/01", v: "1stEditionHolofoil", m: 4400 }
  ] };
  const card = binderState.binders.find(b => b.id === "jungle").cards[0];
  card.variants = [
    { key: "holofoil", label: "Holofoil", market: 420.5 },
    { key: "1stEditionHolofoil", label: "1st Edition Holofoil", market: 4400 }
  ];
  variantChoice.delete(card.id);
  flipPage = 0;
  renderBinders();
  const sleeve = document.querySelector('#bindersScroll .gotbtn[data-for="bh-0"]').closest(".sleeve");
  const before = {
    pill: sleeve.querySelector(".price-pill").textContent,
    badge: (sleeve.querySelector(":scope > .drop-badge") || {}).textContent || ""
  };
  openProfile(card);
  const btn = [...document.querySelectorAll("[data-variant]")].find(el => el.dataset.variant === "1stEditionHolofoil");
  if (btn) btn.click();
  const afterSleeve = document.querySelector('#bindersScroll .gotbtn[data-for="bh-0"]').closest(".sleeve");
  const after = {
    pill: afterSleeve.querySelector(".price-pill").textContent,
    badge: (afterSleeve.querySelector(":scope > .drop-badge") || {}).textContent || "",
    profile: (document.querySelector(".market-price") || {}).textContent || ""
  };
  closeProfile();
  variantChoice.delete(card.id);
  delete card.variants;
  renderBinders();
  return { before, after, clicked: !!btn };
})()`);
note(printing.clicked && printing.before.pill === "$420.50" && /↓/.test(printing.before.badge), "the pocket starts on the cheapest printing", JSON.stringify(printing.before));
note(printing.after.profile === "$4,400.00" && printing.after.pill === "$4.4K" && !printing.after.badge, "switching printings updates the pill and the drop badge", JSON.stringify(printing.after));

const turnLeaf = `(document.querySelector(".leaf.hot") || document.querySelector(".leaf.right"))`;
async function waitIdle(ms = 2600) {
  return ev(`(async () => {
    const start = Date.now();
    while (Date.now() - start < ${ms}) {
      const book = document.querySelector(".book");
      if (book && !book.dataset.curling && !document.querySelector(".leaf.hot")) return true;
      await new Promise(r => setTimeout(r, 40));
    }
    return false;
  })()`);
}
// Grab the page edge strip, pull it across by a share of the page width and
// let go. Returns the turn seen mid-drag and the page that ends up open.
async function drag(fraction, opts = {}) {
  const out = await ev(`(async () => {
    const ear = document.querySelector(${opts.back ? '"#pagePrev"' : '"#pageCorner"'});
    const page = document.querySelector(".leaf.right") || document.querySelector(".leaf");
    if (!ear || !page) return { error: "missing edge" };
    const edge = ear.getBoundingClientRect();
    const width = page.getBoundingClientRect().width;
    const x = edge.left + edge.width / 2;
    const y = edge.top + edge.height * 0.5;
    const pid = ${opts.pid || 11};
    const opts = (cx, buttons) => ({ bubbles: true, cancelable: true, pointerId: pid, pointerType: "touch", clientX: cx, clientY: y, button: 0, buttons, isPrimary: true });
    ear.dispatchEvent(new PointerEvent("pointerdown", opts(x, 1)));
    const dest = x ${opts.back ? "+" : "-"} width * ${fraction};
    window.dispatchEvent(new PointerEvent("pointermove", opts(dest, 1)));
    const leaf = document.querySelector(".leaf.hot");
    const mid = {
      hot: document.querySelectorAll(".leaf.hot").length,
      turning: !!(leaf && leaf.classList.contains("turning")),
      turn: leaf ? Number(leaf.dataset.turn) : 0,
      casts: document.querySelectorAll(".turn-cast").length,
      flip: document.querySelector(".book").dataset.flip
    };
    ${opts.hold ? `await new Promise(r => setTimeout(r, ${opts.hold}));` : ""}
    window.dispatchEvent(new PointerEvent("pointerup", opts(dest, 0)));
    return { mid };
  })()`);
  await waitIdle();
  out.flip = await ev(`document.querySelector(".book").dataset.flip`);
  out.left = await ev(`({ hot: document.querySelectorAll(".leaf.hot").length, casts: document.querySelectorAll(".turn-cast").length, shades: document.querySelectorAll(".turn-shade").length, curling: document.querySelector(".book").dataset.curling || "" })`);
  return out;
}

const snapped = await drag(0.22);
note(snapped.mid && snapped.mid.hot === 1 && snapped.mid.turning && snapped.mid.turn > 0.15 && snapped.mid.turn < 0.5, "an early drag lifts the sheet without committing", JSON.stringify(snapped));
note(snapped.flip === "0" && !snapped.left.hot && !snapped.left.casts && !snapped.left.shades && !snapped.left.curling, "releasing before the spine settles back and cleans up", JSON.stringify(snapped));

const turned = await drag(0.72);
note(turned.mid && turned.mid.turn > 0.5, "a long drag carries the sheet past upright", JSON.stringify(turned));
note(turned.flip === "1" && !turned.left.hot && !turned.left.casts, "releasing past upright completes the turn", JSON.stringify(turned));

const back = await drag(0.72, { back: true, pid: 12 });
note(back.flip === "0", "dragging from the left edge turns back a page on a phone", JSON.stringify(back));
await ev(`flipPage = 1; renderBinders()`);

await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`);
await waitIdle();
const afterRight = await ev(`(() => {
  const book = document.querySelector(".book");
  const sleeves = [...document.querySelectorAll("#bindersScroll .leaf > .face.front .sleeve")];
  const empty = sleeves.filter(el => el.classList.contains("empty"));
  return {
    flip: book && book.dataset.flip,
    empty: empty.length,
    filled: sleeves.length - empty.length,
    emptyArt: empty.filter(el => el.querySelector("img, .cardback, .toad, .art-missing")).length,
    emptyBg: empty.length ? getComputedStyle(empty[0]).backgroundColor : ""
  };
})()`);
note(afterRight.flip === "2", "ArrowRight turns to the next page", JSON.stringify(afterRight));
note(afterRight.empty === 8 && afterRight.filled === 1, "the last page keeps empty pockets", JSON.stringify(afterRight));
note(afterRight.emptyArt === 0, "empty pockets are bare sleeves: no card face, no toad", JSON.stringify(afterRight));

await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))`);
await waitIdle();
const afterLeft = await ev(`document.querySelector(".book").dataset.flip`);
note(afterLeft === "1", "ArrowLeft turns back", afterLeft);

// A quick flick turns the page even though the sheet never got upright.
await ev(`flipPage = 0; renderBinders()`);
const flick = await ev(`(async () => {
  const ear = document.querySelector("#pageCorner");
  const width = document.querySelector(".leaf.right").getBoundingClientRect().width;
  const edge = ear.getBoundingClientRect();
  const x = edge.left + edge.width / 2, y = edge.top + edge.height / 2, pid = 15;
  const o = (cx, b) => ({ bubbles: true, cancelable: true, pointerId: pid, pointerType: "touch", clientX: cx, clientY: y, button: 0, buttons: b, isPrimary: true });
  ear.dispatchEvent(new PointerEvent("pointerdown", o(x, 1)));
  let cx = x;
  for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 16)); cx -= width * 0.045; window.dispatchEvent(new PointerEvent("pointermove", o(cx, 1))); }
  const at = Number(document.querySelector(".leaf.hot").dataset.turn);
  window.dispatchEvent(new PointerEvent("pointerup", o(cx, 0)));
  return { at };
})()`);
await waitIdle();
flick.flip = await ev(`document.querySelector(".book").dataset.flip`);
note(flick.at < 0.5 && flick.flip === "1", "a quick flick turns the page", JSON.stringify(flick));

// Grab the sheet while a button turn is still in the air, pull it home.
await ev(`flipPage = 0; renderBinders()`);
await ev(`document.querySelector("#pageNext").click()`);
await sleep(60);
const stolen = await ev(`(async () => {
  const ear = document.querySelector("#pageCorner");
  const leaf = document.querySelector(".leaf.hot");
  const width = document.querySelector(".leaf.right").getBoundingClientRect().width;
  const edge = ear.getBoundingClientRect();
  const x = edge.left + edge.width / 2, y = edge.top + 8, pid = 22;
  const opts = (cx, buttons) => ({ bubbles: true, cancelable: true, pointerId: pid, pointerType: "touch", clientX: cx, clientY: y, button: 0, buttons, isPrimary: true });
  const flying = leaf ? Number(leaf.dataset.shown) : -1;
  ear.dispatchEvent(new PointerEvent("pointerdown", opts(x, 1)));
  window.dispatchEvent(new PointerEvent("pointermove", opts(x - width * 0.1, 1)));
  const during = { flying, hot: document.querySelectorAll(".leaf.hot").length, casts: document.querySelectorAll(".turn-cast").length, same: document.querySelector(".leaf.hot") === leaf, flip: document.querySelector(".book").dataset.flip };
  window.dispatchEvent(new PointerEvent("pointermove", opts(x + width * 1.5, 1)));
  const released = Number((document.querySelector(".leaf.hot") || {}).dataset.turn);
  window.dispatchEvent(new PointerEvent("pointerup", opts(x + width * 1.5, 0)));
  return { during, released };
})()`);
await waitIdle();
stolen.flip = await ev(`document.querySelector(".book").dataset.flip`);
note(stolen.during.hot === 1 && stolen.during.same && stolen.during.casts === 1 && stolen.during.flip === "0", "grabbing a sheet mid-turn keeps one sheet in hand", JSON.stringify(stolen));
note(stolen.released < 0.1 && stolen.flip === "0", "pulling it back before the spine cancels the turn", JSON.stringify(stolen));

// Tap a card: it lifts into the 3D inspect view.
await ev(`flipPage = 0; renderBinders()`);
const inspect = await ev(`(async () => {
  const hit = document.querySelector("#bindersScroll .sleeve[data-index='1'] .cardhit");
  const r = hit.getBoundingClientRect();
  const o = (t, b) => ({ bubbles: true, cancelable: true, pointerId: 31, pointerType: "touch", clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: b, isPrimary: true });
  hit.dispatchEvent(new PointerEvent("pointerdown", o("down", 1)));
  window.dispatchEvent(new PointerEvent("pointerup", o("up", 0)));
  await new Promise(r => setTimeout(r, 650));
  const root = document.getElementById("showcase");
  const card = document.getElementById("showcaseCard");
  const open = { shown: !root.hidden, isOpen: CardInspect.isOpen(), title: document.getElementById("inspectTitle").textContent, sourceHidden: getComputedStyle(hit).visibility, width: Math.round(card.getBoundingClientRect().width) };
  // Spin it with a flick.
  const c = card.getBoundingClientRect();
  const p = (x, b) => ({ bubbles: true, cancelable: true, pointerId: 32, pointerType: "touch", clientX: x, clientY: c.top + c.height / 2, button: 0, buttons: b, isPrimary: true });
  card.dispatchEvent(new PointerEvent("pointerdown", p(c.left + 40, 1)));
  for (let i = 1; i <= 6; i++) { await new Promise(r => setTimeout(r, 16)); root.dispatchEvent(new PointerEvent("pointermove", p(c.left + 40 + i * 30, 1))); }
  const spun = CardInspect.peek().ry;
  root.dispatchEvent(new PointerEvent("pointerup", p(c.left + 220, 0)));
  await new Promise(r => setTimeout(r, 60));
  const coasting = CardInspect.peek();
  await new Promise(r => setTimeout(r, 2600));
  const rest = CardInspect.peek();
  // Flip, zoom, then close with Escape.
  CardInspect.flip();
  await new Promise(r => setTimeout(r, 1600));
  const flipped = CardInspect.peek();
  const backText = document.getElementById("inspectBack").textContent;
  root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -400, clientX: 200, clientY: 300 }));
  await new Promise(r => setTimeout(r, 500));
  const zoomed = CardInspect.peek().scale;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  return { open, spun, coasting, rest, flipped, backText, zoomed, closed: root.hidden, sourceBack: getComputedStyle(document.querySelector("#bindersScroll .sleeve[data-index='1'] .cardhit")).visibility };
})()`);
note(inspect.open.shown && inspect.open.isOpen && inspect.open.title === "Card 2" && inspect.open.sourceHidden === "hidden" && inspect.open.width > 250, "tapping a card lifts it into the inspect view", JSON.stringify(inspect.open));
note(inspect.spun > 30 && inspect.coasting.mode === "spin", "a flick keeps the card spinning", JSON.stringify({ spun: inspect.spun, coasting: inspect.coasting }));
note(inspect.rest.mode === "rest" && Math.abs(inspect.rest.rx) < 0.1 && Math.abs(inspect.rest.ry % 180) < 0.1, "the spin settles flat on a face", JSON.stringify(inspect.rest));
note(inspect.flipped.back !== inspect.rest.back && /Base/.test(inspect.backText) && /Market/.test(inspect.backText), "Flip shows the back with the card's facts", JSON.stringify({ flipped: inspect.flipped, back: inspect.backText.slice(0, 80) }));
note(inspect.zoomed > 1.2, "scrolling zooms in", String(inspect.zoomed));
note(inspect.closed && inspect.sourceBack === "visible", "Escape puts the card back in its pocket", JSON.stringify(inspect));

// A tap outside the card closes it too.
const outside = await ev(`(async () => {
  const card = binderState.binders.find(b => b.id === "jungle").cards[2];
  openShowcase(card, document.querySelector("#bindersScroll .sleeve[data-index='2'] .cardhit"));
  await new Promise(r => setTimeout(r, 600));
  const root = document.getElementById("showcase");
  const o = (b) => ({ bubbles: true, cancelable: true, pointerId: 41, pointerType: "touch", clientX: 6, clientY: 6, button: 0, buttons: b, isPrimary: true });
  const stage = document.getElementById("showcaseStage");
  stage.dispatchEvent(new PointerEvent("pointerdown", o(1)));
  root.dispatchEvent(new PointerEvent("pointerup", o(0)));
  await new Promise(r => setTimeout(r, 900));
  return root.hidden;
})()`);
note(outside, "tapping outside the card closes the inspect view", String(outside));

// Swipe down to dismiss.
const swiped = await ev(`(async () => {
  const card = binderState.binders.find(b => b.id === "jungle").cards[3];
  openShowcase(card, document.querySelector("#bindersScroll .sleeve[data-index='3'] .cardhit"));
  await new Promise(r => setTimeout(r, 600));
  const root = document.getElementById("showcase");
  const c = document.getElementById("showcaseCard").getBoundingClientRect();
  const p = (y, b) => ({ bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch", clientX: c.left + c.width / 2, clientY: y, button: 0, buttons: b, isPrimary: true });
  document.getElementById("showcaseCard").dispatchEvent(new PointerEvent("pointerdown", p(c.top + 60, 1)));
  for (let i = 1; i <= 8; i++) { await new Promise(r => setTimeout(r, 16)); root.dispatchEvent(new PointerEvent("pointermove", p(c.top + 60 + i * 24, 1))); }
  root.dispatchEvent(new PointerEvent("pointerup", p(c.top + 60 + 8 * 24, 0)));
  await new Promise(r => setTimeout(r, 900));
  return root.hidden;
})()`);
note(swiped, "swiping the card down dismisses it", String(swiped));

// Card art: no CORS request, every URL is tried, and a dead card gets the
// dark binder blank, never the toad.
const art = await ev(`(async () => {
  const dead = { id: "art-dead", name: "Ghost Card", set: "Nowhere", setId: "x", number: "1", rarity: "Common", price: 2,
    img: "https://images.pokemontcg.io/zz-missing/none_hires.png", thumb: "https://images.pokemontcg.io/zz-missing/none.png" };
  const jungle = binderState.binders.find(b => b.id === "jungle");
  jungle.cards.unshift(dead);
  flipPage = 0;
  renderBinders();
  const img = document.querySelector("#bindersScroll .sleeve[data-index='0'] img");
  const first = img ? img.getAttribute("src") : "";
  const cors = img ? img.getAttribute("crossorigin") : "none";
  const start = Date.now();
  while (Date.now() - start < 8000 && !document.querySelector("#bindersScroll .sleeve[data-index='0'] .art-missing")) await new Promise(r => setTimeout(r, 50));
  const out = {
    first, cors,
    missing: !!document.querySelector("#bindersScroll .sleeve[data-index='0'] .art-missing"),
    toad: document.querySelectorAll("#bindersScroll .cardback, #bindersScroll .toad").length,
    anyCors: [...document.querySelectorAll("#bindersScroll img")].some(i => i.hasAttribute("crossorigin"))
  };
  jungle.cards.shift();
  renderBinders();
  return out;
})()`);
note(art.first.endsWith("none.png"), "the binder shows the quick preview first, then the sharp file", JSON.stringify(art));
note(art.cors === null && !art.anyCors, "binder images never request CORS", JSON.stringify(art));
note(art.missing && art.toad === 0, "a card with no reachable art shows a dark blank, not the toad", JSON.stringify(art));

await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await ev(`flipPage = 0; renderBinders(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await sleep(80);
const spread = await ev(`(() => {
  const book = document.querySelector(".book");
  const box = book.getBoundingClientRect();
  const card = document.querySelector("#bindersScroll .sleeve .cardhit").getBoundingClientRect();
  const faces = document.querySelectorAll(".book .leaf > .face.front").length;
  const filled = [...document.querySelectorAll("#bindersScroll .leaf > .face.front .sleeve")].filter(el => !el.classList.contains("empty")).length;
  return { layout: book && book.dataset.layout, flip: book && book.dataset.flip, faces, filled, w: Math.round(box.width), h: Math.round(box.height), cardH: Math.round(card.height), wide: document.getElementById("shell").classList.contains("reading-wide"), side: getComputedStyle(document.getElementById("profile")).display };
})()`);
note(spread.layout === "spread" && spread.faces >= 2 && spread.filled === 18, "desktop shows a two-page spread", JSON.stringify(spread));
note(spread.wide && spread.side === "none" && spread.w >= 1000 && spread.h >= 680 && spread.cardH >= 190, "the open binder fills a 1440x900 screen", JSON.stringify(spread));

const deskControls = await ev(`(() => {
  const ears = [...document.querySelectorAll("#pagePrev, #pageCorner")];
  const buttons = [...document.querySelectorAll("#bindersScroll .leaf > .face.front .gotbtn, #bindersScroll .leaf > .face.front .iconish.more")];
  const overlap = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
  let hits = 0;
  let aimed = 0;
  let blocked = 0;
  buttons.forEach(btn => {
    const r = btn.getBoundingClientRect();
    if (r.width < 1) return;
    ears.forEach(ear => { if (overlap(r, ear.getBoundingClientRect())) hits++; });
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
    aimed++;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || (hit !== btn && !btn.contains(hit))) blocked++;
  });
  return { hits, blocked, aimed, widths: ears.map(ear => Math.round(ear.getBoundingClientRect().width)) };
})()`);
note(deskControls.hits === 0 && deskControls.blocked === 0 && deskControls.aimed > 0 && deskControls.widths.every(w => w > 0 && w <= 20), "desktop card controls stay clear of the page edges", JSON.stringify(deskControls));

const desk = await drag(1.2);
note(desk.mid.casts === 2 && desk.flip === "2", "desktop: pulling the sheet over the spine turns the spread", JSON.stringify(desk));
const deskBack = await drag(1.2, { back: true, pid: 13 });
note(deskBack.flip === "0", "desktop: pulling the left sheet over turns back", JSON.stringify(deskBack));
const deskSnap = await drag(0.5);
note(deskSnap.flip === "0" && !deskSnap.left.hot, "desktop: letting go before the spine settles back", JSON.stringify(deskSnap));

const sidePanel = await ev(`(() => {
  const card = binderState.binders.find(b => b.id === "jungle").cards[1];
  openProfile(card);
  const open = { wide: document.getElementById("shell").classList.contains("reading-wide"), side: getComputedStyle(document.getElementById("profile")).display };
  closeProfile();
  const closed = { wide: document.getElementById("shell").classList.contains("reading-wide") };
  return { open, closed };
})()`);
note(!sidePanel.open.wide && sidePanel.open.side !== "none" && sidePanel.closed.wide, "Details brings the side panel back, closing it gives the binder the room again", JSON.stringify(sidePanel));

const membership = await ev(`(() => {
  const shared = "bh-0";
  const jungle = binderState.binders.find(b => b.id === "jungle");
  const water = binderState.binders.find(b => b.id === "water");
  const before = jungle.cards.some(c => c.id === shared) && water.cards.some(c => c.id === shared) && wish.some(c => c.id === shared);
  removeFromBinder(jungle, shared);
  const after = {
    wish: wish.some(c => c.id === shared),
    water: water.cards.some(c => c.id === shared),
    jungle: jungle.cards.some(c => c.id === shared),
    storedWish: JSON.parse(localStorage.getItem("binderhuntWish")).some(c => c.id === shared),
    storedWater: JSON.parse(localStorage.getItem("bh.binders.v1")).binders.find(b => b.id === "water").cards.some(c => c.id === shared)
  };
  return { before, after };
})()`);
note(membership.before, "one card starts in the wishlist and two binders", JSON.stringify(membership));
note(membership.after.wish && membership.after.water && !membership.after.jungle && membership.after.storedWish && membership.after.storedWater, "removing from one binder keeps the wishlist and the other binder", JSON.stringify(membership.after));

await ev(`(() => {
  const jungle = binderState.binders.find(b => b.id === "jungle");
  jungle.cards = ${JSON.stringify(cards)};
  flipPage = 2; renderBinders();
})()`);
await sleep(40);
const lastSpread = await ev(`(() => {
  const book = document.querySelector(".book");
  return {
    layout: book && book.dataset.layout,
    flip: book && book.dataset.flip,
    nums: [...document.querySelectorAll(".leaf > .face.front .page-num")].map(n => n.textContent),
    foot: document.querySelector(".pagefoot").textContent,
    options: [...document.querySelectorAll("#jumpPage option")].map(o => o.textContent),
    sheets: [...document.querySelectorAll(".dots button")].map(b => b.dataset.sheet),
    emptyRight: document.querySelectorAll(".leaf.right > .face.front .sleeve.empty").length
  };
})()`);
note(lastSpread.layout === "spread" && lastSpread.flip === "2" && lastSpread.nums.join(",") === "3,4" && lastSpread.emptyRight === 9, "the last spread keeps a numbered blank facing page", JSON.stringify(lastSpread));
note(lastSpread.foot.includes("Page 3–4") && lastSpread.options.join("|") === "Page 1–2|Page 3–4" && lastSpread.sheets.join(",") === "0,2", "the footer and picker name the whole spread", JSON.stringify(lastSpread));

const stuck = await drag(1.2, { pid: 23 });
note(stuck.flip === "2" && !stuck.mid.hot, "the blank facing page cannot turn past the end", JSON.stringify(stuck));

await ev(`(() => {
  const jungle = binderState.binders.find(b => b.id === "jungle");
  jungle.cards = jungle.cards.slice(0, 5);
  flipPage = 0;
  renderBinders();
})()`);
await sleep(40);
const shortSpread = await ev(`(() => {
  const left = document.querySelector(".leaf.left");
  return {
    nums: [...document.querySelectorAll(".leaf > .face.front .page-num")].map(n => n.textContent),
    foot: document.querySelector(".pagefoot").textContent,
    options: [...document.querySelectorAll("#jumpPage option")].map(o => o.textContent),
    filled: left ? [...left.querySelectorAll(":scope > .face.front .sleeve")].filter(el => !el.classList.contains("empty")).length : -1,
    emptyRight: document.querySelectorAll(".leaf.right > .face.front .sleeve.empty").length
  };
})()`);
note(shortSpread.nums.join(",") === "1,2" && shortSpread.foot.includes("Page 1–2") && shortSpread.options.join("|") === "Page 1–2" && shortSpread.filled === 5 && shortSpread.emptyRight === 9, "a short binder still shows the facing empty page as page 2", JSON.stringify(shortSpread));
const shortDrag = await drag(1.2, { pid: 24 });
note(shortDrag.flip === "0" && !shortDrag.mid.hot, "a one-page spread cannot turn onto the blank page", JSON.stringify(shortDrag));

// Reduced motion: turns and the inspect view jump instead of animating.
const calm = await ev(`(async () => {
  settings.reduce = "on"; applyMotion();
  const jungle = binderState.binders.find(b => b.id === "jungle");
  jungle.cards = ${JSON.stringify(cards)};
  flipPage = 0; renderBinders();
  document.querySelector("#pageNext").click();
  const flip = document.querySelector(".book").dataset.flip;
  const hit = document.querySelector("#bindersScroll .sleeve[data-index='18'] .cardhit") || document.querySelector("#bindersScroll .sleeve .cardhit");
  openShowcase(jungle.cards[18], hit);
  const anims = document.getAnimations().filter(a => a.playState === "running").length;
  CardInspect.flip();
  const back = CardInspect.peek().back;
  closeShowcase();
  const closed = document.getElementById("showcase").hidden;
  settings.reduce = "off"; applyMotion();
  return { flip, anims, back, closed };
})()`);
note(calm.flip === "2" && calm.anims === 0 && calm.back && calm.closed, "reduced motion turns pages and flips cards without animation", JSON.stringify(calm));

const noise = errors.filter(line => !/ERR_|Failed to load resource|net::|favicon/i.test(line));
note(!noise.length, "no console errors", noise.slice(0, 6).join(" | "));

if (problems.length) {
  console.log(problems.join("\n"));
  shutdown(1);
}
console.log("binder tests passed");
shutdown(0);
