// Simulates TCGdex refusing card-detail fetches and checks a Scyther hunt
// still finishes with the same matches as an unthrottled run.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8772;
const CDP = 9225;
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: "/workspace", stdio: "ignore" });
const chrome = spawn("google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--remote-debugging-port=" + CDP, "--user-data-dir=/tmp/chrome-throttle-hunt", "about:blank"
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
});
async function ev(expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result.result.value;
}
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
const boot = `localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
localStorage.setItem("binderhuntWish","[]");
localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));`;
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: boot });
await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/index.html" });
await sleep(800);
await ev(`new Promise((resolve, reject) => {
  const start = Date.now();
  const t = setInterval(() => {
    if (typeof meta !== "undefined" && meta.ready) { clearInterval(t); resolve(true); }
    else if (Date.now() - start > 20000) { clearInterval(t); reject(new Error("catalog metadata did not load")); }
  }, 50);
})`);
await ev(`generation++; loading = false;`);

const policy = await ev(`(() => {
  const saved = { briefs: briefs.slice(), deferred: deferred.slice(), deferredPass, fails: [...fetchFails.entries()] };
  briefs = []; deferred = []; deferredPass = false; fetchFails.clear();
  const card = { id: "ex7-102" };
  const again = () => { const where = parkThrottled(card); briefs = briefs.filter(b => b !== card); return where; };
  const first = [again(), again(), again()];
  const parked = again();
  const flushed = reclaimDeferred();
  const second = reclaimDeferred();
  const dropped = parkThrottled(card);
  briefs = saved.briefs; deferred = saved.deferred; deferredPass = saved.deferredPass;
  fetchFails.clear(); saved.fails.forEach(([k, v]) => fetchFails.set(k, v));
  return { first, parked, flushed, onQueue: card.finalTry === true, second, dropped };
})()`);
if (policy.first.join(",") !== "requeue,requeue,requeue" || policy.parked !== "defer" || !policy.flushed || !policy.onQueue || policy.second || policy.dropped !== "drop") {
  throw new Error("retry policy mismatch " + JSON.stringify(policy));
}
console.log("policy", JSON.stringify(policy));

async function drain(label) {
  const kept = [];
  const seenIds = new Set();
  let lastSig = "";
  let stillSince = Date.now();
  let lastLog = 0;
  const start = Date.now();
  while (Date.now() - start < 240000) {
    const info = await ev(`(() => {
      const p = document.querySelector("#deck .empty-state p");
      const c = pile.find(x => x && !reserved.has(x.id));
      return {
        text: p ? p.textContent : "",
        status: deck.dataset.status || "",
        matched, streamDone, loading, catalogBusy, serial: pullSerial,
        pile: pile.length, briefs: briefs.length, deferred: deferred.length,
        holdFeed, feedExhausted, busy: busyBlock(),
        card: c ? { id: c.id, name: c.name } : null,
        hits: window.__throttleHits || null
      };
    })()`);
    if (info.text === "No cards match yet.") throw new Error(label + " said no cards match yet after " + info.matched);
    if (info.text === "Still matching cards.") throw new Error(label + " paused early after " + info.matched);
    if (info.text === "No more cards match.") {
      if (!info.matched) throw new Error(label + " finished with zero matches");
      return { matched: info.matched, kept, hits: info.hits, ms: Date.now() - start };
    }
    if (info.card) {
      if (!seenIds.has(info.card.id)) {
        seenIds.add(info.card.id);
        kept.push(info.card);
      }
      await ev(`document.getElementById("skip").click()`);
      stillSince = Date.now();
      await sleep(30);
      continue;
    }
    const sig = [info.serial, info.matched, info.pile, info.briefs, info.deferred, info.text].join(":");
    const busy = info.catalogBusy || info.busy || /busy|shuffling|Looking/i.test(info.text) || info.loading;
    if (sig !== lastSig) { lastSig = sig; stillSince = Date.now(); }
    else if (!busy && Date.now() - stillSince > 4000) {
      throw new Error(label + " stalled " + JSON.stringify({ status: info.status, matched: info.matched, serial: info.serial, feedExhausted: info.feedExhausted, holdFeed: info.holdFeed, pile: info.pile, briefs: info.briefs, deferred: info.deferred, text: info.text }));
    }
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      console.log(label, "waiting", JSON.stringify({ matched: info.matched, pile: info.pile, briefs: info.briefs, deferred: info.deferred, text: info.text, busy: info.catalogBusy }));
    }
    await sleep(200);
  }
  throw new Error(label + " timed out");
}

function startScyther() {
  return ev(`(() => {
    filters = blankFilters();
    filters.names = ["Scyther"];
    filters.pricePreset = "";
    restart();
    return true;
  })()`);
}

console.log("baseline Scyther");
await startScyther();
const baseline = await drain("baseline");
const baseIds = baseline.kept.map(c => c.id).sort();
console.log("baseline", baseline.matched, "cards in", baseline.ms + "ms", baseIds.join(" "));
const wanted = ["ex7-102", "sm7-4", "ex10-46", "base4-17"];
const missingBase = wanted.filter(id => !baseIds.includes(id));
if (missingBase.length) throw new Error("baseline Scyther hunt is missing " + missingBase.join(", "));
const rocket = baseline.kept.find(c => c.id === "ex7-102");
if (!/scyther/i.test(rocket.name)) throw new Error("ex7-102 was " + rocket.name);

console.log("throttled Scyther");
await ev(`(() => {
  window.__origFetch = window.__origFetch || fetch;
  const orig = window.__origFetch;
  const limits = { "ex7-102": 12, "sm7-4": 6, "ex10-46": 6, "base4-17": 6 };
  window.__throttleHits = {};
  cardCache.clear();
  window.fetch = (url, opts) => {
    const match = String(url).match(/\\/cards\\/([^/?#]+)$/);
    const id = match && decodeURIComponent(match[1]);
    if (id && limits[id]) {
      window.__throttleHits[id] = (window.__throttleHits[id] || 0) + 1;
      if (window.__throttleHits[id] <= limits[id]) return Promise.resolve(new Response("", { status: 429, statusText: "Too Many Requests" }));
    }
    return orig(url, opts);
  };
  return true;
})()`);
await startScyther();
const throttled = await drain("throttled");
const throttledIds = throttled.kept.map(c => c.id).sort();
console.log("throttled", throttled.matched, "cards in", throttled.ms + "ms");
console.log("refusals", JSON.stringify(throttled.hits));
const onlyBase = baseIds.filter(id => !throttledIds.includes(id));
const onlyThrottled = throttledIds.filter(id => !baseIds.includes(id));
if (onlyBase.length || onlyThrottled.length) {
  throw new Error("hunt sets diverged missing=" + onlyBase.join(",") + " extra=" + onlyThrottled.join(","));
}
for (const id of wanted) {
  const hits = (throttled.hits && throttled.hits[id]) || 0;
  const need = id === "ex7-102" ? 12 : 6;
  if (hits < need) throw new Error(id + " was only refused " + hits + " times");
  if (!throttledIds.includes(id)) throw new Error(id + " dropped out of the throttled hunt");
}
if (throttled.matched !== baseline.matched) throw new Error("matched " + throttled.matched + " vs baseline " + baseline.matched);
if (errors.length) throw new Error("console exceptions: " + errors.join(" | "));
console.log("ok", throttled.matched, "matches including", wanted.join(", "));
shutdown(0);
