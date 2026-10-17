// Regression checks for owned-collection fixes:
// 1. Filling or saving into a binder does not celebrate. Marking the last
//    wanted card does, including a one-card binder going 0/1 to 1/1.
//    Undo then Got it again stays quiet.
// 2. A long press or a sloppy press on .gotbtn does not toggle owned, and a
//    long press still starts a pocket drag.
// 3. Set owned counts only include ids in the set's card list and the
//    displayed fraction is clamped. Set celebration waits until that list
//    is loaded, so planted ids cannot complete the set early.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof WebSocket !== "function") {
  throw new Error("test_owned_regressions.mjs requires Node.js 22+ (global WebSocket).");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8774;
const CDP = 9227;
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const chrome = spawn("google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--remote-debugging-port=" + CDP, "--user-data-dir=/tmp/chrome-owned-regress", "about:blank"
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 1200));
  return result.result.value;
}
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width:390, height:844, deviceScaleFactor:1, mobile:true });
const boot = `localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
localStorage.setItem("binderhuntWish","[]");
localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));
localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));`;
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: boot });
await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/index.html" });
await sleep(600);
await ev(`new Promise((resolve, reject) => {
  const start = Date.now();
  const t = setInterval(() => {
    if (typeof meta !== "undefined" && meta.ready) { clearInterval(t); resolve(true); }
    else if (Date.now() - start > 20000) { clearInterval(t); reject(new Error("catalog metadata did not load")); }
  }, 50);
})`);

const report = await ev(`(async () => {
  const fails = [];
  const check = (name, ok, extra) => { if (!ok) fails.push(name + (extra ? " — " + extra : "")); };
  suppressGotClickUntil = 0;
  const now = 100000;
  check("short press kept", gotPressIgnored({ t:now - 100, x:0, y:0, d:0 }, now, 0, 0) === false);
  check("450ms kept", gotPressIgnored({ t:now - 450, x:0, y:0, d:0 }, now, 0, 0) === false);
  check("451ms ignored", gotPressIgnored({ t:now - 451, x:0, y:0, d:0 }, now, 0, 0) === true);
  check("800ms ignored", gotPressIgnored({ t:now - 800, x:4, y:4, d:0 }, now, 4, 4) === true);
  check("8px kept", gotPressIgnored({ t:now - 80, x:0, y:0, d:8 }, now, 0, 0) === false);
  check("over 8px ignored", gotPressIgnored({ t:now - 80, x:0, y:0, d:0 }, now, 9, 0) === true);
  check("suppress ignored", gotPressIgnored({ t:now - 20, x:0, y:0, d:0, suppress:true }, now, 0, 0) === true);
  check("keyboard press kept", gotPressIgnored(null, now, 0, 0) === false);

  const notes = [];
  showConfetti = m => notes.push(String(m));
  ownedNeedsSeed = false;
  tab = "hunt";
  celebrated.clear();
  ownedIds.clear();
  ownedSetById.clear();
  const ownedCard = { id:"zz-a", name:"Alpha", setId:"zztest", rarity:"Rare Holo" };
  const wantedCard = { id:"zz-b", name:"Beta", setId:"zztest", rarity:"Common" };
  ownedIds.add(ownedCard.id);
  const empty = { id:"bempty", name:"Empty", color:"#E9D5C0", cards:[], theme:{ kind:"none" }, charm:"none" };
  binderState.binders = [empty];
  addToBinder(empty, ownedCard);
  check("empty binder add does not celebrate", notes.length === 0 && !celebrated.has("binder:bempty"), notes.join("|"));

  notes.length = 0;
  celebrated.clear();
  const fill = { id:"bfill", name:"Fill", color:"#F3EDC8", cards:[], theme:{ kind:"none" }, charm:"none" };
  binderState.binders = [fill];
  const picked = [ownedCard, wantedCard];
  const selected = new Set(picked.map(c => c.id));
  let added = 0;
  picked.forEach(card => { if (selected.has(card.id) && addToBinder(fill, card)) added++; });
  const mid = progressOf(fill.cards);
  check("fill adds both", added === 2 && mid.owned === 1 && mid.total === 2, JSON.stringify(mid));
  check("fill does not celebrate or burn the key", notes.length === 0 && !celebrated.has("binder:bfill"), notes.join("|"));
  setOwned(wantedCard, true, "pocket");
  check("real completion celebrates once", notes.some(m => m.indexOf("Fill is complete.") >= 0) && celebrated.has("binder:bfill"), notes.join("|"));
  notes.length = 0;
  ownedIds.delete(wantedCard.id);
  setOwned(wantedCard, true, "pocket");
  check("second completion stays quiet", notes.length === 0, notes.join("|"));

  notes.length = 0;
  celebrated.clear();
  ownedIds.delete(wantedCard.id);
  const solo = { id:"bsolo", name:"Solo", color:"#E9D5C0", cards:[wantedCard], theme:{ kind:"none" }, charm:"none" };
  binderState.binders = [solo];
  setOwned(wantedCard, true, "pocket");
  check("one-card binder celebrates", notes.some(m => m.indexOf("Solo is complete.") >= 0) && celebrated.has("binder:bsolo"), notes.join("|"));
  notes.length = 0;
  ownedIds.delete(wantedCard.id);
  setOwned(wantedCard, true, "pocket");
  check("one-card redo stays quiet", notes.length === 0 && celebrated.has("binder:bsolo"), notes.join("|"));

  if (!meta.sets.some(s => s.id === "zzset")) meta.sets.push({ id:"zzset", name:"Test Set", cardCount:{ official:3, total:3 } });
  const list = [{ id:"zzset-1" }, { id:"zzset-2" }, { id:"zzset-3" }];
  ownedIds.clear();
  ownedSetById.clear();
  ["zzset-1","zzset-2","zzset-3","zzset-extra"].forEach(id => { ownedIds.add(id); ownedSetById.set(id, "zzset"); });
  const total = setTotal(meta.sets.find(s => s.id === "zzset"));
  const matched = countOwnedInSet("zzset", list);
  const shown = clampedOwned(matched, total);
  check("list count ignores ids outside the set", matched === 3 && total === 3, "matched " + matched + " total " + total);
  check("display clamps", shown + " / " + total === "3 / 3", shown + " / " + total);
  setView = null;
  setLists.delete("zzset");
  celebrated.delete("set:zzset");
  check("overcount without a list does not burn celebration", noteSet("zzset") === "" && !celebrated.has("set:zzset"));
  ownedIds.clear();
  ownedSetById.clear();
  ["zzset-plant-1", "zzset-plant-2", "zzset-plant-3"].forEach(id => { ownedIds.add(id); ownedSetById.set(id, "zzset"); });
  ownedIds.add("base4-not-a-card");
  setLists.delete("base4");
  if (setView && setView.id === "base4") setView = null;
  check("prefix id is not counted before the list loads", countOwnedInSet("base4") === 0);
  check("planted ids do not celebrate before the list loads", noteSet("zzset") === "" && !celebrated.has("set:zzset"));
  setLists.set("zzset", { cards:list, release:"", name:"Test Set" });
  check("out-of-set ids do not complete a loaded set", noteSet("zzset") === "" && !celebrated.has("set:zzset"));
  ["zzset-1","zzset-2","zzset-3","zzset-extra"].forEach(id => { ownedIds.add(id); ownedSetById.set(id, "zzset"); });
  setLists.set("zzset", { cards:list, release:"", name:"Test Set" });
  const msg = noteSet("zzset");
  check("celebration uses the list count", msg.indexOf("Test Set is complete.") >= 0 && celebrated.has("set:zzset"), msg);
  celebrated.delete("set:zzset");
  ownedIds.delete("zzset-3");
  check("missing list card does not celebrate", noteSet("zzset") === "" && !celebrated.has("set:zzset"));
  check("missing list card stays under the total", clampedOwned(countOwnedInSet("zzset", list), total) === 2);
  ownedIds.add("zzset-3");
  setView = { id:"zzset", name:"Test Set", cards:list, release:"", loading:false, mode:"flip" };
  tab = "sets";
  renderSets();
  const line = (document.getElementById("setProgress") || {}).textContent || "";
  check("set page never shows owned above the total", line.indexOf("4 / 3") < 0 && line.indexOf("3 / 3") >= 0, line);

  const pocket = { id:"jungle-4", name:"Charizard", setId:"base2", rarity:"Rare Holo", number:"4" };
  ownedIds.delete(pocket.id);
  const binder = { id:"bpress", name:"Press", color:"#86DEFF", cards:[pocket], theme:{ kind:"none" }, charm:"none" };
  binderState.binders = [binder];
  binderView = { kind:"binder", id:"bpress" };
  flipPage = 1;
  suppressGotClickUntil = 0;
  showTab("binders");
  const btn = document.querySelector(".gotbtn");
  const sleeve = document.querySelector(".sleeve");
  check("wanted holo keeps tilt class", !!(sleeve && sleeve.classList.contains("wanted") && sleeve.classList.contains("holo")));
  const rect = btn ? btn.getBoundingClientRect() : { width:0, height:0 };
  const mark = btn ? btn.querySelector(".mark").getBoundingClientRect() : { width:0 };
  check("got it hit area is at least 32px", rect.width >= 32 && rect.height >= 32, rect.width + "x" + rect.height);
  check("got it badge stays compact", rect.width <= 40 && mark.width > 0 && mark.width <= 20, "btn " + rect.width + " mark " + mark.width);
  const point = (type, x, y) => btn.dispatchEvent(new PointerEvent(type, { bubbles:true, cancelable:true, clientX:x, clientY:y, pointerId:1, pointerType:"touch", isPrimary:true, button:0, buttons:type === "pointerup" ? 0 : 1 }));
  const clickAt = (x, y) => btn.dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true, clientX:x, clientY:y, detail:1 }));
  const box = btn.getBoundingClientRect();
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  point("pointerdown", x, y);
  point("pointermove", x + 20, y);
  await new Promise(r => setTimeout(r, 40));
  const slidGhost = !!document.querySelector(".ghost");
  point("pointerup", x + 20, y);
  clickAt(x + 20, y);
  check("sloppy press does not own", !ownedIds.has(pocket.id) && !slidGhost);

  const again = document.querySelector(".gotbtn");
  const box2 = again.getBoundingClientRect();
  const x2 = box2.left + box2.width / 2, y2 = box2.top + box2.height / 2;
  const point2 = (type, cx, cy) => again.dispatchEvent(new PointerEvent(type, { bubbles:true, cancelable:true, clientX:cx, clientY:cy, pointerId:1, pointerType:"touch", isPrimary:true, button:0, buttons:type === "pointerup" ? 0 : 1 }));
  point2("pointerdown", x2, y2);
  await new Promise(r => setTimeout(r, 800));
  const heldGhost = !!document.querySelector(".ghost");
  point2("pointerup", x2, y2);
  again.dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true, clientX:x2, clientY:y2, detail:1 }));
  check("long press starts a pocket drag", heldGhost);
  check("long press does not own", !ownedIds.has(pocket.id));
  await new Promise(r => setTimeout(r, 520));
  suppressGotClickUntil = 0;
  const tap = document.querySelector(".gotbtn");
  const box3 = tap.getBoundingClientRect();
  const x3 = box3.left + box3.width / 2, y3 = box3.top + box3.height / 2;
  const point3 = (type, cx, cy) => tap.dispatchEvent(new PointerEvent(type, { bubbles:true, cancelable:true, clientX:cx, clientY:cy, pointerId:1, pointerType:"touch", isPrimary:true, button:0, buttons:type === "pointerup" ? 0 : 1 }));
  point3("pointerdown", x3, y3);
  await new Promise(r => setTimeout(r, 40));
  point3("pointerup", x3, y3);
  tap.dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true, clientX:x3, clientY:y3, detail:1 }));
  check("short tap owns", ownedIds.has(pocket.id));
  return fails;
})()`);

if (errors.length) console.log("page exceptions:", errors.slice(0, 8).join("\n"));
const fails = Array.isArray(report) ? report : ["test did not return a list: " + JSON.stringify(report)];
if (fails.length) {
  console.log("FAILED\n" + fails.join("\n"));
  shutdown(1);
}
console.log("owned regressions ok");
shutdown(0);
