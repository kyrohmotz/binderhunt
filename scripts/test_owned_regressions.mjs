// Regression checks for owned-collection fixes:
// 1. Filling or saving into a binder does not celebrate. Marking the last
//    wanted card does, including a one-card binder going 0/1 to 1/1.
//    Undo then Got it again stays quiet.
// 2. A long press or a sloppy press on .gotbtn does not toggle owned, and a
//    long press still starts a pocket drag.
// 3. Set owned counts only include ids in the set's card list and the
//    displayed fraction is clamped. A binder celebration shows immediately.
//    The set list is given about 1.5s to join that toast; a later confirmation
//    is its own follow-up. Planted ids do not celebrate early. A failed set
//    list fetch is not cached empty.
// 4. After the set catalog loads, owned ids with no saved set id are
//    backfilled so their set tile is not stuck at 0%.
// 5. A hunt whose catalog request never returns shows busy/retrying from
//    that request's own timeout and keeps trying. The watchdog does not abort
//    a request that is still inside its timeout, so a slow reply is no slower
//    than a hunt with the watchdog disarmed. A missing set list retries after
//    its backoff and then stops. A dropped batch is requeued. A hunt abort
//    does not cancel a profile set request. A set line that joins a toast
//    keeps that toast up.
// 6. After Skip, focus stays on the hunt and ArrowLeft, ArrowRight, and Z
//    still work. The same check runs at 390 and 1440. A select is a typing
//    target, and those hunt keys do nothing while Settings is open. Digits
//    and arrows in the daily guess field do not hunt, and hunt keys stay
//    inert while Today's Drop or the Daily view is open.
// 7. A desktop deep link (?card=base1-4) keeps that profile pinned after the
//    hunt deck loads. One Skip then replaces it with the new top card.
//    #deck is not read until that element is in the document. Each run gets
//    its own Chrome profile and debugging port, so another browser cannot
//    answer the probe.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

if (typeof WebSocket !== "function") {
  throw new Error("test_owned_regressions.mjs requires Node.js 22+ (global WebSocket).");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8774;
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
const profileDir = mkdtempSync(join(tmpdir(), "chrome-owned-"));
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
localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
})();`;
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: boot });
async function waitForDeck() {
  const start = Date.now();
  let last = "deck was not ready";
  while (Date.now() - start < 20000) {
    try {
      const ready = await ev(`(() => {
        const deck = document.getElementById("deck");
        return !!(deck && typeof renderDeck === "function" && typeof meta !== "undefined" && meta.ready);
      })()`);
      if (ready) return;
    } catch (e) {
      last = String(e && e.message || e);
    }
    await sleep(200);
  }
  throw new Error(last);
}
await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/index.html" });
await waitForDeck();

const keyScript = `(async () => {
  const problems = [];
  const note = (ok, name, extra) => { if (!ok) problems.push(name + (extra ? " — " + extra : "")); };
  settings.haptics = true;
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
  showTab("hunt");
  syncActs();
  generation++;
  loading = true;
  clearHuntWatch();
  huntInflight.forEach(job => job.ctrl.abort());
  huntInflight.clear();
  streamDone = true;
  paused = false;
  catalogBusy = false;
  busyHold = false;
  busyUntil = 0;
  pumpError = "";
  undoStack = [];
  wish = [];
  saveWish();
  reserved = new Set();
  pendingSwipes = [];
  swipeBusy = false;
  const art = "https://assets.tcgdex.net/en/base/base1/58";
  pile = [1, 2, 3, 4].map(n => ({ id:"key-" + n, name:"Key " + n, set:"Base", setId:"base1", number:String(n), rarity:"Common", img:art + "/high.webp", thumb:art + "/low.webp" }));
  matched = pile.length;
  deck.innerHTML = "";
  renderDeck();
  const skip = document.getElementById("skip");
  const save = document.getElementById("save");
  const box = skip.getBoundingClientRect();
  note(box.width >= 44 && box.height >= 44 && box.top >= 0 && box.bottom <= window.innerHeight + 1, "skip is on screen", Math.round(box.width) + "x" + Math.round(box.height) + " @" + Math.round(box.top));
  note(!skip.querySelector("label") && !save.querySelector("label"), "skip and save have no haptic label");
  note(!skip.disabled && !save.disabled, "skip and save are enabled");
  skip.click();
  const focus = document.activeElement;
  note(focus !== document.getElementById("hapticSwitch"), "skip does not focus the haptic switch", focus && (focus.id || focus.tagName));
  note(focus === skip || focus === deck, "focus stays on skip or the deck", focus && (focus.id || focus.tagName));
  note(pile.map(c => c.id).join(",") === "key-2,key-3,key-4", "skip click passes the top card", pile.map(c => c.id).join(","));
  const press = key => (document.activeElement || document).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles:true, cancelable:true }));
  press("ArrowLeft");
  note(pile.map(c => c.id).join(",") === "key-3,key-4", "ArrowLeft passes the next card", pile.map(c => c.id).join(","));
  press("ArrowRight");
  note(pile.map(c => c.id).join(",") === "key-4" && wish.some(c => c.id === "key-3"), "ArrowRight saves the next card", pile.map(c => c.id).join(",") + " wish " + wish.map(c => c.id).join(","));
  press("z");
  note(pile.map(c => c.id).join(",") === "key-3,key-4" && !wish.some(c => c.id === "key-3"), "Z undoes the save", pile.map(c => c.id).join(",") + " wish " + wish.map(c => c.id).join(","));
  document.getElementById("hapticSwitch").focus();
  press("ArrowLeft");
  note(pile.map(c => c.id).join(",") === "key-4", "ArrowLeft still works while the haptic switch is focused", pile.map(c => c.id).join(",") + " focus " + ((document.activeElement && document.activeElement.id) || ""));
  const huntIds = pile.map(c => c.id).join(",");
  const undoBefore = undoStack.length;
  document.getElementById("gear").click();
  const motion = document.getElementById("setMotion");
  motion.focus();
  note(typingTarget(motion) && motion.tagName === "SELECT", "a select is a typing target");
  press("ArrowLeft");
  press("ArrowRight");
  press("f");
  press("z");
  note(pile.map(c => c.id).join(",") === huntIds && undoStack.length === undoBefore, "hunt keys do nothing while the motion dropdown is focused", pile.map(c => c.id).join(","));
  note(document.getElementById("filterSheet").hidden && !document.getElementById("settingsSheet").hidden, "F does not open filters over Settings");
  document.getElementById("retakeOnboard").focus();
  press("ArrowLeft");
  press("f");
  note(pile.map(c => c.id).join(",") === huntIds && document.getElementById("filterSheet").hidden, "hunt keys stay inert while Settings is open");
  closeSheet("settingsSheet");
  showTab("sets");
  setView = { id:"base1", name:"Base", release:"1999", mode:"flip", loading:false, cards:Array.from({ length:18 }, (_, i) => ({ id:"base1-" + (i + 1), localId:String(i + 1), name:"Card " + (i + 1), image:art })) };
  flipPage = 0;
  renderSets();
  document.getElementById("gear").click();
  document.getElementById("retakeOnboard").focus();
  press("ArrowRight");
  note(flipPage === 0, "ArrowRight does not turn the set page behind Settings", String(flipPage));
  flipPage = 1;
  renderSets();
  document.getElementById("setMotion").focus();
  press("ArrowLeft");
  note(flipPage === 1, "ArrowLeft does not turn the set page from the motion dropdown", String(flipPage));
  closeSheet("settingsSheet");
  setView = null;
  flipPage = 0;
  showTab("hunt");
  wish = [];
  saveWish();
  const quietIds = pile.map(c => c.id).join(",");
  const quietUndo = undoStack.length;
  const drop = document.getElementById("dropPrompt");
  drop.hidden = false;
  document.getElementById("dropPlay").focus();
  ["ArrowLeft", "ArrowRight", "ArrowUp", "f", "F", "z", "Z", "1", "2"].forEach(press);
  note(pile.map(c => c.id).join(",") === quietIds && undoStack.length === quietUndo && document.getElementById("filterSheet").hidden, "hunt keys stay inert while Today's Drop is open", pile.map(c => c.id).join(","));
  drop.hidden = true;
  if (shell) shell.removeAttribute("inert");
  syncActs();
  showTab("daily");
  const waitGuess = Date.now();
  while (!document.getElementById("dailyGuess") && Date.now() - waitGuess < 5000) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const guess = document.getElementById("dailyGuess");
  note(!!guess && guess.type === "text" && typingTarget(guess), "the daily guess field is a typing target", guess ? guess.type : "missing");
  tab = "hunt";
  if (guess) {
    guess.focus();
    guess.value = "12.50";
    ["1", "2", "3", "ArrowLeft", "ArrowRight", "ArrowUp", "f", "z"].forEach(press);
    note(guess.value === "12.50", "digits stay in the guess field", guess.value);
  }
  deck.focus();
  ["ArrowLeft", "ArrowRight", "ArrowUp", "f", "z"].forEach(press);
  note(pile.map(c => c.id).join(",") === quietIds && undoStack.length === quietUndo && document.getElementById("filterSheet").hidden && document.getElementById("viewDaily") && !document.getElementById("viewDaily").hidden, "hunt keys stay inert while the Daily view is open", pile.map(c => c.id).join(","));
  if (!profileEl.hidden && !wide()) closeProfile();
  showTab("hunt");
  wish = [];
  saveWish();
  const back = pile.map(c => c.id).join(",");
  deck.focus();
  press("ArrowLeft");
  note(pile.map(c => c.id).join(",") !== back, "ArrowLeft works again after Daily closes", pile.map(c => c.id).join(","));
  press("z");
  note(pile.map(c => c.id).join(",") === back, "Z undoes that pass", pile.map(c => c.id).join(","));
  return problems;
})()`;
const screenshotDir = process.env.SCREENSHOT_DIR || resolve(root, "qa-artifacts");
mkdirSync(screenshotDir, { recursive: true });
const keyFails = [];
for (const [width, height] of [[390, 844], [1440, 900]]) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await sleep(80);
  const problems = await ev(keyScript);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(screenshotDir, "keys-" + width + ".png"), Buffer.from(shot.data, "base64"));
  if (!Array.isArray(problems)) keyFails.push(width + " key test did not return a list");
  else problems.forEach(p => keyFails.push(width + ": " + p));
}
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

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
  const realShow = showConfetti;
  showConfetti = m => { notes.push(String(m)); realShow(m); };
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

  setLists.delete("base4");
  if (setView && setView.id === "base4") setView = null;
  ownedIds.add("base4-12");
  ownedSetById.delete("base4-12");
  ownedSetById.delete("base4-not-a-card");
  const beforeFill = setCompletion(meta.sets.find(s => s.id === "base4"));
  check("ids without a set id do not count yet", beforeFill.owned === 0, String(beforeFill.owned));
  backfillOwnedSets();
  const afterFill = setCompletion(meta.sets.find(s => s.id === "base4"));
  check("backfill after the catalog assigns set ids", ownedSetById.get("base4-12") === "base4" && afterFill.owned > 0, ownedSetById.get("base4-12") + " / " + afterFill.owned);

  if (!meta.sets.some(s => s.id === "zzlate")) meta.sets.push({ id:"zzlate", name:"Late Set", cardCount:{ official:3, total:3 } });
  const lateCards = [{ id:"zzlate-1" }, { id:"zzlate-2" }, { id:"zzlate-3" }];
  const realGetJson = getJson;
  getJson = async url => {
    if (String(url).indexOf("/sets/zzlate") >= 0) return { name:"Late Set", releaseDate:"", cards:lateCards.map(c => ({ id:c.id })) };
    return realGetJson(url);
  };
  const waitNotes = n => new Promise(resolve => {
    const start = Date.now();
    const t = setInterval(() => {
      if (notes.length >= n || Date.now() - start > 4000) { clearInterval(t); resolve(); }
    }, 20);
  });
  const waitList = () => new Promise(resolve => {
    const start = Date.now();
    const t = setInterval(() => {
      if (setCardList("zzlate") || Date.now() - start > 4000) { clearInterval(t); resolve(); }
    }, 20);
  });
  notes.length = 0;
  celebrated.delete("set:zzlate");
  setLists.delete("zzlate");
  deferSetConfetti.delete("zzlate");
  ownedIds.clear();
  ownedSetById.clear();
  ownedIds.add("zzlate-1"); ownedSetById.set("zzlate-1", "zzlate");
  ownedIds.add("zzlate-2"); ownedSetById.set("zzlate-2", "zzlate");
  const last = { id:"zzlate-3", name:"Late 3", setId:"zzlate" };
  binderState.binders = [{ id:"bboth", name:"Both", color:"#F3EDC8", cards:[last], theme:{ kind:"none" }, charm:"none" }];
  tab = "hunt";
  setOwned(last, true, "pocket");
  const immediate = (document.querySelector(".confetti p") || {}).textContent || "";
  check("binder celebrates before the set list returns", notes.length === 1 && notes[0].indexOf("Both is complete.") >= 0 && immediate.indexOf("Late Set") < 0, notes.join(" || ") + " / " + immediate);
  await new Promise(r => setTimeout(r, 60));
  const joined = (document.querySelector(".confetti p") || {}).textContent || "";
  check("a fast set list joins the binder celebration", notes.length === 1 && joined.indexOf("Both is complete.") >= 0 && joined.indexOf("Late Set is complete.") >= 0, notes.join(" || ") + " / " + joined);
  check("set key is stored once", celebrated.has("set:zzlate"));
  notes.length = 0;
  ownedIds.delete("zzlate-3");
  setOwned(last, true, "pocket");
  await new Promise(r => setTimeout(r, 80));
  check("completing again stays quiet", notes.length === 0, notes.join(" || "));

  notes.length = 0;
  celebrated.delete("set:zzlate");
  setLists.delete("zzlate");
  deferSetConfetti.delete("zzlate");
  ownedIds.clear();
  ownedSetById.clear();
  binderState.binders = [];
  ["zzlate-p1","zzlate-p2"].forEach(id => { ownedIds.add(id); ownedSetById.set(id, "zzlate"); });
  setOwned({ id:"zzlate-p3", name:"Plant", setId:"zzlate" }, true, "pocket");
  await waitList();
  await new Promise(r => setTimeout(r, 60));
  check("planted ids do not celebrate after the list loads", notes.length === 0 && !celebrated.has("set:zzlate"), notes.join(" || "));

  notes.length = 0;
  celebrated.add("set:zzlate");
  setLists.delete("zzlate");
  ownedIds.clear();
  ownedSetById.clear();
  lateCards.forEach(c => { ownedIds.add(c.id); ownedSetById.set(c.id, "zzlate"); });
  rememberSetList("zzlate", { cards:lateCards, release:"", name:"Late Set" });
  check("already celebrated set stays quiet when the list loads", notes.length === 0 && celebrated.has("set:zzlate"), notes.join(" || "));

  notes.length = 0;
  celebrated.delete("set:zzlate");
  setLists.delete("zzlate");
  rememberSetList("zzlate", { cards:lateCards, release:"", name:"Late Set" });
  const lateNotes = notes.length;
  rememberSetList("zzlate", { cards:lateCards, release:"", name:"Late Set" });
  check("loading the list celebrates a finished set once", lateNotes === 1 && notes.length === 1 && notes[0].indexOf("Late Set is complete.") >= 0, notes.join(" || "));

  if (!meta.sets.some(s => s.id === "zzslow")) meta.sets.push({ id:"zzslow", name:"Slow Set", cardCount:{ official:1, total:1 } });
  getJson = async url => {
    const u = String(url);
    if (u.indexOf("/sets/zzslow") >= 0) {
      await new Promise(r => setTimeout(r, 1800));
      return { name:"Slow Set", releaseDate:"", cards:[{ id:"zzslow-1" }] };
    }
    return realGetJson(url);
  };
  notes.length = 0;
  celebrated.delete("set:zzslow");
  setLists.delete("zzslow");
  deferSetConfetti.delete("zzslow");
  ownedIds.clear();
  ownedSetById.clear();
  const slowCard = { id:"zzslow-1", name:"Slow", setId:"zzslow" };
  binderState.binders = [{ id:"bslow", name:"Slow binder", color:"#F3EDC8", cards:[slowCard], theme:{ kind:"none" }, charm:"none" }];
  const slowStart = Date.now();
  setOwned(slowCard, true, "pocket");
  check("slow set still celebrates the binder immediately", notes.length === 1 && notes[0].indexOf("Slow binder is complete.") >= 0 && notes[0].indexOf("Slow Set") < 0, notes.join(" || "));
  await new Promise(r => setTimeout(r, 400));
  check("binder celebration is not held for a slow set list", notes.length === 1 && Date.now() - slowStart < 1500, notes.join(" || "));
  await waitNotes(2);
  check("a late set list celebrates on its own", notes.length === 2 && notes[1].indexOf("Slow Set is complete.") >= 0 && Date.now() - slowStart >= 1500, notes.join(" || ") + " @" + (Date.now() - slowStart));
  showConfetti("Binder is complete.");
  showSetFollowUp(["Binder is complete."], "Slow Set is complete.", Date.now());
  check("joining a set line keeps the toast up", confettiUntil - Date.now() >= 2400 && ((document.querySelector(".confetti p") || {}).textContent || "").indexOf("Slow Set is complete.") >= 0, String(confettiUntil - Date.now()));

  setLists.delete("zzmiss");
  setListRetryAt.delete("zzmiss");
  let misses = 0;
  getJson = async url => {
    if (String(url).indexOf("/sets/zzmiss") >= 0) { misses++; throw new Error("HTTP 404"); }
    return realGetJson(url);
  };
  let failed = false;
  try { await ensureSetList("zzmiss"); } catch (e) { failed = true; }
  let cooled = "";
  try { await ensureSetList("zzmiss"); } catch (e) { cooled = e && e.setListRetry ? "retry" : (e && e.name || ""); }
  check("a failed set list stays unloaded", failed && !setLists.has("zzmiss") && misses === 1, "failed " + failed + " cached " + setLists.has("zzmiss") + " misses " + misses);
  check("a failed set list backs off instead of caching empty", cooled === "retry" && misses === 1 && !setLists.has("zzmiss"), cooled);
  getJson = realGetJson;

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

  seen.add("lost-1");
  briefs = briefs.filter(b => b.id !== "lost-1");
  deferred = deferred.filter(b => b.id !== "lost-1");
  huntBatch = [{ id:"lost-1", name:"Lost" }];
  requeueHuntBatch();
  check("a dropped hunt batch is requeued", briefs.some(b => b.id === "lost-1") && seen.has("lost-1") && huntBatch.length === 0, JSON.stringify(briefs.map(b => b.id)));

  const origFetch = window.fetch;
  const stopHunt = () => {
    window.fetch = origFetch;
    generation++;
    loading = false;
    clearHuntWatch();
    huntInflight.forEach(job => job.ctrl.abort());
    huntInflight.clear();
    huntBatch = [];
  };
  window.fetch = (url, opts) => {
    if (String(url).indexOf("/cards") >= 0) {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        const fail = () => reject(signal && signal.reason ? signal.reason : new DOMException("Aborted", "AbortError"));
        if (signal) {
          if (signal.aborted) { fail(); return; }
          signal.addEventListener("abort", fail, { once:true });
        }
      });
    }
    return origFetch(url, opts);
  };
  HUNT_FETCH_MS = 450;
  HUNT_SILENT_MS = 20000;
  const pumpsBefore = huntPumps;
  filters = blankFilters();
  filters.names = ["Charizard", "Gengar", "Squirtle"];
  filters.era = "vintage";
  filters.pricePreset = "mid";
  showTab("hunt");
  restart();
  const watchStart = Date.now();
  let flicker = 0;
  let lastStatus = "";
  await new Promise(resolve => {
    const t = setInterval(() => {
      const status = deck.dataset.status || "";
      if (lastStatus === "busy" && status === "loading") flicker++;
      lastStatus = status;
      const p = document.querySelector("#deck .empty-state p");
      const text = p ? p.textContent : "";
      if (/busy, retrying/.test(text) || Date.now() - watchStart > 4000) { clearInterval(t); resolve(); }
    }, 40);
  });
  const busyText = (document.querySelector("#deck .empty-state p") || {}).textContent || "";
  const busyAt = Date.now() - watchStart;
  check("a hung hunt shows busy from the request timeout", /busy, retrying/.test(busyText) && busyAt >= 400 && busyAt < 2500, busyText + " @" + busyAt);
  await new Promise(r => setTimeout(r, 1500));
  const stillBusy = ((document.querySelector("#deck .empty-state p") || {}).textContent || "");
  check("busy text stays up while the hunt is still hung", /busy, retrying/.test(stillBusy) && flicker === 0, stillBusy + " flips " + flicker);
  check("the hung hunt keeps trying", huntPumps >= pumpsBefore + 2, String(huntPumps - pumpsBefore));
  stopHunt();

  if (!meta.sets.some(s => s.id === "zzmiss")) meta.sets.push({ id:"zzmiss", name:"Missing", cardCount:{ official:1, total:1 } });
  setLists.delete("zzmiss");
  setListRetryAt.delete("zzmiss");
  setListFails.delete("zzmiss");
  let setMisses = 0;
  window.fetch = (url, opts) => {
    if (String(url).indexOf("/sets/zzmiss") >= 0) {
      setMisses++;
      return Promise.resolve(new Response("no", { status:404, statusText:"Not Found" }));
    }
    return origFetch(url, opts);
  };
  filters = blankFilters();
  filters.set = "zzmiss";
  showTab("hunt");
  restart();
  await new Promise(r => setTimeout(r, 1200));
  const earlyText = deck.innerText || "";
  check("a missing set list does not pretend to be stuck", setMisses === 1 && earlyText.indexOf("Keep looking") < 0 && earlyText.indexOf("retrying") < 0, setMisses + " " + earlyText.slice(0, 180));
  await new Promise(r => setTimeout(r, 3500));
  check("the hunt retries a missing set list after the backoff", setMisses === 2, String(setMisses));
  await new Promise(r => setTimeout(r, 4500));
  check("a missing set list stops after the retry cap", setMisses === 3, String(setMisses));
  await new Promise(r => setTimeout(r, 5000));
  const gaveUp = deck.innerText || "";
  check("a given-up set list does not say it is retrying", setMisses === 3 && gaveUp.indexOf("retrying") < 0, setMisses + " " + gaveUp.slice(0, 180));
  stopHunt();

  let profileAborted = false;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.indexOf("/cards/hunt-hang") >= 0) {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        const fail = () => reject(signal && signal.reason ? signal.reason : new DOMException("Aborted", "AbortError"));
        if (signal) {
          if (signal.aborted) { fail(); return; }
          signal.addEventListener("abort", fail, { once:true });
        }
      });
    }
    if (u.indexOf("/sets/zzprofile") >= 0) {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        if (signal) signal.addEventListener("abort", () => { profileAborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once:true });
        setTimeout(() => resolve(new Response(JSON.stringify({ id:"zzprofile", name:"Profile Set", cards:[{ id:"zzprofile-1", localId:"1", name:"P" }] }), { status:200, headers:{ "content-type":"application/json" } })), 250);
      });
    }
    return origFetch(url, opts);
  };
  const hung = getJson(TCGDEX + "/cards/hunt-hang", { hunt:true });
  hung.catch(() => {});
  const profileSet = await getJson(TCGDEX + "/sets/zzprofile");
  huntInflight.forEach(job => job.ctrl.abort());
  check("a hunt abort does not cancel a profile set request", profileSet && profileSet.name === "Profile Set" && !profileAborted, profileAborted ? "aborted" : (profileSet && profileSet.name));
  stopHunt();

  async function timeFirstCard(delay, silentMs) {
    let aborts = 0;
    let sawBusy = false;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.indexOf("/cards") < 0) return origFetch(url, opts);
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          const body = u.indexOf("name=") >= 0
            ? [{ id:"base1-58", name:"Pikachu", localId:"58", image:"https://assets.tcgdex.net/en/base/base1/58" }]
            : { id:"base1-58", name:"Pikachu", localId:"58", image:"https://assets.tcgdex.net/en/base/base1/58", rarity:"Common" };
          resolve(new Response(JSON.stringify(body), { status:200, headers:{ "content-type":"application/json" } }));
        }, delay);
        const signal = opts && opts.signal;
        if (signal) {
          const stop = () => {
            if (settled) return;
            aborts++;
            clearTimeout(timer);
            reject(signal.reason || new DOMException("Aborted", "AbortError"));
          };
          if (signal.aborted) { stop(); return; }
          signal.addEventListener("abort", stop, { once:true });
        }
      });
    };
    HUNT_SILENT_MS = silentMs;
    HUNT_FETCH_MS = 12000;
    cardCache.delete("base1-58");
    filters = blankFilters();
    filters.names = ["Pikachu"];
    showTab("hunt");
    const start = Date.now();
    restart();
    const found = await new Promise(resolve => {
      const t = setInterval(() => {
        if (deck.dataset.status === "busy") sawBusy = true;
        if (pile.length || Date.now() - start > delay * 6 + 5000) { clearInterval(t); resolve(pile.length > 0); }
      }, 40);
    });
    const elapsed = Date.now() - start;
    const snap = { found, elapsed, aborts, sawBusy };
    stopHunt();
    return snap;
  }
  const live7 = await timeFirstCard(7000, 1000000);
  const watch7 = await timeFirstCard(7000, 20000);
  check("7s delay matches a hunt with no watchdog", live7.found && watch7.found && Math.abs(live7.elapsed - watch7.elapsed) <= 1000 && watch7.aborts === 0 && !watch7.sawBusy, JSON.stringify({ live:live7, watch:watch7 }));
  const live10 = await timeFirstCard(10000, 1000000);
  const watch10 = await timeFirstCard(10000, 20000);
  check("10s delay matches a hunt with no watchdog", live10.found && watch10.found && Math.abs(live10.elapsed - watch10.elapsed) <= 1000 && watch10.aborts === 0 && !watch10.sawBusy, JSON.stringify({ live:live10, watch:watch10 }));
  HUNT_SILENT_MS = 20000;
  HUNT_FETCH_MS = 12000;
  return fails;
})()`);

await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/index.html?card=base1-4" });
await waitForDeck();
const deepLink = await ev(`(async () => {
  const fails = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const profileState = () => {
    const deckEl = document.getElementById("deck");
    if (!deckEl) return null;
    const titleEl = document.getElementById("profileTitle");
    const title = titleEl ? titleEl.textContent : "";
    const eyebrowEl = document.querySelector("#profile .eyebrow");
    const eyebrow = eyebrowEl ? eyebrowEl.textContent : "";
    const pinned = !!document.getElementById("closeProfile") && !document.querySelector("#profile [data-summary='1']");
    const top = [...deckEl.querySelectorAll(".card")].reverse().find(el => el.card && !el.classList.contains("leaving"));
    const skip = document.getElementById("skip");
    return { title, eyebrow, pinned, top: top && top.card ? top.card.name : "", topId: top && top.card ? top.card.id : "", deck: deckEl.dataset.status || "", skipDisabled: !skip || skip.disabled };
  };
  const start = Date.now();
  let shownAt = 0;
  while (Date.now() - start < 20000) {
    const state = profileState();
    if (state && state.pinned && state.title === "Charizard") { shownAt = Date.now(); break; }
    await sleep(100);
  }
  if (!shownAt) return ["deep link did not pin Charizard — " + JSON.stringify(profileState())];
  let deckReady = false;
  while (Date.now() - start < 25000) {
    const state = profileState();
    if (state && state.top && !state.skipDisabled) { deckReady = true; break; }
    await sleep(100);
  }
  const waited = Date.now() - shownAt;
  if (waited < 8000) await sleep(8000 - waited);
  const held = profileState();
  if (!held) return fails.concat("deck was not ready for the deep link");
  if (!deckReady) fails.push("deck did not finish loading — " + JSON.stringify(held));
  if (!(held.pinned && held.title === "Charizard" && held.eyebrow !== "On the table")) fails.push("Charizard unpinned after the deck loaded — " + JSON.stringify(held));
  const beforeTop = held.topId;
  document.getElementById("skip").click();
  await sleep(700);
  const after = profileState();
  if (!after) return fails.concat("deck disappeared after Skip");
  if (after.pinned || after.eyebrow !== "On the table") fails.push("Skip did not return to the live summary — " + JSON.stringify(after));
  if (!after.title || after.title === "Charizard") fails.push("Skip left Charizard in the panel — " + JSON.stringify(after));
  if (after.top && after.title !== after.top) fails.push("summary is not the new top card — " + JSON.stringify(after));
  if (beforeTop && after.topId === beforeTop) fails.push("Skip did not move the deck — " + JSON.stringify(after));
  return fails;
})()`);

if (errors.length) console.log("page exceptions:", errors.slice(0, 8).join("\n"));
const fails = keyFails.concat(Array.isArray(report) ? report : ["test did not return a list: " + JSON.stringify(report)], Array.isArray(deepLink) ? deepLink : ["deep link test did not return a list: " + JSON.stringify(deepLink)]);
if (fails.length) {
  console.log("FAILED\n" + fails.join("\n"));
  shutdown(1);
}
console.log("owned regressions ok");
shutdown(0);
