// Upgrading from the bh-2 service worker. bh-2 answered card images whose CDN
// sends no CORS headers with a 107x150 placeholder. A page that was open when
// the new worker took over kept those placeholders until a reload. This
// serves the old sw.js first, then the current one, and checks that the open
// page swaps the placeholders for the real art on its own.
// Run: npx -y node@22 scripts/test_upgrade_heal.mjs
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import http from "node:http";
import net from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_SW = "bcf9c69";
let oldSw;
try { oldSw = execFileSync("git", ["show", OLD_SW + ":sw.js"], { cwd: root }).toString(); }
catch (e) { console.log("skip: old sw.js (" + OLD_SW + ") is not in this clone"); process.exit(0); }
let serveOld = true;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  if (path === "sw.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    res.end(serveOld ? oldSw : readFileSync(join(root, "sw.js")));
    return;
  }
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
});
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const PORT = await freePort();
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
const CDP = await freePort();
const profile = mkdtempSync(join(tmpdir(), "chrome-heal-"));
const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=" + CDP, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch (e) {} try { server.close(); } catch (e) {} try { rmSync(profile, { recursive: true, force: true }); } catch (e) {} };
process.on("exit", cleanup);

function png(w, h) {
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 120);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const ART = png(63, 88).toString("base64");

for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch (e) {} await sleep(200); }
const target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(p => p.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let seq = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); });
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === "Target.attachedToTarget") {
    send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, m.params.sessionId).catch(() => {});
    send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {});
  }
  if (m.method === "Fetch.requestPaused") {
    const { requestId, request } = m.params;
    if (/assets\.tcgdex\.net|images\.pokemontcg\.io/.test(request.url)) {
      // No CORS headers, like the TCGdex files that broke.
      send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: ART }, m.sessionId).catch(() => {});
    } else if (request.url.startsWith("http://127.0.0.1")) send("Fetch.continueRequest", { requestId }, m.sessionId).catch(() => {});
    else send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, m.sessionId).catch(() => {});
  }
});
const ev = async expression => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result.value; };
await send("Runtime.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const cards = [0, 1, 2].map(i => ({ id: "sv08-00" + i, name: "Card " + i, set: "Surging Sparks", setId: "sv08", number: "00" + i, rarity: "Rare", price: 4, img: `https://assets.tcgdex.net/en/sv/sv08/00${i}/high.webp`, thumb: `https://assets.tcgdex.net/en/sv/sv08/00${i}/low.webp` }));
await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true})); localStorage.setItem("binderhuntWish", ${JSON.stringify(JSON.stringify(cards))}); localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"on",currency:"USD"}));` });

const problems = [];
const note = (ok, name, extra) => { console.log((ok ? "ok " : "FAIL ") + name + (ok || !extra ? "" : " — " + extra)); if (!ok) problems.push(name); };
const url = `http://127.0.0.1:${PORT}/index.html`;
// An image nothing redraws, like the swipe card and side panel thumbnail in
// the original report.
const pocketSizes = `[...document.querySelectorAll("#healProbe")].map(i => i.complete ? i.naturalWidth + "x" + i.naturalHeight : "loading")`;
const openWish = `(async () => { const s = Date.now(); while (Date.now() - s < 20000 && typeof renderBinders !== "function") await new Promise(r => setTimeout(r, 100)); const img = document.createElement("img"); img.id = "healProbe"; img.src = wish[0].img; document.body.append(img); await new Promise(r => setTimeout(r, 1500)); })()`;

// 1. First visit installs bh-2. 2. Reload so bh-2 controls the page.
await send("Page.navigate", { url });
await ev(`(async () => { const s = Date.now(); while (Date.now() - s < 20000) { if (navigator.serviceWorker.controller) return; await new Promise(r => setTimeout(r, 100)); } })()`);
await send("Page.navigate", { url });
await ev(openWish);
const before = await ev(pocketSizes);
const oldVersion = await ev(`new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = e => res(e.data); navigator.serviceWorker.controller.postMessage("bh-version", [ch.port2]); setTimeout(() => res("no answer"), 2000); })`);
note(before.length === 1 && before.every(s => s === "107x150"), "bh-2 shows its placeholder for CORS-less art (the reported bug)", JSON.stringify({ before, oldVersion }));

// 3. Deploy: the new worker takes over the open page.
serveOld = false;
await ev(`navigator.serviceWorker.getRegistration().then(r => r.update())`);
const switched = await ev(`(async () => { const s = Date.now(); while (Date.now() - s < 15000) { const ch = new MessageChannel(); const v = await new Promise(res => { ch.port1.onmessage = e => res(e.data); navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage("bh-version", [ch.port2]); setTimeout(() => res(null), 300); }); if (v && JSON.stringify(v).includes("bh-3")) return JSON.stringify(v); await new Promise(r => setTimeout(r, 200)); } return "timeout"; })()`);
note(/bh-3/.test(switched), "the new worker takes over the open page", switched);
await sleep(2500);
const after = await ev(pocketSizes);
note(after.length === 1 && after.every(s => s === "63x88"), "the open page swaps placeholders for the real art without a reload", JSON.stringify(after));
const toast = await ev(`!document.getElementById("updateToast").hidden`);
note(toast, "the update toast still offers a refresh");

ws.close();
cleanup();
if (problems.length) { console.log(problems.length + " failed"); process.exit(1); }
console.log("upgrade heal tests passed");
process.exit(0);
