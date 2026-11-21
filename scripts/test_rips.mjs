// Rip a pack: slot rules, no empty packs, price labels, and the pull log.
// The module stays out of the first paint. Run: npx -y node@22 scripts/test_rips.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
require(resolve(root, "js/browse.js"));
const Rips = require(resolve(root, "js/rips.js"));

const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
const ripCss = readFileSync(resolve(root, "css/rips.css"), "utf8");
assert.match(ripCss, /prefers-reduced-motion/);
assert.match(sw, /const VERSION = "bh-23"/);
assert.match(sw, /data\/pack-pools\.json/);
assert.match(sw, /"js\/rips\.js"/);
assert.match(sw, /"js\/rips-ui\.js"/);
assert.match(sw, /"css\/rips\.css"/);
assert.equal(html.includes("js/rips.js"), false, "rips script stays out of the first paint");
assert.equal(html.includes("css/rips.css"), false, "rips css stays out of the first paint");
assert.match(html, /data-tab="rips"/);
assert.match(html, /id="viewRips"/);
assert.match(app, /loadScript\("js\/rips\.js"\)/);
assert.doesNotMatch(app, /js\/binder-turn\.js[\s\S]{0,80}rips/);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

assert.equal(Rips.bucketOf("Common"), "common");
assert.equal(Rips.bucketOf("Uncommon"), "uncommon");
assert.equal(Rips.bucketOf("Rare"), "rare");
assert.equal(Rips.bucketOf("Holo Rare"), "holo");
assert.equal(Rips.bucketOf("Rare Holo"), "holo");
assert.equal(Rips.bucketOf("Rare Holo LV.X"), "holo");
assert.equal(Rips.bucketOf("Ultra Rare"), "ultra");
assert.equal(Rips.bucketOf("Illustration rare"), "ultra");
assert.equal(Rips.bucketOf("Secret Rare"), "ultra");
assert.equal(Rips.bucketOf(""), "");
assert.equal(Rips.bucketOf("Promo"), "rare");
assert.equal(Rips.slotsFor("base1").length, 11);
assert.equal(Rips.slotsFor("base1").filter(slot => slot === "common").length, 7);
assert.equal(Rips.slotsFor("base1").includes("reverse"), false);
assert.equal(Rips.slotsFor("lc").filter(slot => slot === "reverse").length, 1);
assert.equal(Rips.slotsFor("lc").slice(-1)[0], "hit");
assert.equal(Rips.slotsFor("ecard2").length, 9);
assert.equal(Rips.slotsFor("ecard2").filter(slot => slot === "common").length, 5);
assert.equal(Rips.slotsFor("ecard3").filter(slot => slot === "reverse").length, 1);
assert.equal(Rips.slotsFor("ex1").filter(slot => slot === "common").length, 5);
assert.equal(Rips.slotsFor("ex1").filter(slot => slot === "uncommon").length, 2);
assert.equal(Rips.slotsFor("dp1").length, 10);
assert.equal(Rips.slotsFor("hgss1").filter(slot => slot === "reverse").length, 1);
assert.equal(Rips.slotsFor("swsh7").slice(-1)[0], "hit");
assert.equal(Rips.slotsFor("swsh7").filter(slot => slot === "common").length, 5);
assert.equal(Rips.slotsFor("sv01").filter(slot => slot === "common").length, 4);
assert.equal(Rips.slotsFor("sv01").filter(slot => slot === "art").length, 1);
assert.equal(Rips.slotsFor("me02").length, 10);
assert.equal(Rips.shapeOf("base1").text, "7 commons, 3 uncommons, a rare slot");
assert.match(Rips.shapeOf("sv08").text, /4 commons, 3 uncommons, a reverse holo, a foil slot, a rare slot/);
assert.equal(Rips.hitBucket(0.01, { ultra: 1, holo: 1, rare: 1 }), "ultra");
assert.equal(Rips.hitBucket(0.1, { ultra: 1, holo: 1, rare: 1 }), "holo");
assert.equal(Rips.hitBucket(0.5, { ultra: 1, holo: 1, rare: 1 }), "rare");
assert.equal(Rips.hitBucket(0.01, { ultra: 0, holo: 1, rare: 1 }), "holo");
assert.equal(Rips.hitBucket(0.9, { rare: 0, holo: 0, ultra: 2, uncommon: 0, common: 0 }), "ultra");
assert.equal(Rips.hitBucket(0.9, { common: 4 }), "common");

["NaN", "0", "-4", "0.004", "Infinity", ""].forEach(raw => {
  const value = raw === "" ? undefined : Number(raw);
  const label = Rips.priceLabel(value);
  assert.equal(label, "No price yet", raw);
  assert.equal(label.includes("NaN"), false);
  assert.equal(label.includes("$"), false);
});
assert.equal(Rips.priceLabel(1.5), "$1.50");
assert.equal(Rips.priceLabel(1200), "$1,200.00");
assert.equal(Rips.priceLabel(0), "No price yet");
assert.equal(Rips.displayPrice({ bucket: "common", price: null }), "Bulk");
assert.equal(Rips.displayPrice({ bucket: "uncommon", price: 0 }), "Bulk");
assert.equal(Rips.displayPrice({ bucket: "common", finish: "reverse", price: null }), "Bulk");
assert.equal(Rips.displayPrice({ bucket: "rare", price: null }), "No price yet");
assert.equal(Rips.displayPrice({ bucket: "rare", finish: "reverse", price: null }), "No price yet");
assert.equal(Rips.displayPrice({ bucket: "holo", price: NaN }), "No price yet");
assert.equal(Rips.displayPrice({ bucket: "ultra", price: undefined }), "No price yet");
assert.equal(Rips.displayPrice({ bucket: "common", price: 0.5 }), "$0.50");
assert.equal(Rips.displayPrice({ bucket: "common", price: 0 }).includes("NaN"), false);
assert.equal(Rips.displayPrice({ bucket: "common", price: 0 }).includes("$"), false);

function card(id, bucket, price, rarity) {
  const cut = id.lastIndexOf("-");
  return {
    id,
    name: id,
    setId: id.slice(0, cut),
    setName: "Test",
    number: id.slice(cut + 1),
    rarity: rarity || bucket,
    bucket,
    price: price == null ? null : price,
    priceLabel: Rips.priceLabel(price),
    image: "",
    thumb: "",
    img: "",
    backup: ""
  };
}

function stocked(setId) {
  const cards = [];
  for (let i = 0; i < 12; i++) cards.push(card(setId + "-c" + i, "common", 0.25 + i / 100, "Common"));
  for (let i = 0; i < 8; i++) cards.push(card(setId + "-u" + i, "uncommon", 0.8, "Uncommon"));
  for (let i = 0; i < 6; i++) cards.push(card(setId + "-r" + i, "rare", 3 + i, "Rare"));
  for (let i = 0; i < 4; i++) cards.push(card(setId + "-h" + i, "holo", 12, "Holo Rare"));
  for (let i = 0; i < 3; i++) cards.push(card(setId + "-x" + i, "ultra", 40 + i, "Ultra Rare"));
  return cards;
}

const RANK = { common: 1, uncommon: 2, rare: 3, holo: 4, ultra: 5 };
function assertSlots(pack, slots) {
  assert.ok(pack && pack.cards.length === slots.length, "length " + (pack && pack.cards.length) + " vs " + slots.length);
  const ids = new Set();
  const got = {};
  pack.cards.forEach(item => {
    assert.ok(item.id);
    assert.equal(ids.has(item.id), false, item.id);
    ids.add(item.id);
    got[item.slot] = (got[item.slot] || 0) + 1;
    const label = item.priceLabel || Rips.displayPrice(item);
    assert.equal(/NaN|undefined/i.test(label), false, label);
    assert.equal(label === "$0" || label === "$0.00", false, label);
  });
  const expect = {};
  slots.forEach(slot => { expect[slot] = (expect[slot] || 0) + 1; });
  Object.keys(expect).forEach(key => assert.equal(got[key], expect[key], key + " " + JSON.stringify(got)));
  let prev = -1;
  pack.cards.forEach(item => {
    const score = item.finish === "reverse" && item.bucket !== "holo" && item.bucket !== "ultra"
      ? 30
      : (RANK[item.bucket] || 0) * 10;
    assert.ok(score >= prev, item.slot + " " + item.bucket);
    prev = score;
  });
  const last = pack.cards[pack.cards.length - 1];
  assert.equal(last.hit, last.bucket === "holo" || last.bucket === "ultra");
  assert.equal(pack.disclaimer, "Just for fun, not real pull rates.");
}

const tallies = { rare: 0, holo: 0, ultra: 0 };
for (let i = 0; i < 200; i++) {
  const pack = Rips.buildPack(stocked("sv01"), { setId: "sv01", setName: "Test", seed: "modern-" + i });
  assertSlots(pack, Rips.slotsFor("sv01"));
  assert.ok(pack.cards.filter(item => item.slot === "common").every(item => item.bucket === "common"));
  assert.ok(pack.cards.filter(item => item.slot === "uncommon").every(item => item.bucket === "uncommon"));
  const hit = pack.cards.find(item => item.slot === "hit");
  assert.ok(hit && (hit.bucket === "rare" || hit.bucket === "holo" || hit.bucket === "ultra"), hit && hit.bucket);
  tallies[hit.bucket] += 1;
}
assert.ok(tallies.ultra >= 4 && tallies.ultra <= 36, "ultra hits " + tallies.ultra);
assert.ok(tallies.holo >= 20 && tallies.holo <= 80, "holo hits " + tallies.holo);
assert.ok(tallies.rare >= 80, "rare hits " + tallies.rare);
const again = Rips.buildPack(stocked("sv01"), { setId: "sv01", setName: "Test", seed: "modern-3" });
const once = Rips.buildPack(stocked("sv01"), { setId: "sv01", setName: "Test", seed: "modern-3" });
assert.deepEqual(again.cards.map(item => item.id), once.cards.map(item => item.id));

const vintage = Rips.buildPack(stocked("base1"), { setId: "base1", setName: "Base", seed: "vintage" });
assertSlots(vintage, Rips.slotsFor("base1"));
assert.equal(vintage.cards.filter(item => item.finish === "reverse").length, 0);
assert.equal(vintage.cards.filter(item => item.slot === "common" && item.bucket === "common").length, 7);
const aquapolis = Rips.buildPack(stocked("ecard2"), { setId: "ecard2", setName: "Aquapolis", seed: "ecard" });
assertSlots(aquapolis, Rips.slotsFor("ecard2"));
assert.equal(aquapolis.cards.filter(item => item.finish === "reverse").length, 1);
const mid = Rips.buildPack(stocked("ex1"), { setId: "ex1", setName: "Ruby", seed: "mid" });
assertSlots(mid, Rips.slotsFor("ex1"));
assert.equal(mid.cards.filter(item => item.slot === "hit").length, 1);

const rares = [];
for (let i = 0; i < 8; i++) rares.push(card("sv03-r" + i, "rare", i === 0 ? 0 : 4, "Rare"));
rares[1].price = NaN;
rares[2].price = 0;
const degraded = Rips.buildPack(rares, { setId: "sv03", setName: "Only rares", seed: "degrade" });
assert.ok(degraded && degraded.cards.length === 8);
assert.ok(degraded.cards.every(item => item.id && item.bucket === "rare"));
assert.equal(degraded.value.label.includes("NaN"), false);
assert.equal(degraded.value.label === "$0" || degraded.value.label === "$0.00", false);
assert.ok(degraded.value.total > 0);
const thin = [];
for (let i = 0; i < 4; i++) thin.push(card("me01-" + i, "holo", null, "Holo Rare"));
const shortPack = Rips.buildPack(thin, { setId: "me01", setName: "Short", seed: "short" });
assert.ok(shortPack && shortPack.cards.length === 4);
assert.equal(Rips.buildPack(thin.slice(0, 3), { setId: "me01", seed: "too-few" }), null);
assert.equal(Rips.packValue([{ price: NaN }, { price: 0 }, { price: null }]).label, "No price yet");
assert.match(Rips.packValue([{ price: NaN }, { price: 0 }, { price: null }]).note, /bulk/i);
assert.equal(Rips.packValue([{ price: 1.25 }, { price: NaN }, { price: 0 }]).label, "$1.25");
assert.match(Rips.packValue([{ price: 1.25 }, { price: NaN }, { price: 0 }]).note, /1 priced card/);
assert.match(Rips.packValue([{ price: 1.25 }, { price: NaN }, { price: 0 }]).note, /bulk/i);
const swapped = Rips.swapBroken(vintage, 0, stocked("base1"));
assert.notEqual(swapped.cards[0].id, vintage.cards[0].id);
assert.equal(swapped.cards.length, vintage.cards.length);
assert.equal(swapped.cards[0].slot, vintage.cards[0].slot);

const catalog = Rips.buildCatalog({
  cards: {
    "sv01-1": { name: "Pika", history: [{ d: "2026/10/01", v: "normal", m: 1.5 }, { d: "2026/10/02", v: "normal", m: 0 }, { d: "2026/10/02", v: "normal", m: NaN }] },
    "sv01-2": { name: "Nope", history: [{ d: "2026/10/01", v: "normal", m: 0 }] },
    "sv01-3": { name: "Tiny", history: [{ d: "2026/10/01", v: "normal", m: 0.004 }] }
  },
  seedText: "",
  pool: [],
  extras: [
    { id: "sv01-1", name: "Pika", rarity: "Common", set: "Scarlet" },
    { id: "sv01-2", name: "Nope", rarity: "Common", set: "Scarlet" },
    { id: "sv01-3", name: "Tiny", rarity: "Uncommon", set: "Scarlet" },
    { id: "sv01-4", name: "Rare", rarity: "Rare", set: "Scarlet" },
    { id: "sv01-5", name: "Blank", rarity: "", set: "Scarlet" },
    { id: "tiny-1", name: "Only", rarity: "Rare" },
    { id: "tiny-2", name: "Two", rarity: "Rare" },
    { id: "tiny-3", name: "Three", rarity: "Rare" }
  ],
  names: { sv01: "Scarlet & Violet" }
});
const listed = Rips.listSets(catalog).map(set => set.id);
assert.ok(listed.includes("sv01"), listed.join(","));
assert.equal(listed.includes("tiny"), false, "three cards stay hidden");
const sv = catalog.sets.find(set => set.id === "sv01");
assert.equal(sv.cards.some(item => item.id === "sv01-5"), false);
const priced = sv.cards.find(item => item.id === "sv01-1");
assert.equal(priced.price, 1.5);
assert.equal(priced.priceLabel, "$1.50");
const missing = sv.cards.find(item => item.id === "sv01-2");
assert.equal(missing.price, null);
assert.equal(missing.priceLabel, "No price yet");
const dealt = Rips.buildPack(sv.cards, { setId: "sv01", setName: sv.name, seed: "catalog" });
assert.ok(dealt && dealt.cards.length >= 4);
dealt.cards.forEach(item => {
  const label = Rips.priceLabel(item.price);
  assert.equal(label === "$0" || label === "$0.00" || label.includes("NaN"), false);
});

function memory() {
  const bag = new Map();
  return {
    getItem(key) { return bag.has(key) ? bag.get(key) : null; },
    setItem(key, value) { bag.set(key, String(value)); }
  };
}

const store = memory();
store.setItem("binderhuntWish", "[]");
store.setItem("bh.binders.v1", "{}");
let state = Rips.loadLog(store);
assert.equal(state.rips.length, 0);
assert.equal(state.best, null);
const sample = Rips.buildPack(stocked("base1"), { setId: "base1", setName: "Base", seed: "log" });
state = Rips.recordRip(state, sample, { at: 10, day: "2026-11-19" });
state = Rips.recordRip(state, Object.assign({}, sample, { best: Object.assign({}, sample.best, { price: 1, id: "base1-c0" }), value: { total: 1, priced: 1 } }), { at: 11, day: "2026-11-19" });
assert.ok(state.best.price > 1, "a cheaper rip does not replace the best");
state = Rips.recordRip(state, Object.assign({}, sample, { best: { id: "base1-x0", name: "Chase", rarity: "Ultra Rare", bucket: "ultra", price: 80, setId: "base1", setName: "Base" } }), { at: 12, day: "2026-11-19", bonus: true });
assert.equal(state.best.id, "base1-x0");
assert.equal(state.best.price, 80);
assert.equal(state.bonusDay, "2026-11-19");
assert.equal(Rips.bonusReady(state, "2026-11-19"), false);
assert.equal(Rips.bonusReady(state, "2026-11-20"), true);
assert.equal(Rips.saveLog(store, state), true);
const loaded = Rips.loadLog(store);
assert.equal(loaded.rips.length, 3);
assert.equal(loaded.best.price, 80);
assert.equal(loaded.bonusDay, "2026-11-19");
assert.equal(store.getItem("binderhuntWish"), "[]");
assert.equal(store.getItem("bh.binders.v1"), "{}");
store.setItem(Rips.KEY, JSON.stringify({
  v: 1,
  bonusDay: "2026-11-01",
  best: { id: "base1-4", name: "Charizard", rarity: "Holo Rare", bucket: "holo", price: 12, setId: "base1", setName: "Base Set", at: 4 },
  rips: [{
    at: 4,
    day: "2026-11-01",
    setId: "base1",
    setName: "Base Set",
    total: 12,
    priced: 1,
    cards: [{ id: "base1-4", name: "Charizard", rarity: "Holo Rare", bucket: "holo", price: 12, setId: "base1", setName: "Base Set" }],
    best: { id: "base1-4", name: "Charizard", rarity: "Holo Rare", bucket: "holo", price: 12, setId: "base1", setName: "Base Set" }
  }]
}));
const migrated = Rips.loadLog(store);
assert.equal(migrated.v, 1);
assert.equal(migrated.rips.length, 1);
assert.equal(migrated.rips[0].cards[0].id, "base1-4");
assert.equal(migrated.rips[0].cards[0].price, 12);
assert.equal(migrated.best.id, "base1-4");
assert.equal(migrated.bonusDay, "2026-11-01");
assert.equal(Rips.saveLog(store, migrated), true);
assert.equal(Rips.loadLog(store).best.price, 12);
store.setItem(Rips.KEY, "{");
assert.equal(Rips.loadLog(store).rips.length, 0);
let capped = Rips.normalizeLog(null);
for (let i = 0; i < 55; i++) {
  capped = Rips.recordRip(capped, {
    setId: "sv01",
    setName: "S",
    cards: [{ id: "sv01-" + i, name: "N", rarity: "Rare", bucket: "rare", price: 1 }],
    value: { total: 1, priced: 1 },
    best: { id: "sv01-" + i, name: "N", rarity: "Rare", bucket: "rare", price: i + 1, setId: "sv01", setName: "S" }
  }, { at: i + 1 });
}
assert.equal(capped.rips.length, 50);
assert.equal(capped.rips[0].at, 6);
assert.equal(capped.rips[capped.rips.length - 1].at, 55);
assert.equal(capped.best.price, 55);
assert.equal(Rips.recordRip(capped, null, {}).rips.length, 50);

const setsForBonus = [{ id: "base1" }, { id: "sv01" }, { id: "ecard2" }];
assert.equal(Rips.bonusSetId(setsForBonus, "2026-11-19", "sv01"), "sv01");
assert.equal(Rips.bonusSetId(setsForBonus, "2026-11-19", "missing"), Rips.bonusSetId(setsForBonus, "2026-11-19", ""));
assert.ok(setsForBonus.some(set => set.id === Rips.bonusSetId(setsForBonus, "2026-11-19", "")));

const cache = JSON.parse(readFileSync(resolve(root, "data/scrydex.json"), "utf8"));
const seedText = readFileSync(resolve(root, "data/scrydex-seed.txt"), "utf8");
const daily = JSON.parse(readFileSync(resolve(root, "data/daily.json"), "utf8"));
const real = Rips.buildCatalog({ cards: cache.cards, seedText, pool: daily.pool });
assert.ok(real.sets.length >= 20, "rippable sets " + real.sets.length);
real.sets.forEach(set => {
  assert.ok(set.cards.length >= Rips.MIN_CARDS, set.id);
  const pack = Rips.buildPack(set.cards, { setId: set.id, setName: set.name, seed: "real-" + set.id });
  assert.ok(pack && pack.cards.length >= 4, "empty " + set.id);
  const seen = new Set();
  pack.cards.forEach(item => {
    assert.ok(item && item.id && !seen.has(item.id));
    seen.add(item.id);
    const label = item.priceLabel || Rips.priceLabel(item.price);
    assert.equal(label.includes("NaN"), false, item.id);
    assert.equal(label === "$0" || label === "$0.00", false, item.id + " " + label);
  });
  const last = RANK[pack.cards[pack.cards.length - 1].bucket] || 0;
  pack.cards.forEach(item => assert.ok((RANK[item.bucket] || 0) <= last, set.id));
  const total = pack.value.label;
  assert.ok(total === "No price yet" || /^\$\d/.test(total), set.id + " " + total);
  assert.equal(/NaN|\$0(?:\.00)?$/.test(total), false, total);
});
const poolsFile = resolve(root, "data/pack-pools.json");
const pools = JSON.parse(readFileSync(poolsFile, "utf8"));
assert.equal(pools.v, 1);
assert.equal(pools.source, "tcgdex");
["base1", "ecard2", "ecard3", "ex1", "swsh7", "sv01", "sv08", "me02"].forEach(id => {
  assert.ok(pools.sets[id], "missing pool " + id);
  assert.ok(pools.sets[id].c.length >= 4, id + " commons");
  assert.ok(pools.sets[id].u.length >= 2, id + " uncommons");
  assert.ok(pools.sets[id].r.length + pools.sets[id].h.length + pools.sets[id].x.length > 0, id + " rare slot");
});
const pooled = Rips.buildCatalog({ cards: cache.cards, seedText, pool: daily.pool, pools });
function ripSet(setId, seed) {
  const set = pooled.sets.find(item => item.id === setId);
  assert.ok(set && set.pooled, setId);
  const pack = Rips.buildPack(set.cards, { setId, setName: set.name, seed, requireArt: true });
  assert.ok(pack, setId);
  assertSlots(pack, Rips.slotsFor(setId));
  pack.cards.forEach(card => {
    assert.ok(card.thumb || card.img || card.backup, card.id + " image");
    assert.equal(/undefined|NaN/.test(String(card.name) + String(card.priceLabel) + String(card.rarity)), false, card.id);
    if (card.price == null) assert.ok(card.priceLabel === "Bulk" || card.priceLabel === "No price yet", card.id + " " + card.priceLabel);
  });
  return pack;
}
function hitRates(setId, count) {
  const hits = { rare: 0, holo: 0, ultra: 0 };
  let reverses = 0;
  for (let i = 0; i < count; i++) {
    const pack = ripSet(setId, setId + "-pool-" + i);
    const hit = pack.cards.find(card => card.slot === "hit");
    hits[hit.bucket] += 1;
    reverses += pack.cards.filter(card => card.finish === "reverse").length;
  }
  return { hits, reverses };
}
const baseRates = hitRates("base1", 80);
assert.ok(baseRates.hits.rare > baseRates.hits.holo + baseRates.hits.ultra, "base rare slot " + JSON.stringify(baseRates));
assert.equal(baseRates.reverses, 0);
const aquaRates = hitRates("ecard2", 40);
assert.ok(aquaRates.reverses >= 40, "aquapolis reverse " + aquaRates.reverses);
assert.ok(aquaRates.hits.rare > aquaRates.hits.holo, "aquapolis rare slot " + JSON.stringify(aquaRates.hits));
const sky = ripSet("ecard3", "skyridge");
assert.equal(sky.cards.length, 9);
assert.ok(sky.cards.some(card => card.finish === "reverse"));
const modernRates = hitRates("sv08", 40);
assert.ok(modernRates.hits.rare > modernRates.hits.holo, "modern rare slot " + JSON.stringify(modernRates.hits));
assert.ok(modernRates.reverses >= 40, "modern foil slots");
const probePacks = [ripSet("base1", "probe-base"), ripSet("ecard2", "probe-aqua"), ripSet("sv08", "probe-sv")];
console.log("rips math ok", { sets: real.sets.length, pooled: pooled.sets.length, hits: tallies, base: baseRates.hits, modern: modernRates.hits });
const probeUrls = [];
probePacks.forEach(pack => pack.cards.forEach(card => { if (card.thumb && probeUrls.indexOf(card.thumb) === -1) probeUrls.push(card.thumb); }));
for (const url of probeUrls) {
  const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-64" } });
  assert.ok(res.ok || res.status === 206, url + " " + res.status);
  assert.match(res.headers.get("content-type") || "", /image\//, url);
}
console.log("pack images ok", probeUrls.length);

const PORT = 8819;
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
mkdirSync("/opt/cursor/artifacts", { recursive: true });

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const problems = [];
const consoleErrors = [];
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
      const res = await fetch("http://127.0.0.1:" + PORT + "/js/rips.js", { signal: AbortSignal.timeout(500) });
      if (res.ok) { await res.arrayBuffer(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("local server did not start");
}

const boot = `(() => {
  const bag = {};
  new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date()).forEach(part => { bag[part.type] = part.value; });
  localStorage.setItem("bh.onboard.v1", JSON.stringify({done:true,skipped:true}));
  localStorage.setItem("bh.filters.v3", JSON.stringify({set:"",rarities:[],era:"",type:"",names:[],min:null,max:null,pricePreset:"",graded:false}));
  localStorage.setItem("bh.binders.v1", JSON.stringify({discoveryId:"",binders:[]}));
  localStorage.setItem("bh.settings.v1", JSON.stringify({sound:false,haptics:false,reduce:"off",currency:"USD"}));
  localStorage.setItem("bh.owned.v1", JSON.stringify({v:1,ids:[],sets:{},celebrated:[],seeded:true}));
  localStorage.setItem("binderhuntWish", "[]");
  localStorage.setItem("bh.daily.v1", JSON.stringify({ v:1, current:0, best:0, lastPlayed:"", prompted: bag.year + "-" + bag.month + "-" + bag.day, days:{} }));
  localStorage.removeItem("bh.rips.v1");
  window.__imgErrors = [];
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target.tagName === "IMG") window.__imgErrors.push(target.currentSrc || target.src || "img");
  }, true);
})();`;

function watch(page) {
  page.on("pageerror", err => consoleErrors.push("pageerror: " + String(err && err.message || err).split("\n")[0]));
  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const where = msg.location && msg.location();
    if (text) consoleErrors.push((text.split("\n")[0] + (where && where.url ? " @ " + where.url : "")).slice(0, 300));
  });
  page.on("response", res => {
    if (res.status() < 500) return;
    consoleErrors.push("HTTP " + res.status() + " " + res.url().slice(0, 240));
  });
  page.on("request", req => {
    const url = req.url();
    if (/api\.scrydex\.com|scrydex\.com\/v/i.test(url)) consoleErrors.push("unexpected Scrydex request " + url);
  });
}

async function shot(page, name) {
  const file = "/opt/cursor/artifacts/" + name + ".png";
  await page.screenshot({ path: file });
  console.log("screenshot", file);
}

async function axe(page, label) {
  await page.evaluate(source => {
    if (window.axe) return;
    const script = document.createElement("script");
    script.textContent = source;
    document.head.appendChild(script);
  }, axeSource);
  return page.evaluate(async name => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations.map(item => name + " " + item.id + " " + item.nodes.slice(0, 3).map(node => (node.target || []).join(" ")).join(" | "));
  }, label);
}

function layoutScript() {
  const root = document.getElementById("ripsScroll");
  const text = root ? root.innerText : "";
  const tabs = [...document.querySelectorAll(".tabs .tabbtn")].map(el => ({
    text: el.textContent.replace(/\s+/g, " ").trim(),
    clipped: el.scrollWidth > el.clientWidth + 1,
    box: Math.round(el.getBoundingClientRect().right)
  }));
  const off = [...document.querySelectorAll("#ripsScroll h2, #ripsScroll h3, #ripsScroll button, #ripsScroll .rip-price, #ripsScroll .rip-pack, #ripsScroll .rip-card, #ripsScroll .rip-row")].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && (r.left < -1 || r.right > window.innerWidth + 1);
  }).map(el => (el.textContent || el.className || "").trim().slice(0, 40));
  const broken = [...document.querySelectorAll("#viewRips img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.currentSrc || img.src);
  return { text, tabs, off, broken, screen: root && root.querySelector("[data-screen]") && root.querySelector("[data-screen]").getAttribute("data-screen") };
}

async function tear(page, pointerType) {
  await page.evaluate(type => {
    const el = document.getElementById("ripTear");
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (name, x) => {
      const target = name === "pointerdown" ? el : window;
      target.dispatchEvent(new PointerEvent(name, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: type,
        isPrimary: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: name === "pointerup" ? 0 : 1
      }));
    };
    fire("pointerdown", r.left + 8);
    fire("pointermove", r.left + r.width * 0.45);
    fire("pointermove", r.left + r.width * 0.92);
    fire("pointerup", r.left + r.width * 0.95);
  }, pointerType);
}

await waitServer();
browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.setDefaultTimeout(30000);
watch(page);
await page.addInitScript(boot);
await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("#deck .card img"), null, { timeout: 20000 });
await page.waitForFunction(() => typeof showTab === "function", null, { timeout: 20000 });
const lazy = await page.evaluate(() => ({
  defined: typeof BinderRips !== "undefined",
  tag: !!document.querySelector('script[src="js/rips.js"],script[src="js/rips-ui.js"]')
}));
note(lazy.defined === false && lazy.tag === false, "rips files stay unloaded until the tab is opened", JSON.stringify(lazy));
await page.evaluate(() => {
  const prompt = document.getElementById("dropPrompt");
  if (prompt) prompt.hidden = true;
  const shell = document.getElementById("shell");
  if (shell) shell.removeAttribute("inert");
});

await page.locator(".tabs [data-tab=rips]").click();
await page.waitForSelector("#ripTitle", { timeout: 20000 });
await page.waitForFunction(() => typeof scrydex !== "undefined" && scrydex.ready, null, { timeout: 60000 });
await page.waitForFunction(() => {
  const root = document.getElementById("ripsScroll");
  return root && root.innerText.includes("Just for fun") && root.querySelector("[data-rip-set]");
}, null, { timeout: 20000 });
const picker = await page.evaluate(layoutScript);
note(picker.screen === "picker", "set picker is showing", picker.screen);
note(/Just for fun, not real pull rates/.test(picker.text), "disclaimer is on the picker");
note(!picker.tabs.some(tab => tab.clipped), "tab labels are not clipped", JSON.stringify(picker.tabs));
note(picker.tabs.every(tab => tab.box <= 391), "tabs stay inside 390px", JSON.stringify(picker.tabs));
note(!picker.off.length, "picker stays inside 390px", picker.off.join(" | "));
const pickerAxe = await axe(page, "rips-picker-390");
note(!pickerAxe.length, "0 axe violations on the picker at 390", pickerAxe.join(" || "));

async function ripToSummary(labelQuery, setId) {
  await page.locator("#ripFind").fill(labelQuery);
  await page.locator("[data-rip-set='" + setId + "']").click();
  await page.waitForSelector("#ripTear");
  await page.locator("#ripOpen").click();
  await page.waitForSelector("[data-screen=reveal]");
  for (let i = 0; i < 40; i++) {
    const screen = await page.evaluate(() => {
      const node = document.querySelector("#ripsScroll [data-screen]");
      return node ? node.getAttribute("data-screen") : "";
    });
    if (screen === "summary") break;
    await page.locator("#ripAdvance").click();
  }
  await page.waitForSelector("[data-screen=summary]");
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll("#viewRips img")];
    return imgs.length > 0 && imgs.every(img => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 15000 }).catch(() => {});
}

await ripToSummary("Base Set", "base1");
await shot(page, "after-base-summary-390");
const baseSummary = await page.evaluate(layoutScript);
const baseCommons = (baseSummary.text.match(/\bCommon\b/g) || []).length;
note(baseCommons >= 5, "base pack shows commons, not a stack of holos", String(baseCommons) + " " + baseSummary.text.slice(0, 280));
note(!baseSummary.text.includes("NaN") && !/undefined|\$0(?:\.00)?\b/.test(baseSummary.text), "base summary has no NaN, undefined, or $0");
note(!baseSummary.broken.length && !baseSummary.off.length, "base summary images and layout at 390", baseSummary.broken.join(" | ") + baseSummary.off.join(" | "));
await page.locator("#ripBack").click();
await page.waitForSelector("#ripTitle");

await page.locator("#ripFind").fill("Aquapolis");
await page.locator("[data-rip-set='ecard2']").click();
await page.waitForSelector("#ripTear");
await shot(page, "rip-sealed-390");
const sealed = await page.evaluate(layoutScript);
note(sealed.screen === "sealed", "sealed pack is showing");
note(/Tear it open/.test(sealed.text), "keyboard and button fallback is visible");
note(!sealed.off.length, "sealed pack stays inside 390px", sealed.off.join(" | "));
note(!sealed.broken.length, "no broken images on the sealed pack", sealed.broken.join(" | "));
const sealedAxe = await axe(page, "rips-sealed-390");
note(!sealedAxe.length, "0 axe violations on the sealed pack at 390", sealedAxe.join(" || "));

await tear(page, "touch");
await page.waitForSelector("[data-screen=reveal]");
note(true, "touch tear opens the pack");
await page.locator("#ripAdvance").click();
await page.waitForFunction(() => {
  const price = document.getElementById("ripPrice");
  return price && price.textContent && price.textContent !== "";
});
await sleep(500);
await shot(page, "rip-mid-390");
const midView = await page.evaluate(layoutScript);
note(midView.screen === "reveal", "a card is mid-reveal");
note(/No price yet|Bulk|\$\d/.test(midView.text), "the flipped card shows a price, Bulk, or No price yet", midView.text.slice(0, 240));
note(!midView.text.includes("NaN") && !/\$0(?:\.00)?\b/.test(midView.text), "no NaN or $0 on the reveal", midView.text.slice(0, 300));
note(!midView.off.length, "reveal stays inside 390px", midView.off.join(" | "));
await page.waitForFunction(() => {
  const imgs = [...document.querySelectorAll("#viewRips img")];
  return imgs.every(img => !img.isConnected || (img.complete && img.naturalWidth > 0));
}).catch(() => {});
const midBroken = await page.evaluate(() => [...document.querySelectorAll("#viewRips img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.src));
note(!midBroken.length, "no broken images mid-reveal", midBroken.join(" | "));
const midAxe = await axe(page, "rips-reveal-390");
note(!midAxe.length, "0 axe violations mid-reveal at 390", midAxe.join(" || "));

const steps = await page.evaluate(() => {
  const step = document.getElementById("ripStep");
  const match = step && step.textContent.match(/of (\d+)/);
  return match ? Number(match[1]) : 0;
});
for (let i = 0; i < steps * 2 + 2; i++) {
  const screen = await page.evaluate(() => {
    const root = document.getElementById("ripsScroll");
    const node = root && root.querySelector("[data-screen]");
    return node ? node.getAttribute("data-screen") : "";
  });
  if (screen === "summary") break;
  await page.locator("#ripAdvance").click();
}
await page.waitForSelector("[data-screen=summary]");
await page.waitForFunction(() => {
  const imgs = [...document.querySelectorAll("#viewRips img")];
  return imgs.every(img => !img.isConnected || (img.complete && img.naturalWidth > 0));
}).catch(() => {});
await shot(page, "rip-summary-390");
const summary = await page.evaluate(layoutScript);
note(summary.screen === "summary", "summary is showing");
note(/pack value/i.test(summary.text) && /best hit/i.test(summary.text), "summary has the total and the best hit", summary.text.slice(0, 240));
note(!summary.text.includes("NaN") && !/\$0(?:\.00)?\b/.test(summary.text), "summary has no NaN or $0");
note(!summary.off.length, "summary stays inside 390px", summary.off.join(" | "));
note(!summary.broken.length, "no broken images on the summary", summary.broken.join(" | "));
const summaryAxe = await axe(page, "rips-summary-390");
note(!summaryAxe.length, "0 axe violations on the summary at 390", summaryAxe.join(" || "));

const beforeWish = await page.evaluate(() => localStorage.getItem("binderhuntWish"));
await page.locator("[data-save]").first().click();
const saved = await page.evaluate(() => {
  const wish = JSON.parse(localStorage.getItem("binderhuntWish") || "[]");
  const card = wish[0] || null;
  const button = document.querySelector("[data-save]");
  return {
    count: wish.length,
    id: card && card.id,
    name: card && card.name,
    price: card && card.price,
    pressed: button && button.getAttribute("aria-pressed"),
    binders: localStorage.getItem("bh.binders.v1"),
    log: JSON.parse(localStorage.getItem("bh.rips.v1") || "null")
  };
});
note(saved.count === 1 && !!saved.id && saved.pressed === "true", "save uses the wishlist", JSON.stringify(saved));
note(saved.price == null || (typeof saved.price === "number" && saved.price > 0), "saved price is not $0", String(saved.price));
note(beforeWish === "[]", "wishlist started empty");
note(saved.binders === localStorageBinders(), "binders storage stays put");
note(saved.log && saved.log.v === 1 && saved.log.rips.length >= 1 && saved.log.rips.length <= 50, "pull log kept the rips", JSON.stringify(saved.log && saved.log.rips && saved.log.rips.length));
const bestPrice = saved.log && saved.log.best && saved.log.best.price;
const anyPriced = saved.log && saved.log.rips[0] && saved.log.rips[0].cards.some(card => typeof card.price === "number" && card.price > 0);
note(!anyPriced || (typeof bestPrice === "number" && bestPrice > 0), "a priced card becomes the best pull", JSON.stringify(saved.log && saved.log.best));
note(bestPrice == null || (typeof bestPrice === "number" && bestPrice > 0), "best pull is not $0", String(bestPrice));

function localStorageBinders() { return "{\"discoveryId\":\"\",\"binders\":[]}"; }

await page.locator("#ripBack").click();
await page.waitForSelector("#ripTitle");
await ripToSummary("Surging", "sv08");
await shot(page, "after-modern-summary-390");
const modernSummary = await page.evaluate(layoutScript);
note(/Common/.test(modernSummary.text) && /Reverse holo|Uncommon/.test(modernSummary.text), "modern pack has commons and a foil slot", modernSummary.text.slice(0, 320));
note(!modernSummary.text.includes("NaN") && !/undefined|\$0(?:\.00)?\b/.test(modernSummary.text), "modern summary is clean");
note(!modernSummary.broken.length && !modernSummary.off.length, "modern summary at 390", modernSummary.broken.join(" | ") + modernSummary.off.join(" | "));
await page.locator("#ripBack").click();
await page.waitForSelector("#ripTitle");

await page.locator(".tabs [data-tab=hunt]").click();
await page.waitForSelector("#deck .card img");
const firstName = await page.locator("#capName").innerText().catch(() => "");
await page.waitForFunction(() => {
  const skip = document.getElementById("skip");
  return skip && !skip.disabled;
}, null, { timeout: 20000 });
await page.locator("#skip").click();
await page.waitForFunction(prev => {
  const name = document.getElementById("capName");
  const card = document.querySelector("#deck .card img");
  return card && name && name.textContent && name.textContent !== prev;
}, firstName, { timeout: 20000 }).catch(() => {});
const deck = await page.evaluate(() => ({
  cards: document.querySelectorAll("#deck .card").length,
  name: (document.getElementById("capName") || {}).textContent || "",
  img: !!document.querySelector("#deck .card img")
}));
note(deck.cards >= 1 && deck.img, "swipe deck still has a card after ripping", JSON.stringify(deck));

await page.setViewportSize({ width: 1440, height: 900 });
await page.locator(".rail [data-tab=rips]").click();
const backWide = page.locator("#ripBack");
if (await backWide.count()) await backWide.click();
await page.waitForSelector("#ripTitle");
await page.waitForSelector("[data-screen=picker]");
const widePicker = await page.evaluate(() => {
  const rail = [...document.querySelectorAll(".rail .tabbtn")].map(el => ({
    text: el.textContent.replace(/\s+/g, " ").trim(),
    clipped: el.scrollWidth > el.clientWidth + 1
  }));
  return { rail, text: document.getElementById("ripsScroll").innerText };
});
note(!widePicker.rail.some(tab => tab.clipped), "rail labels are not clipped", JSON.stringify(widePicker.rail));
note(/Just for fun/.test(widePicker.text), "wide picker still explains the mode");
await page.locator("#ripFind").fill("Skyridge");
await page.locator("[data-rip-set='ecard3']").click();
await page.waitForSelector("#ripTear");
await shot(page, "rip-sealed-1440");
const box = await page.locator("#ripTear").boundingBox();
await page.mouse.move(box.x + 10, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForSelector("[data-screen=reveal]", { timeout: 5000 }).catch(() => {});
let wideScreen = await page.evaluate(() => {
  const node = document.querySelector("#ripsScroll [data-screen]");
  return node ? node.getAttribute("data-screen") : "";
});
if (wideScreen !== "reveal") {
  await tear(page, "mouse");
  await page.waitForSelector("[data-screen=reveal]");
  wideScreen = "reveal";
}
note(wideScreen === "reveal", "mouse tear opens the pack");
await page.locator("#ripAdvance").click();
await sleep(500);
await shot(page, "rip-mid-1440");
const wideSteps = await page.evaluate(() => {
  const step = document.getElementById("ripStep");
  const match = step && step.textContent.match(/of (\d+)/);
  return match ? Number(match[1]) : 8;
});
for (let i = 0; i < wideSteps * 2 + 2; i++) {
  const screen = await page.evaluate(() => {
    const node = document.querySelector("#ripsScroll [data-screen]");
    return node ? node.getAttribute("data-screen") : "";
  });
  if (screen === "summary") break;
  await page.locator("#ripAdvance").click();
}
await page.waitForSelector("[data-screen=summary]");
await shot(page, "rip-summary-1440");
await shot(page, "after-skyridge-summary-1440");
const wide = await page.evaluate(layoutScript);
note(!wide.off.length, "summary stays inside 1440px", wide.off.join(" | "));
note(!wide.text.includes("NaN"), "no NaN at 1440");
const wideAxe = await axe(page, "rips-summary-1440");
note(!wideAxe.length, "0 axe violations on the summary at 1440", wideAxe.join(" || "));
const wideBroken = await page.evaluate(() => [...document.querySelectorAll("#viewRips img")].filter(img => img.complete && img.naturalWidth === 0).map(img => img.src));
note(!wideBroken.length, "no broken images at 1440", wideBroken.join(" | "));
await page.locator("#ripBack").click();
await page.waitForSelector("#ripTitle");
await ripToSummary("Base Set", "base1");
await shot(page, "after-base-summary-1440");
const wideBase = await page.evaluate(layoutScript);
note((wideBase.text.match(/\bCommon\b/g) || []).length >= 5, "base pack at 1440 is not all holos", wideBase.text.slice(0, 240));
note(!wideBase.off.length && !wideBase.broken.length, "base summary stays inside 1440 and images load", wideBase.off.join(" | ") + wideBase.broken.join(" | "));
note(!wideBase.text.includes("NaN") && !/undefined|\$0(?:\.00)?\b/.test(wideBase.text), "base summary at 1440 is clean");

note(!consoleErrors.length, "no console errors", consoleErrors.slice(0, 6).join(" | "));

if (problems.length) {
  console.log("FAILED", problems.length);
  problems.forEach(item => console.log(" -", item));
  await shutdown(1);
}
console.log("rips browser ok");
await shutdown(0);
