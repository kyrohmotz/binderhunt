// Graded ladder and the worth-grading panel on the card profile.
// Uses the committed Scrydex cache only. Run: npx -y node@22 scripts/test_graded.mjs
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8841;
const vendor = "/tmp/binderhunt-playwright";
if (!existsSync(vendor + "/node_modules/playwright-core/package.json")) {
  mkdirSync(vendor, { recursive: true });
  const install = spawnSync("npm", ["install", "--prefix", vendor, "playwright-core"], { stdio: "inherit" });
  if (install.status) process.exit(install.status || 1);
}
const require = createRequire(vendor + "/node_modules/playwright-core/package.json");
const { chromium } = require("playwright-core");

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
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
      if (res.ok) { await res.arrayBuffer(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

const boot = `(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  const iso = bag.year + "-" + bag.month + "-" + bag.day;
  localStorage.setItem("bh.onboard.v1", JSON.stringify({ done:true, skipped:true }));
  localStorage.setItem("bh.filters.v3", JSON.stringify({ set:"", rarities:[], era:"", type:"", names:[], min:null, max:null, pricePreset:"", graded:false }));
  localStorage.setItem("bh.settings.v1", JSON.stringify({ sound:false, haptics:false, reduce:"on", currency:"USD" }));
  localStorage.setItem("bh.owned.v1", JSON.stringify({ v:1, ids:[], sets:{}, celebrated:[], seeded:true }));
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted:iso, days:{} }));
  localStorage.setItem("bh.pwa.v1", JSON.stringify({ swipes:0, dismissed:true }));
  const wish = [{ id:"base1-4", name:"Charizard", set:"Base", setId:"base1", number:"4", rarity:"Rare Holo", img:"https://assets.tcgdex.net/en/base/base1/4/high.webp", thumb:"https://assets.tcgdex.net/en/base/base1/4/low.webp" }];
  localStorage.setItem("binderhuntWish", JSON.stringify(wish));
  localStorage.setItem("bh.binders.v1", JSON.stringify({ discoveryId:"", binders:[] }));
  localStorage.setItem("bh.targets.v1", JSON.stringify({ "base1-4": { price:5000, setAt:Date.now(), priceAtSet:8000, seen:8000, seenAt:Date.now() } }));
  window.__imgErrors = [];
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target.tagName === "IMG") window.__imgErrors.push(target.currentSrc || target.src || "img");
  }, true);
})();`;

await waitServer();
mkdirSync("/opt/cursor/artifacts", { recursive: true });
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

const problems = [];
function note(ok, name, extra) {
  if (ok) console.log("ok", name);
  else {
    problems.push(name + (extra ? " — " + extra : ""));
    console.log("FAIL", name, extra || "");
  }
}

function badMoney(text) {
  return /NaN|undefined/.test(text) || /\$0\.00\b|\$0(?!\.|\d)/.test(text);
}

async function clickTab(page, name) {
  const tabs = page.locator(`[data-tab="${name}"]`);
  const count = await tabs.count();
  for (let i = 0; i < count; i++) {
    if (await tabs.nth(i).isVisible()) {
      await tabs.nth(i).click();
      return;
    }
  }
  throw new Error("no visible tab " + name);
}

async function settle(page) {
  const prompt = page.locator("#dropPrompt");
  if (await prompt.count() && await prompt.isVisible().catch(() => false)) {
    const dismiss = page.locator("#dropPrompt button, #dropDismiss, #dropLater").first();
    if (await dismiss.count()) await dismiss.click().catch(() => {});
    await page.evaluate(() => {
      const el = document.getElementById("dropPrompt");
      if (el) el.hidden = true;
    });
  }
}

async function openDeep(page, id) {
  const errors = [];
  page.removeAllListeners("pageerror");
  page.removeAllListeners("console");
  page.removeAllListeners("request");
  page.on("pageerror", err => errors.push(String(err && err.message || err).split("\n")[0]));
  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text().split("\n")[0]); });
  page.on("request", req => { if (/scrydex\.com/i.test(req.url())) errors.push("scrydex " + req.url()); });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html?card=" + id, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof scrydex !== "undefined" && scrydex.ready && document.getElementById("profile") && !document.getElementById("profile").hidden, null, { timeout: 30000 });
  await settle(page);
  return errors;
}

async function profileFacts(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#profile .profile-scroll");
    const text = root ? root.innerText : "";
    const price = (document.querySelector("#profile .market-price") || {}).textContent || "";
    const ladder = [...document.querySelectorAll("#profile .grade-rung")].map(el => el.innerText.replace(/\s+/g, " ").trim());
    const spreads = [...document.querySelectorAll("#profile .worth-spreads li")].map(el => el.textContent.trim());
    const verdict = (document.getElementById("worthLive") || {}).innerText || "";
    const empty = !!root && /No graded sales cached yet/.test(root.innerText);
    const input = document.getElementById("gradeCost");
    const live = document.getElementById("worthLive");
    const label = document.querySelector("label[for='gradeCost']");
    const fresh = [...document.querySelectorAll("#profile .rung-meta")].map(el => el.textContent.trim());
    const trend = !!document.querySelector("#profile .grade-trend");
    const boxes = [...document.querySelectorAll("#profile .grade-rung, #profile .worth, #profile .grade")].filter(el => !el.innerText.trim()).length;
    let clipped = [];
    const scroller = root;
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) clipped.push("page");
    if (scroller && scroller.scrollWidth > scroller.clientWidth + 2) clipped.push("profile " + scroller.scrollWidth + ">" + scroller.clientWidth);
    if (scroller) {
      const bound = scroller.getBoundingClientRect();
      scroller.querySelectorAll(".market-price, .rung-price, .rung-name, .worth-spreads li, .verdict-chip, #gradeCost, .worth-disclaimer").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 2) return;
        if (r.right > bound.right + 2 || r.left < bound.left - 2) clipped.push((el.id || el.className || "el") + " x");
      });
    }
    const broken = [...document.images].filter(img => img.src && img.complete && img.naturalWidth === 0).map(img => img.src);
    return {
      text, price: price.trim(), ladder, spreads, verdict: verdict.trim(), empty, trend, boxes,
      input: input ? { value: input.value, type: input.type, labelled: !!(label && label.htmlFor === "gradeCost") } : null,
      live: live ? live.getAttribute("aria-live") : "",
      fresh, clipped, broken,
      stored: localStorage.getItem("bh.grading.v1")
    };
  });
}

async function frameProfile(page, where) {
  await page.evaluate(target => {
    const scroller = document.querySelector("#profile .profile-scroll");
    if (!scroller) return;
    if (target !== "worth") { scroller.scrollTop = 0; return; }
    const tail = scroller.querySelector(".worth") || document.getElementById("worthLive");
    if (!tail) { scroller.scrollTop = 0; return; }
    const tools = document.querySelector("#profile .profile-tools");
    const stick = tools ? tools.getBoundingClientRect().height + 10 : 64;
    const top = tail.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - stick);
  }, where || "top");
  await sleep(120);
}

async function swipe(page, dir, pointerType) {
  const moved = await page.evaluate(async ({ dir, pointerType }) => {
    const el = [...document.querySelectorAll("#deck .card")].reverse().find(node => node.card && !node.classList.contains("leaving"));
    if (!el) return "no-card";
    const before = el.card.id;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height * 0.45;
    const dx = dir * 220;
    const pid = 7;
    const fire = (target, type, cx, buttons) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: pid, pointerType, isPrimary: true,
      clientX: cx, clientY: y, button: 0, buttons
    }));
    fire(el, "pointerdown", x, 1);
    await new Promise(resolve => requestAnimationFrame(resolve));
    fire(window, "pointermove", x + dx * 0.45, 1);
    fire(window, "pointermove", x + dx, 1);
    await new Promise(resolve => requestAnimationFrame(resolve));
    fire(window, "pointerup", x + dx, 0);
    await new Promise(resolve => setTimeout(resolve, 500));
    const top = [...document.querySelectorAll("#deck .card")].reverse().find(node => node.card && !node.classList.contains("leaving"));
    if (!top || top.card.id !== before) return "swiped";
    return "stuck";
  }, { dir, pointerType });
  return moved;
}

const sizes = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 }
];

for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(25000);
  await page.addInitScript(boot);
  const errors = await openDeep(page, "base1-4");
  await page.waitForFunction(() => {
    const live = document.getElementById("worthLive");
    const ladder = document.querySelector("#profile .grade-ladder");
    return ladder && live && /PSA 10/.test(ladder.innerText) && live.innerText.trim();
  }, null, { timeout: 25000 }).catch(() => {});
  await page.waitForFunction(() => {
    const img = document.querySelector("#profile .thumb img, #profileThumb img");
    return !img || (img.complete && img.naturalWidth > 0);
  }, null, { timeout: 15000 }).catch(() => {});
  let facts = await profileFacts(page);
  note(!errors.length, size.name + " graded console", errors.join(" | "));
  note(!!facts.price && facts.price !== "—" && !badMoney(facts.price), size.name + " raw headline", facts.price);
  note(facts.ladder.some(row => row.startsWith("PSA 10")) && facts.ladder.some(row => row.startsWith("PSA 9")), size.name + " ladder rungs", facts.ladder.join(" || "));
  note(facts.fresh.some(row => /Price updated (today|\d+d ago)/.test(row)), size.name + " freshness", facts.fresh.join(" || "));
  note(facts.spreads.some(row => /PSA 10 is \+\$[\d,.]+ over raw after fees/.test(row)), size.name + " psa 10 spread", facts.spreads.join(" || "));
  note(/Grade-worthy|Only a \d+(?:\.\d+)? pays|Keep raw/.test(facts.verdict), size.name + " verdict", facts.verdict);
  note(facts.input && facts.input.value === "25" && facts.input.labelled && facts.live === "polite", size.name + " cost input", JSON.stringify(facts.input) + " live=" + facts.live);
  note(!facts.trend, size.name + " no graded trend in cache");
  note(!facts.empty && facts.boxes === 0, size.name + " no empty graded boxes", String(facts.boxes));
  note(!badMoney(facts.text), size.name + " no NaN or $0", (facts.text.match(/NaN|undefined|\$0(?:\.00)?/g) || []).join(","));
  note(!facts.clipped.length, size.name + " nothing clipped", facts.clipped.join(", "));
  note(!facts.broken.length && !(await page.evaluate(() => window.__imgErrors || [])).length, size.name + " images", facts.broken.join(" ") + " " + ((await page.evaluate(() => window.__imgErrors || [])).join(" ")));
  const reached = await page.evaluate(() => {
    const input = document.getElementById("gradeCost");
    if (!input) return false;
    input.focus();
    return document.activeElement === input;
  });
  note(reached, size.name + " cost input focuses");
  await page.fill("#gradeCost", "40");
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem("bh.grading.v1") || "null").cost === 40; } catch (e) { return false; }
  });
  const edited = await profileFacts(page);
  note(edited.input && edited.input.value === "40" && edited.spreads.some(row => row.includes("PSA 10")) && !badMoney(edited.text), size.name + " edited cost", edited.spreads[0] + " / " + edited.verdict);
  const stored = await page.evaluate(() => localStorage.getItem("bh.grading.v1"));
  note(stored === JSON.stringify({ cost: 40 }), size.name + " persisted key", stored);
  await page.fill("#gradeCost", "");
  const cleared = await profileFacts(page);
  note(/Enter a grading cost/.test(cleared.verdict) && !badMoney(cleared.text) && !cleared.spreads.length, size.name + " blank cost", cleared.verdict);
  await page.fill("#gradeCost", "25");
  const logic = await page.evaluate(() => ({
    only: verdictFor([{ grade: "10", spread: 80 }, { grade: "9", spread: -4 }]).label,
    half: verdictFor([{ grade: "9.5", spread: 12 }, { grade: "9", spread: -2 }]).label,
    go: verdictFor([{ grade: "10", spread: 40 }, { grade: "9", spread: 8 }]).label,
    keep: verdictFor([{ grade: "10", spread: -3 }, { grade: "9", spread: -9 }]).label,
    trend: gradedTrendPoints({ id: "base1-4" }, { company: "PSA", grade: "10" }).length
  }));
  note(logic.only === "Only a 10 pays" && logic.half === "Only a 9.5 pays" && logic.go === "Grade-worthy" && logic.keep === "Keep raw", size.name + " verdict logic", JSON.stringify(logic));
  note(logic.trend === 0, size.name + " cached history has no graded series", String(logic.trend));
  await page.evaluate(() => {
    const rec = scrydex.cards["base1-4"];
    rec.history.push(
      { d: "2026/10/01", v: "unlimitedHolofoil", m: 30000, company: "PSA", grade: "10" },
      { d: "2026/11/01", v: "unlimitedHolofoil", m: 37000, company: "PSA", grade: "10" }
    );
    if (profileCard) renderProfile(cardCache.get("base1-4") || profileCard);
  });
  await page.waitForSelector("#profile .grade-trend", { timeout: 4000 }).catch(() => {});
  const trendOn = await page.locator("#profile .grade-trend").count();
  note(trendOn === 1, size.name + " trend appears when a graded series is cached", String(trendOn));
  await page.evaluate(() => {
    const rec = scrydex.cards["base1-4"];
    rec.history = rec.history.filter(row => !row.company);
    if (profileCard) renderProfile(cardCache.get("base1-4") || profileCard);
  });
  await page.waitForFunction(() => !document.querySelector("#profile .grade-trend"));
  await frameProfile(page, "top");
  const priceVisible = await page.evaluate(() => {
    const price = document.querySelector("#profile .market-price");
    const scroller = document.querySelector("#profile .profile-scroll");
    if (!price || !scroller) return false;
    const pr = price.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return pr.top >= sr.top - 2 && pr.bottom <= sr.bottom + 2 && pr.height > 10;
  });
  note(priceVisible, size.name + " raw price is on screen");
  await page.screenshot({ path: "/opt/cursor/artifacts/graded-" + size.name + ".png" });
  const worthOnScreen = await page.evaluate(() => {
    const live = document.getElementById("worthLive");
    const scroller = document.querySelector("#profile .profile-scroll");
    if (!live || !scroller) return false;
    const lr = live.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return lr.top >= sr.top && lr.bottom <= sr.bottom;
  });
  if (!worthOnScreen) {
    await frameProfile(page, "worth");
    await page.screenshot({ path: "/opt/cursor/artifacts/worth-" + size.name + ".png" });
  }
  note(true, size.name + " graded screenshot");

  const emptyErrors = await openDeep(page, "pop5-4");
  await page.waitForFunction(() => /No graded sales cached yet/.test((document.querySelector("#profile") || {}).innerText || ""), null, { timeout: 25000 }).catch(() => {});
  const empty = await profileFacts(page);
  note(!emptyErrors.length, size.name + " empty console", emptyErrors.join(" | "));
  note(empty.empty && !empty.ladder.length && !empty.input, size.name + " empty graded state", empty.text.slice(0, 280));
  note(!badMoney(empty.text), size.name + " empty has no NaN or $0");
  note(!empty.clipped.length, size.name + " empty nothing clipped", empty.clipped.join(", "));
  const emptyBroken = empty.broken.concat(await page.evaluate(() => window.__imgErrors || []));
  note(!emptyBroken.length, size.name + " empty images", emptyBroken.join(" "));
  await frameProfile(page);
  await page.screenshot({ path: "/opt/cursor/artifacts/ungraded-" + size.name + ".png" });

  await page.evaluate(() => { localStorage.removeItem("bh.grading.v1"); });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html?card=base1-4", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#gradeCost", { timeout: 25000 });
  const again = await page.locator("#gradeCost").inputValue();
  note(again === "25", size.name + " default returns after clearing the key", again);
  await page.fill("#gradeCost", "40");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#gradeCost", { timeout: 25000 });
  note((await page.locator("#gradeCost").inputValue()) === "40", size.name + " cost survives reload");

  await page.evaluate(() => { if (typeof closeProfile === "function") closeProfile(); showTab("hunt"); });
  await page.waitForSelector("#deck .card", { timeout: 25000 }).catch(() => {});
  const touch = await swipe(page, 1, "touch");
  const mouse = await swipe(page, -1, "mouse");
  note(touch === "swiped", size.name + " touch swipe", touch);
  note(mouse === "swiped", size.name + " mouse swipe", mouse);
  const huntCard = await page.evaluate(() => {
    const el = [...document.querySelectorAll("#deck .card")].reverse().find(node => node.card && !node.classList.contains("leaving"));
    return el && el.card ? el.card.id : "";
  });
  const deckCard = page.locator("#deck .card").last();
  const box = await deckCard.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 180));
  await page.waitForFunction(() => {
    const root = document.getElementById("profile");
    return root && !root.hidden && root.querySelector("[data-profile-id]") && /Raw vs graded|No graded sales cached yet/.test(root.innerText);
  }, null, { timeout: 12000 }).catch(() => {});
  const fromHunt = await page.evaluate(() => {
    const root = document.querySelector("#profile");
    return root && !root.hidden && /Raw vs graded|No graded sales cached yet/.test(root.innerText);
  });
  note(!!huntCard && fromHunt, size.name + " profile from hunt", huntCard);

  await page.evaluate(() => { if (typeof closeProfile === "function") closeProfile(); });
  await clickTab(page, "binders");
  await page.locator("#openWish").click();
  await page.waitForSelector(".cardhit", { timeout: 8000 });
  const hit = page.locator(".cardhit").first();
  await hit.click();
  let details = page.locator("#showcaseDetails");
  if (!(await details.isVisible().catch(() => false))) {
    await hit.focus();
    await page.keyboard.press("Enter");
    details = page.locator("#showcaseDetails");
  }
  if (await details.isVisible().catch(() => false)) await details.click();
  await page.waitForFunction(() => {
    const root = document.querySelector("#profile");
    return root && !root.hidden && /Raw vs graded/.test(root.innerText) && /PSA 10/.test(root.innerText);
  }, null, { timeout: 15000 }).catch(() => {});
  const fromWish = await page.evaluate(() => /PSA 10/.test((document.querySelector("#profile") || {}).innerText || ""));
  note(fromWish, size.name + " profile from wishlist");

  await page.evaluate(() => { if (typeof closeProfile === "function") closeProfile(); if (window.CardInspect && CardInspect.isOpen()) CardInspect.close("return"); });
  await clickTab(page, "binders");
  await page.locator("#openDeals").click();
  await page.waitForSelector(".deal-row", { timeout: 15000 }).catch(() => {});
  if (await page.locator(".deal-row").count()) await page.locator(".deal-row").first().click();
  await page.waitForFunction(() => /PSA 10/.test((document.querySelector("#profile") || {}).innerText || ""), null, { timeout: 15000 }).catch(() => {});
  const fromDeals = await page.evaluate(() => /PSA 10/.test((document.querySelector("#profile") || {}).innerText || ""));
  note(fromDeals, size.name + " profile from deals");
  const dealErrors = await page.evaluate(() => window.__imgErrors || []);
  note(!dealErrors.length, size.name + " images after navigation", dealErrors.join(" "));
  await page.close();
}

console.log(problems.length ? "\n" + problems.length + " failed" : "\nall graded checks passed");
await shutdown(problems.length ? 1 : 0);
