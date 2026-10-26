// Card art through the service worker. TCGdex serves some files without CORS
// headers. The worker used to refetch every card image in cors mode and hand
// back a two-circle placeholder when that failed, which is why real saved
// cards showed the toad in the binder. This answers the CDN requests from
// the test itself: one file with CORS, one without, one missing.
// Run: npx -y node@22 scripts/test_card_art.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import net from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const PORT = await freePort();
const CDP = await freePort();
const profile = mkdtempSync(join(tmpdir(), "chrome-art-"));
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=" + CDP, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch (e) {} try { server.kill(); } catch (e) {} try { rmSync(profile, { recursive: true, force: true }); } catch (e) {} };
process.on("exit", cleanup);

// A small solid PNG, 63x88, so a real load is easy to tell from the old
// 107x150 placeholder.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = 80; raw[o + 2] = 60; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const ART = png(63, 88).toString("base64");

for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch (e) {} await sleep(200); }
const target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(p => p.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let seq = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); });
const errors = [];
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === "Runtime.exceptionThrown") errors.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split("\n")[0]);
  if (m.method === "Target.attachedToTarget") {
    send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, m.params.sessionId).catch(() => {});
    send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {});
  }
  if (m.method === "Fetch.requestPaused") {
    const { requestId, request } = m.params;
    const url = request.url;
    if (/assets\.tcgdex\.net|images\.pokemontcg\.io/.test(url)) {
      if (/gone/.test(url)) { send("Fetch.fulfillRequest", { requestId, responseCode: 404, responseHeaders: [{ name: "Content-Type", value: "text/plain" }], body: "" }, m.sessionId).catch(() => {}); return; }
      const headers = [{ name: "Content-Type", value: "image/png" }];
      if (!/nocors/.test(url)) headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
      send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: headers, body: ART }, m.sessionId).catch(() => {});
    } else if (url.startsWith("http://127.0.0.1")) send("Fetch.continueRequest", { requestId }, m.sessionId).catch(() => {});
    else send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, m.sessionId).catch(() => {});
  }
});
const ev = async expression => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result.value; };
await send("Runtime.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
await send("Page.enable");
const problems = [];
const note = (ok, name, extra) => { console.log((ok ? "ok " : "FAIL ") + name + (ok || !extra ? "" : " — " + extra)); if (!ok) problems.push(name); };

const base = "https://assets.tcgdex.net/en/sv/sv04.5/";
const wishCards = [
  { id: "sv04.5-001", name: "With CORS", set: "Paldean Fates", setId: "sv04.5", number: "001", rarity: "Rare", price: 3, img: base + "001/high.webp", thumb: base + "001/low.webp" },
  { id: "sv04.5-002", name: "No CORS", set: "Paldean Fates", setId: "sv04.5", number: "002", rarity: "Rare", price: 3, img: base + "002-nocors/high.webp", thumb: base + "002-nocors/low.webp" },
  { id: "sv04.5-003", name: "Sharp gone", set: "Paldean Fates", setId: "sv04.5", number: "003", rarity: "Rare", price: 3, img: base + "003-gone/high.webp", thumb: base + "003-nocors/low.webp" }
];
await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true})); localStorage.setItem("binderhuntWish", ${JSON.stringify(JSON.stringify(wishCards))}); localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));` });
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
const controlled = await ev(`(async () => { const s = Date.now(); while (Date.now() - s < 20000) { if (navigator.serviceWorker && navigator.serviceWorker.controller) return true; await new Promise(r => setTimeout(r, 100)); } return false; })()`);
note(controlled, "the service worker controls the page");

const loads = await ev(`(async () => {
  const load = (url, cors) => new Promise(res => { const i = new Image(); if (cors) i.crossOrigin = "anonymous"; i.onload = () => res(i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => res("error"); i.src = url; });
  const b = ${JSON.stringify(base)};
  return {
    cors: await load(b + "010/high.webp"),
    plain: await load(b + "011-nocors/high.webp"),
    plainAgain: await load(b + "011-nocors/high.webp"),
    corsAsked: await load(b + "012-nocors/high.webp", true),
    gone: await load(b + "013-gone/high.webp"),
    cached: (await caches.keys()).filter(k => k.startsWith("bh-img-")).length ? (await (await caches.open((await caches.keys()).find(k => k.startsWith("bh-img-")))).keys()).map(r => r.url) : []
  };
})()`);
note(loads.cors === "63x88", "a CDN file with CORS loads", loads.cors);
note(loads.plain === "63x88" && loads.plainAgain === "63x88", "a CDN file without CORS still loads its real art", JSON.stringify(loads));
note(loads.corsAsked === "error", "a CORS request the CDN refuses fails cleanly instead of faking an image", loads.corsAsked);
note(loads.gone === "error", "a missing file is an error, not a placeholder image", loads.gone);
note(loads.cached.some(u => u.includes("/010/")) && !loads.cached.some(u => /nocors|gone/.test(u)), "only CORS-readable art goes in the image cache", JSON.stringify(loads.cached));

await ev(`showTab("binders"); binderView = { kind: "wish" }; flipPage = 0; renderBinders(); true`);
const binder = await ev(`(async () => {
  const s = Date.now();
  const pick = i => document.querySelector("#bindersScroll .leaf > .face.front .sleeve[data-index='" + i + "']");
  while (Date.now() - s < 8000) {
    const done = [0, 1, 2].every(i => { const sl = pick(i); const img = sl && sl.querySelector("img"); return sl && (sl.querySelector(".art-missing") || (img && img.complete && img.naturalWidth)); });
    if (done) break;
    await new Promise(r => setTimeout(r, 60));
  }
  return [0, 1, 2].map(i => { const sl = pick(i); const img = sl.querySelector("img"); return { src: img ? img.currentSrc.split("/sv04.5/")[1] : "", size: img ? img.naturalWidth + "x" + img.naturalHeight : "", cors: img ? img.getAttribute("crossorigin") : null, missing: !!sl.querySelector(".art-missing"), toad: !!sl.querySelector(".cardback, .toad") }; });
})()`);
note(binder.every(c => c.size === "63x88" && !c.toad && !c.missing && c.cors === null), "every saved card shows its real art in the binder", JSON.stringify(binder));
note(binder[2].src === "003-nocors/low.webp", "when the sharp file is gone the pocket keeps the preview", JSON.stringify(binder[2]));
const sharp = await ev(`(async () => { await new Promise(r => setTimeout(r, 1200)); return [0, 1].map(i => (document.querySelector("#bindersScroll .leaf > .face.front .sleeve[data-index='" + i + "'] img") || {}).currentSrc || ""); })()`);
note(sharp[0].endsWith("001/high.webp") && sharp[1].endsWith("002-nocors/high.webp"), "pockets swap the preview for the full-size file", JSON.stringify(sharp));
note(!errors.length, "no page errors", errors.slice(0, 4).join(" | "));

ws.close();
cleanup();
if (problems.length) { console.log(problems.length + " failed"); process.exit(1); }
console.log("card art tests passed");
process.exit(0);
