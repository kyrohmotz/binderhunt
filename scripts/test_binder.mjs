// Showcase binder: drag past halfway turns the page, an early release snaps
// back, arrow keys turn pages, empty pockets stay in the grid, and a card
// can live in more than one binder without leaving the wishlist.
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
function cleanup() {
  try { chrome.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
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
async function waitPort() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch("http://127.0.0.1:" + CDP + "/json/version"); if (r.ok) return; } catch (e) {}
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
  const sleeves = [...document.querySelectorAll("#bindersScroll .sleeve")];
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
    pages: document.querySelectorAll(".page-num").length
  };
})()`);
note(opened.layout === "solo" && opened.flip === "0", "phone shows one page", JSON.stringify(opened));
note(opened.filled === 9 && opened.empty === 0, "first phone page is a full 3x3", JSON.stringify(opened));
note(opened.holo, "holo card keeps its sleeve class", JSON.stringify(opened));
note(opened.pill === "$4.4K", "price pill uses the compact showcase format", opened.pill);
note(opened.pages === 1, "a phone page has one page number", String(opened.pages));

async function drag(fraction) {
  return ev(`(async () => {
    const ear = document.querySelector("#pageCorner");
    const leaf = document.querySelector(".leaf.right") || document.querySelector(".leaf");
    if (!ear || !leaf) return { error: "missing edge" };
    const edge = ear.getBoundingClientRect();
    const box = leaf.getBoundingClientRect();
    const x = edge.left + edge.width / 2;
    const y = edge.top + Math.min(edge.height - 4, Math.max(4, edge.height * 0.5));
    const pid = 11;
    const opts = (type, cx, buttons) => ({ bubbles: true, cancelable: true, pointerId: pid, pointerType: "touch", clientX: cx, clientY: y, button: 0, buttons, isPrimary: true });
    ear.dispatchEvent(new PointerEvent("pointerdown", opts("pointerdown", x, 1)));
    const dest = x - box.width * ${fraction};
    window.dispatchEvent(new PointerEvent("pointermove", opts("pointermove", dest, 1)));
    const mid = {
      hot: !!document.querySelector(".leaf.hot"),
      curl: !!document.querySelector(".curl-view, .leaf.hot.fallback"),
      turn: leaf.style.getPropertyValue("--turn"),
      flip: document.querySelector(".book").dataset.flip
    };
    window.dispatchEvent(new PointerEvent("pointerup", opts("pointerup", dest, 0)));
    const start = Date.now();
    let flip = document.querySelector(".book").dataset.flip;
    while (Date.now() - start < 1600) {
      await new Promise(r => setTimeout(r, 40));
      const book = document.querySelector(".book");
      if (!book) break;
      flip = book.dataset.flip;
      if (!book.dataset.curling && !document.querySelector(".leaf.hot")) break;
    }
    const book = document.querySelector(".book");
    return { mid, flip: book ? book.dataset.flip : flip, curling: book ? book.dataset.curling || "" : "gone" };
  })()`);
}

const snapped = await drag(0.22);
note(snapped.mid && snapped.mid.hot && Number(snapped.mid.turn) > 0.15 && Number(snapped.mid.turn) < 0.5, "early drag curls without committing", JSON.stringify(snapped));
note(snapped.flip === "0" && !snapped.curling, "releasing before halfway snaps back", JSON.stringify(snapped));

const turned = await drag(0.72);
note(turned.mid && Number(turned.mid.turn) > 0.5, "a long drag passes halfway", JSON.stringify(turned));
note(turned.flip === "1" && !turned.curling, "releasing past halfway completes the turn", JSON.stringify(turned));

await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`);
await ev(`(async () => { const start = Date.now(); while (Date.now() - start < 1600) { const book = document.querySelector(".book"); if (book && book.dataset.flip === "2" && !book.dataset.curling) return; await new Promise(r => setTimeout(r, 40)); } })()`);
const afterRight = await ev(`(() => {
  const book = document.querySelector(".book");
  const empty = document.querySelectorAll("#bindersScroll .sleeve.empty").length;
  const filled = [...document.querySelectorAll("#bindersScroll .sleeve")].filter(el => !el.classList.contains("empty")).length;
  return { flip: book && book.dataset.flip, empty, filled };
})()`);
note(afterRight.flip === "2", "ArrowRight turns to the next page", JSON.stringify(afterRight));
note(afterRight.empty === 8 && afterRight.filled === 1, "the last page keeps empty pockets", JSON.stringify(afterRight));

await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))`);
await ev(`(async () => { const start = Date.now(); while (Date.now() - start < 1600) { const book = document.querySelector(".book"); if (book && book.dataset.flip === "1" && !book.dataset.curling) return; await new Promise(r => setTimeout(r, 40)); } })()`);
const afterLeft = await ev(`document.querySelector(".book").dataset.flip`);
note(afterLeft === "1", "ArrowLeft turns back", afterLeft);

await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await ev(`flipPage = 0; renderBinders(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
await sleep(80);
const spread = await ev(`(() => {
  const book = document.querySelector(".book");
  const faces = document.querySelectorAll(".book .face").length;
  const filled = [...document.querySelectorAll("#bindersScroll .sleeve")].filter(el => !el.classList.contains("empty")).length;
  return { layout: book && book.dataset.layout, flip: book && book.dataset.flip, faces, filled };
})()`);
note(spread.layout === "spread" && spread.faces >= 2 && spread.filled === 18, "desktop shows a two-page spread", JSON.stringify(spread));

const desk = await drag(0.7);
note(desk.flip === "2", "desktop drag past halfway turns the spread", JSON.stringify(desk));

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

const noise = errors.filter(line => !/ERR_|Failed to load resource|net::|favicon/i.test(line));
note(!noise.length, "no console errors", noise.slice(0, 6).join(" | "));

if (problems.length) {
  console.log(problems.join("\n"));
  shutdown(1);
}
console.log("binder tests passed");
shutdown(0);
