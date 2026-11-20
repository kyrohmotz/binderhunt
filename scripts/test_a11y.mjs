// Accessibility sweep for the shipped tabs. Fails on serious or critical
// axe violations at phone and desktop sizes. Run:
// npx -y node@22 scripts/test_a11y.mjs
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(resolve(root, "sw.js"), "utf8");
if (!/const VERSION = "bh-22"/.test(sw)) {
  console.error("service worker VERSION is not bh-22");
  process.exit(1);
}

const PORT = 8837;
const vendor = "/tmp/binderhunt-playwright";
if (!existsSync(vendor + "/node_modules/playwright-core/package.json")) {
  mkdirSync(vendor, { recursive: true });
  const install = spawnSync("npm", ["install", "--prefix", vendor, "playwright-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
if (!existsSync(vendor + "/node_modules/axe-core/axe.min.js")) {
  const install = spawnSync("npm", ["install", "--prefix", vendor, "axe-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
const pwRequire = createRequire(vendor + "/node_modules/playwright-core/package.json");
const { chromium } = pwRequire("playwright-core");
const axeSource = readFileSync(resolve(vendor, "node_modules/axe-core/axe.min.js"), "utf8");

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const problems = [];
let browser;
function note(ok, name, extra) {
  if (ok) console.log("ok", name);
  else {
    problems.push(name + (extra ? " — " + extra : ""));
    console.log("FAIL", name, extra || "");
  }
}
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
      if (res.ok) { await res.arrayBuffer(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

const boot = `(() => {
  try {
    const stub = {
      register() { return Promise.resolve({ addEventListener() {}, installing: null, waiting: null, active: null, update() { return Promise.resolve(); } }); },
      addEventListener() {},
      getRegistrations() { return Promise.resolve([]); },
      controller: null
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, get() { return stub; } });
  } catch (e) {}
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  const today = bag.year + "-" + bag.month + "-" + bag.day;
  localStorage.setItem("bh.onboard.v1", JSON.stringify({ done: true, skipped: true }));
  localStorage.setItem("bh.filters.v3", JSON.stringify({ set: "", rarities: [], era: "", type: "", names: [], min: null, max: null, pricePreset: "", graded: false }));
  localStorage.setItem("bh.binders.v1", JSON.stringify({ discoveryId: "", binders: [{ id: "b1", name: "Fire shelf", color: "#F6C9C9", cards: ["base1-4"] }] }));
  localStorage.setItem("bh.settings.v1", JSON.stringify({ sound: false, haptics: false, reduce: "auto", currency: "USD" }));
  localStorage.setItem("bh.owned.v1", JSON.stringify({ v: 1, ids: ["base1-4"], sets: {}, celebrated: [], seeded: true }));
  localStorage.setItem("binderhuntWish", JSON.stringify([
    { id: "base1-4", name: "Charizard", set: "Base", setId: "base1", number: "4", img: "https://assets.tcgdex.net/en/base/base1/4/high.webp", thumb: "https://assets.tcgdex.net/en/base/base1/4/low.webp" },
    { id: "base1-25", name: "Pikachu", set: "Base", setId: "base1", number: "25", img: "https://assets.tcgdex.net/en/base/base1/25/high.webp", thumb: "https://assets.tcgdex.net/en/base/base1/25/low.webp" }
  ]));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v: 1, current: 0, best: 0, lastPlayed: "", prompted: today, days: {} }));
})();`;

async function axe(page) {
  await page.evaluate(source => {
    if (window.axe) return;
    const script = document.createElement("script");
    script.textContent = source;
    document.documentElement.appendChild(script);
  }, axeSource);
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations
      .filter(item => item.impact === "serious" || item.impact === "critical")
      .map(item => item.impact + " " + item.id + " " + item.nodes.slice(0, 2).map(node => (node.target || []).join(" ")).join(" | "));
  });
}

const steps = [
  ["hunt", "() => {}", "() => !!document.querySelector('#deck .card img, #deck .empty-state, #deck .ph')"],
  ["sets", "() => showTab('sets')", "() => !!document.querySelector('#modeSets')"],
  ["pokemon", "() => openBrowse('pokemon', '')", "() => !!document.getElementById('browseFind')"],
  ["illustrators", "() => openBrowse('illustrator', '')", "() => !!document.getElementById('browseFind')"],
  ["binders", "() => showTab('binders')", "() => !!document.getElementById('openDeals')"],
  ["deals", "() => openDeals('shelf')", "() => !!document.getElementById('dealsTitle')"],
  ["movers", "() => openMovers()", "() => !!document.getElementById('moversTitle')"],
  ["plan", "() => openPlan()", "() => !!document.querySelector('.plan-title, .plan-head, #planTitle')"],
  ["value", "() => showTab('value')", "() => !!document.querySelector('.value-card, .value-empty, .value-wait, .empty-state')"],
  ["dex", "() => showTab('dex')", "() => !!document.querySelector('.dex-caught, .dex-wait, .empty-state')"],
  ["daily", "() => showTab('daily')", "() => !!document.querySelector('.daily-wrap, .daily-frame, #dailyScroll .empty-state')"],
  ["rips", "() => showTab('rips')", "() => !!document.querySelector('#ripsScroll [data-screen], #ripsScroll .empty-state')"]
];

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

for (const viewport of [
  { width: 390, height: 844, isMobile: true, hasTouch: true, label: "390" },
  { width: 1440, height: 900, isMobile: false, hasTouch: false, label: "1440" }
]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch });
  page.setDefaultTimeout(20000);
  const scrydexHits = [];
  page.on("request", req => {
    if (/api\.scrydex\.com|scrydex\.com\/v/i.test(req.url())) scrydexHits.push(req.url());
  });
  await page.addInitScript(boot);
  await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof showTab === "function", null, { timeout: 20000 });
  for (const [name, open, wait] of steps) {
    await page.evaluate(source => { const fn = (0, eval)("(" + source + ")"); return fn(); }, open);
    await page.waitForFunction(wait, null, { timeout: 20000 }).catch(() => {});
    await sleep(250);
    const violations = await axe(page);
    note(!violations.length, viewport.label + " " + name + " has no serious or critical axe violations", violations.join(" || "));
  }
  if (viewport.label === "390") {
    await page.evaluate(() => showTab("sets"));
    await page.waitForSelector("#modeSets");
    await page.evaluate(() => document.getElementById("modeSets").click());
    await page.waitForSelector("#openGemfinder");
    const structure = await page.evaluate(() => {
      const gem = document.getElementById("openGemfinder");
      const list = document.querySelector("[role='tablist']");
      return {
        gemOutside: !!(gem && list && !list.contains(gem)),
        tabs: [...document.querySelectorAll("[role='tab']")].map(tab => tab.id)
      };
    });
    note(structure.gemOutside, "Gemfinder sits outside the browse tablist", JSON.stringify(structure));
    await page.locator("#modeSets").focus();
    await page.keyboard.press("ArrowRight");
    await sleep(200);
    const selected = await page.evaluate(() => {
      const tab = document.querySelector("[role='tab'][aria-selected='true']");
      return tab ? tab.id : "";
    });
    note(selected === "modePokemon", "ArrowRight moves the browse tab", selected);
    await page.evaluate(() => showTab("rips"));
    await page.waitForSelector("#ripsScroll [data-screen]", { timeout: 20000 }).catch(() => {});
    const tore = await page.evaluate(() => {
      const button = document.querySelector("#ripsScroll [data-rip-set]");
      if (button) button.click();
      return !!document.getElementById("ripTear") || !!button;
    });
    if (tore) {
      await page.waitForSelector("#ripTear", { timeout: 8000 }).catch(() => {});
      const tear = await page.evaluate(() => {
        const strip = document.getElementById("ripTear");
        if (!strip) return "missing";
        strip.focus();
        strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        return strip.getAttribute("aria-valuenow") + ":" + (document.activeElement === strip);
      });
      note(tear.startsWith("20"), "ArrowRight tears the pack from the keyboard", tear);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof showTab === "function");
    await page.evaluate(() => showTab("rips"));
    await page.waitForSelector("#ripsScroll [data-screen]", { timeout: 20000 }).catch(() => {});
    const motion = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "rip-card";
      probe.style.position = "absolute";
      probe.style.left = "-999px";
      document.body.appendChild(probe);
      const duration = getComputedStyle(probe).transitionDuration;
      const root = document.documentElement;
      probe.remove();
      return { duration, reduce: root.classList.contains("reduce") || !root.classList.contains("motion-on") };
    });
    note(motion.duration === "0s", "reduced motion removes the pack flip transition", JSON.stringify(motion));
  }
  note(!scrydexHits.length, viewport.label + " makes no Scrydex API calls", scrydexHits.join(" "));
  await page.close();
}

if (problems.length) {
  console.error(problems.join("\n"));
  await shutdown(1);
}
console.log("a11y sweep ok");
await shutdown(0);
