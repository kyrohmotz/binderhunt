// Fill data/scrydex.json illustrator fields from TCGdex. No Scrydex calls.
// Run: npx -y node@22 scripts/fill_illustrators.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cachePath = resolve(root, "data/scrydex.json");
const checkpointPath = resolve(root, "data/.illustrators-checkpoint.json");
const data = JSON.parse(readFileSync(cachePath, "utf8"));
const cards = data.cards || {};
const ids = Object.keys(cards);
if (existsSync(checkpointPath)) {
  const saved = JSON.parse(readFileSync(checkpointPath, "utf8"));
  Object.keys(saved).forEach(id => {
    if (cards[id] && typeof saved[id] === "string") cards[id].illustrator = saved[id];
  });
  console.log("resumed", Object.keys(saved).length);
}
const CONCURRENCY = 4;

function clean(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

async function illustratorFor(id, attempt = 0) {
  const url = "https://api.tcgdex.net/v2/en/cards/" + encodeURIComponent(id);
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    if (attempt < 5) {
      await sleep(500 * (attempt + 1));
      return illustratorFor(id, attempt + 1);
    }
    throw error;
  }
  if (res.status === 404) return "";
  if (res.status === 503 || res.status === 429 || res.status === 502 || res.status >= 500) {
    if (attempt < 5) {
      const wait = Number(res.headers.get("retry-after")) || (0.6 * (attempt + 1));
      await sleep(Math.min(8, wait) * 1000);
      return illustratorFor(id, attempt + 1);
    }
  }
  if (!res.ok) throw new Error(id + " HTTP " + res.status);
  const body = await res.json();
  return clean(body && body.illustrator);
}

let cursor = 0;
let done = 0;
let named = 0;
const pending = ids.filter(id => !(cards[id] && typeof cards[id].illustrator === "string"));

async function worker() {
  while (cursor < pending.length) {
    const id = pending[cursor++];
    const name = await illustratorFor(id);
    cards[id].illustrator = name;
    if (name) named++;
    done++;
    if (done % 50 === 0 || done === pending.length) {
      const map = {};
      ids.forEach(key => {
        const rec = cards[key];
        if (rec && typeof rec.illustrator === "string") map[key] = rec.illustrator;
      });
      writeFileSync(checkpointPath, JSON.stringify(map));
      const covered = Object.values(map).filter(Boolean).length;
      console.log(done + "/" + pending.length + " named " + named + " covered " + covered + "/" + ids.length);
    }
    await sleep(30);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const covered = Object.values(cards).filter(rec => rec && typeof rec.illustrator === "string" && rec.illustrator).length;
console.log("COVERAGE " + covered + " of " + ids.length);
console.log("checkpoint " + checkpointPath);
