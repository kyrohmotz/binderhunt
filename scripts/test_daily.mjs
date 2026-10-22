// Date boundary, guess bands, and streak rules for the Daily Drop.
// Run: node scripts/test_daily.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import daily from "../js/daily-core.js";

const {
  addDays, daysBetween, nyDateISO, msUntilNextNyDay, formatRemain,
  pickDrop, judgeGuess, feedbackLine, applyStreak, shareText, dropNumber,
  profileUsd, cardmarketQuote, convertEur, fallbackQuote, lockQuote,
  parseGuess, sanitizeGuess, readGuess, speciesName, wishFields, showPrinting,
  mergeQuotes, snapshotQuote, quoteForPlay
} = daily;

function check(name, fn) {
  try {
    fn();
    console.log("ok", name);
  } catch (error) {
    console.error("FAIL", name);
    throw error;
  }
}

check("calendar add and diff ignore the clock", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(daysBetween("2026-10-17", "2026-10-17"), 0);
  assert.equal(daysBetween("2026-11-01", "2026-11-02"), 1);
  assert.equal(dropNumber("2026-10-17", "2026-10-17"), 1);
  assert.equal(dropNumber("2026-10-17", "2026-10-28"), 12);
});

check("New York day boundary, including DST", () => {
  // Spring forward: 2026-03-08 02:00 EST becomes 03:00 EDT. Midnight is still 05:00 UTC.
  assert.equal(nyDateISO(new Date("2026-03-08T04:59:59Z")), "2026-03-07");
  assert.equal(nyDateISO(new Date("2026-03-08T05:00:00Z")), "2026-03-08");
  assert.equal(nyDateISO(new Date("2026-03-08T06:30:00Z")), "2026-03-08");
  // Fall back: 2026-11-01 02:00 EDT becomes 01:00 EST. Midnight starts at 04:00 UTC.
  assert.equal(nyDateISO(new Date("2026-11-01T03:59:59Z")), "2026-10-31");
  assert.equal(nyDateISO(new Date("2026-11-01T04:00:00Z")), "2026-11-01");
  assert.equal(nyDateISO(new Date("2026-11-01T05:30:00Z")), "2026-11-01");
  assert.equal(nyDateISO(new Date("2026-11-01T06:30:00Z")), "2026-11-01");
  // Summer (EDT, UTC-4) and winter (EST, UTC-5).
  assert.equal(nyDateISO(new Date("2026-07-04T03:59:00Z")), "2026-07-03");
  assert.equal(nyDateISO(new Date("2026-07-04T04:00:00Z")), "2026-07-04");
  assert.equal(nyDateISO(new Date("2026-01-15T04:59:00Z")), "2026-01-14");
  assert.equal(nyDateISO(new Date("2026-01-15T05:00:00Z")), "2026-01-15");
});

check("countdown lands on the next New York midnight", () => {
  const noon = new Date("2026-10-17T16:00:00Z");
  assert.equal(msUntilNextNyDay(noon), 12 * 3600000);
  assert.equal(formatRemain(12 * 3600000), "Next drop in 12h 0m");
  // 00:30 EST on the spring-forward morning. The local day is 23 hours, so
  // midnight tonight is 22.5 hours away.
  const spring = new Date("2026-03-08T05:30:00Z");
  assert.equal(msUntilNextNyDay(spring), 22.5 * 3600000);
  // 00:30 EDT on the fall-back morning. The local day is 25 hours.
  const fall = new Date("2026-11-01T04:30:00Z");
  assert.equal(msUntilNextNyDay(fall), 24.5 * 3600000);
  assert.equal(formatRemain(45 * 1000), "Next drop in 45s");
  assert.equal(formatRemain(90 * 1000), "Next drop in 1m 30s");
});

check("the same New York date always picks the same priced card", () => {
  const data = {
    epoch: "2026-10-17",
    days: ["free", "priced", "third"],
    pool: [
      { id: "free", price: 0, name: "No Price" },
      { id: "priced", price: 12.5, name: "Yes" },
      { id: "third", price: 40, name: "Third" },
      { id: "spare", price: 8, name: "Spare" }
    ]
  };
  const first = pickDrop(data, "2026-10-17");
  const again = pickDrop(data, "2026-10-17");
  assert.equal(first.card.id, again.card.id);
  assert.ok(first.card.price >= 1);
  assert.notEqual(first.card.id, "free");
  assert.equal(first.scheduled, false);
  assert.equal(pickDrop(data, "2026-10-18").card.id, "priced");
  assert.equal(pickDrop(data, "2026-10-18").n, 2);
  assert.equal(pickDrop(data, "2026-10-19").card.id, "third");
  const past = pickDrop(data, "2028-01-01");
  assert.equal(past.card.id, pickDrop(data, "2028-01-01").card.id);
  assert.ok(past.card.price >= 1);
  const early = pickDrop(data, nyDateISO(new Date("2026-11-01T03:59:59Z")));
  const late = pickDrop(data, nyDateISO(new Date("2026-11-01T04:00:00Z")));
  assert.equal(early.date, "2026-10-31");
  assert.equal(late.date, "2026-11-01");
  assert.notEqual(early.card.id, late.card.id);
});

check("guess bands are higher/lower plus closeness", () => {
  const exact = judgeGuess(20, 20);
  assert.equal(exact.band, "hit");
  assert.equal(exact.direction, "spot");
  assert.equal(exact.trend, "");
  assert.equal(feedbackLine(exact), "Dead on!");

  const edge = judgeGuess(21, 20);
  assert.equal(edge.band, "hit");
  assert.equal(edge.direction, "lower");
  assert.equal(feedbackLine(edge), "Nailed it");

  const justOut = judgeGuess(21.02, 20);
  assert.equal(justOut.band, "warm");
  assert.equal(justOut.direction, "lower");

  assert.equal(judgeGuess(16, 20).band, "warm");
  assert.equal(judgeGuess(16, 20).direction, "higher");
  assert.equal(judgeGuess(15.9, 20).band, "cool");
  assert.equal(judgeGuess(11, 20).band, "cool");
  assert.equal(judgeGuess(10, 20).band, "cold");
  assert.equal(judgeGuess(30, 20).direction, "lower");
  assert.equal(judgeGuess(30, 20).band, "cold");

  // A $2 card still counts a 40 cent miss as a hit.
  assert.equal(judgeGuess(2.4, 2).band, "hit");
  assert.equal(judgeGuess(2.6, 2).band, "cool");

  const warmer = judgeGuess(18, 20, 10);
  assert.equal(warmer.trend, "warmer");
  assert.equal(warmer.direction, "higher");
  assert.equal(feedbackLine(warmer), "Higher · Warmer · Warm");
  const colder = judgeGuess(10, 20, 19);
  assert.equal(colder.trend, "colder");
  assert.equal(judgeGuess(18, 20, 18.01).trend, "same");
  assert.equal(judgeGuess(0, 20), null);
  assert.equal(judgeGuess(12, 0), null);
  assert.equal(judgeGuess("nope", 20), null);
});

check("streaks count finished days and ignore replays", () => {
  let state = applyStreak(null, "2026-10-17");
  assert.equal(state.current, 1);
  assert.equal(state.best, 1);
  assert.equal(state.repeated, false);
  state = applyStreak(state, "2026-10-18");
  assert.equal(state.current, 2);
  assert.equal(state.best, 2);
  const replay = applyStreak(state, "2026-10-18");
  assert.equal(replay.repeated, true);
  assert.equal(replay.current, 2);
  assert.equal(replay.best, 2);
  state = applyStreak(state, "2026-10-20");
  assert.equal(state.current, 1);
  assert.equal(state.best, 2);
  state = applyStreak(state, "2026-10-21");
  assert.equal(state.current, 2);
  assert.equal(state.best, 2);
  state = applyStreak(state, "2026-10-22");
  assert.equal(state.current, 3);
  assert.equal(state.best, 3);
});

check("share text is one puzzle line plus the site", () => {
  assert.equal(
    shareText({ n: 12, bands: ["hit", "warm"], solved: true, guessesUsed: 2 }),
    "🐸 BinderHunt Daily #12 🟩🟨▪️ 2/3\nhttps://kyrohmotz.github.io/binderhunt/"
  );
  assert.equal(
    shareText({ n: 3, bands: ["cold", "cool", "warm"], solved: false, guessesUsed: 3 }),
    "🐸 BinderHunt Daily #3 ⬜🟨🟨 X/3\nhttps://kyrohmotz.github.io/binderhunt/"
  );
});

check("the daily answer is the profile's cheapest printing", () => {
  const quote = profileUsd([
    { key: "holofoil", label: "Holofoil", market: 19.22 },
    { key: "normal", label: "Normal", market: 3.97 },
    { key: "reverseHolofoil", label: "Reverse Holofoil", market: 4.5, mid: 1 }
  ]);
  assert.equal(quote.price, 3.97);
  assert.equal(quote.variant, "normal");
  assert.equal(quote.alts, 3);
  assert.equal(showPrinting(quote), true);
  assert.equal(profileUsd([{ key: "holofoil", market: 150, low: 1 }]).price, 150);
  assert.equal(profileUsd([{ key: "holofoil", mid: 80, low: 40 }]), null);
  assert.equal(showPrinting(profileUsd([{ key: "normal", label: "Normal", market: 12 }])), false);
  assert.equal(showPrinting({ variant: "reverse-holofoil", printing: "Reverse Holofoil", alts: 1 }), true);

  const fromPrinting = cardmarketQuote({
    printings: [{ label: "Holofoil", avg: 68.65, trend: 150 }],
    cm: { avg: 10, trend: 400, avg7: 90, avg30: 80, avg1: 70 }
  });
  assert.equal(fromPrinting.eur, 68.65);
  assert.equal(fromPrinting.label, "Cardmarket average");
  const fromAvg = cardmarketQuote({
    printings: [{ label: "Holofoil", trend: 150, avg7: 90 }],
    cm: { avg: 68.65, trend: 400, avg7: 90 }
  });
  assert.equal(fromAvg.eur, 68.65);
  assert.equal(cardmarketQuote({ cm: { trend: 400, avg7: 90 } }), null);

  assert.equal(convertEur(68.65, 1.1253), 77.25);
  assert.equal(convertEur(10, 1.5), 15);
  assert.notEqual(convertEur(10, 1.5), convertEur(10, 1.1253));
  assert.equal(convertEur(10, 0), 0);

  const stored = fallbackQuote({ source: "tcgplayer", variant: "normal", printing: "Normal", price: 3.97, eur: 2.5, alts: 2 });
  assert.equal(stored.price, 3.97);
  assert.equal(stored.live, false);
  assert.equal(fallbackQuote({ source: "cardmarket", variant: "cardmarket", price: 19.22 }), null);
  assert.equal(fallbackQuote({ variant: "cardmarket", price: 150 }), null);
  assert.equal(fallbackQuote({ source: "tcgplayer", price: 0 }), null);

  const open = { locked: false, price: 0, printing: "" };
  lockQuote(open, { price: 3.97, variant: "normal", printing: "Normal", eur: 2.5, alts: 2, live: true });
  assert.equal(open.locked, true);
  assert.equal(open.price, 3.97);
  assert.equal(open.live, true);
  lockQuote(open, { price: 19.22, variant: "holofoil", printing: "Holofoil", live: true });
  assert.equal(open.price, 3.97);
  assert.equal(open.variant, "normal");
});

check("rejected guesses say what was wrong", () => {
  assert.equal(sanitizeGuess("abc$12.5.0x"), "$12.50");
  assert.equal(parseGuess("12.50").value, 12.5);
  assert.equal(parseGuess("$1,250.50").value, 1250.5);
  assert.equal(parseGuess("12,50").value, 12.5);
  assert.equal(parseGuess("1,250").value, 1250);
  assert.equal(parseGuess("12,5").reason, "comma");
  assert.match(parseGuess("12,5").message, /12,50/);
  assert.equal(parseGuess("nope").reason, "invalid");
  assert.match(parseGuess("nope").message, /isn't a price/);
  assert.equal(parseGuess(".5").value, 0.5);
  assert.equal(parseGuess("$.5").value, 0.5);
  assert.equal(parseGuess(".50").value, 0.5);
  assert.equal(parseGuess(".").reason, "invalid");
  assert.equal(parseGuess("0").reason, "low");
  assert.match(parseGuess("0").message, /above zero/);
  assert.equal(parseGuess("").reason, "low");
  assert.equal(parseGuess("1000001").reason, "high");
  assert.match(parseGuess("1000001").message, /too high/);
  assert.equal(parseGuess("-4").reason, "invalid");
  const letters = readGuess("nope");
  assert.equal(letters.text, "nope");
  assert.match(letters.message, /isn't a price/);
  assert.match(parseGuess(letters.text).message, /isn't a price/);
  assert.doesNotMatch(parseGuess(letters.text).message, /above zero/);
  assert.equal(readGuess(".5").text, ".5");
  assert.equal(parseGuess(readGuess(".5").text).value, 0.5);
  assert.equal(readGuess("abc$12.5.0x").text, "$12.50");
});

check("a daily save keeps the fields a binder matches on", () => {
  const saved = wishFields({
    id: "base1-1",
    name: "Alakazam",
    set: "Base",
    setId: "base1",
    num: "1",
    rarity: "Rare Holo",
    image: "https://assets.tcgdex.net/en/base/base1/1",
    types: ["Psychic"],
    variants: [{ key: "holofoil", market: 40 }]
  });
  assert.equal(saved.id, "base1-1");
  assert.equal(saved.setId, "base1");
  assert.equal(saved.number, "1");
  assert.equal(saved.rarity, "Rare Holo");
  assert.deepEqual(saved.types, ["Psychic"]);
  assert.equal(saved.variants[0].key, "holofoil");
  assert.match(saved.img, /\/high\.webp$/);
  assert.equal(speciesName("Dark Persian"), "Persian");
  assert.equal(speciesName("Team Rocket's Meowth"), "Meowth");
  assert.equal(speciesName("Charizard ex"), "Charizard");
  assert.equal(speciesName("Ho-Oh"), "Ho-Oh");
  assert.equal(speciesName("Pyroar BREAK"), "Pyroar");
  assert.equal(speciesName("Noivern BREAK"), "Noivern");
  assert.equal(speciesName("Golduck BREAK"), "Golduck");
  assert.equal(speciesName("Espeon Prism Star"), "Espeon");
  assert.equal(speciesName("Umbreon Star"), "Umbreon");
  assert.equal(speciesName("Raikou & Entei LEGEND"), "Entei");
  assert.equal(speciesName("Mewtwo LV.X"), "Mewtwo");
  assert.equal(speciesName("Garchomp LVX"), "Garchomp");
  assert.equal(speciesName("Charizard-EX"), "Charizard");
  assert.equal(speciesName("Pikachu-GX"), "Pikachu");
  assert.equal(speciesName("Charizard V"), "Charizard");
  assert.equal(speciesName("Gyarados VMAX"), "Gyarados");
  assert.equal(speciesName("Inteleon VSTAR"), "Inteleon");
  assert.equal(speciesName("Staraptor"), "Staraptor");
  assert.equal(speciesName("Starmie GX"), "Starmie");
  assert.notEqual(speciesName("Pyroar BREAK"), "BREAK");
});

check("committed schedule is a priced, mixed year", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const data = JSON.parse(readFileSync(resolve(root, "data/daily.json"), "utf8"));
  assert.equal(data.v, 1);
  assert.equal(data.tz, "America/New_York");
  assert.match(data.epoch, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.days.length >= 365, "schedule covers at least 365 days");
  const banned = new Set(["swsh12-131", "bw11-RC21", "bw11-RC22", "bw11-RC23", "sv07-174"]);
  const byId = new Map(data.pool.map(card => [card.id, card]));
  const eras = new Set();
  const recent = [];
  let gems = 0;
  let ecards = 0;
  let under50 = 0;
  data.days.forEach((id, index) => {
    const card = byId.get(id);
    assert.ok(card, "day " + (index + 1) + " is in the pool");
    assert.equal(banned.has(card.id), false, card.id + " has no profile USD price");
    assert.equal(card.source, "tcgplayer");
    assert.notEqual(card.variant, "cardmarket");
    assert.ok(card.price >= 1, card.id + " has a usable price");
    assert.equal(fallbackQuote(card).price, card.price);
    assert.match(card.image || "", /^https:\/\/assets\.tcgdex\.net\//);
    assert.ok(card.name && card.setId && card.era);
    assert.ok(Array.isArray(card.types));
    eras.add(card.era);
    if (card.setId === "ecard2" || card.setId === "ecard3") gems += 1;
    if (String(card.setId || "").startsWith("ecard")) ecards += 1;
    if (card.price < 50) under50 += 1;
    const species = speciesName(card.name).toLowerCase();
    if (species) {
      assert.equal(recent.slice(-30).includes(species), false, species + " repeated inside 30 days at " + card.id);
      recent.push(species);
    }
  });
  assert.ok(eras.size >= 6, "eras: " + [...eras].join(", "));
  assert.ok(gems >= 8, "expected Skyridge or Aquapolis cards, saw " + gems);
  assert.ok(ecards / data.days.length <= 0.08, "e-card days " + ecards + "/" + data.days.length);
  assert.ok(under50 / data.days.length >= 0.35, "most days should not be chase prices");
  const opening = pickDrop(data, data.epoch);
  assert.equal(opening.card.id, data.days[0]);
  assert.equal(opening.n, 1);
  assert.equal(pickDrop(data, addDays(data.epoch, 11)).n, 12);
  assert.equal(pickDrop(data, data.epoch).card.id, opening.card.id);
});

check("a shared snapshot is the answer until the day starts", () => {
  const today = "2026-10-21";
  const data = {
    v: 1,
    tz: "America/New_York",
    epoch: today,
    days: ["card-a", "card-b", "card-c", "card-d"],
    pool: [
      { id: "card-a", name: "A", price: 2, source: "tcgplayer", variant: "normal", printing: "Normal" },
      { id: "card-b", name: "B", price: 3, source: "tcgplayer", variant: "normal", printing: "Normal" },
      { id: "card-c", name: "C", price: 4, source: "tcgplayer", variant: "holofoil", printing: "Holofoil" },
      { id: "card-d", name: "D", price: 5, source: "tcgplayer", variant: "normal", printing: "Normal" }
    ],
    quotes: {
      "2026-10-21": { id: "card-a", price: 2.25, variant: "normal", printing: "Normal", alts: 1, source: "tcgplayer", at: "yesterday" },
      "2026-10-22": { id: "card-b", price: 9.5, variant: "reverseHolofoil", printing: "Reverse Holofoil", alts: 2, eur: 8, source: "tcgplayer", at: "yesterday" }
    }
  };
  const todayQuote = data.quotes["2026-10-21"];
  const tomorrowQuote = data.quotes["2026-10-22"];
  const snap = snapshotQuote(data, "2026-10-22");
  assert.equal(snap.snapshot, true);
  assert.equal(snap.price, 9.5);
  assert.equal(snap.variant, "reverseHolofoil");
  assert.notEqual(snap.price, data.pool[1].price);
  assert.equal(snapshotQuote(data, "2026-10-23"), null);
  const wrong = snapshotQuote({ ...data, quotes: { "2026-10-22": { ...tomorrowQuote, id: "card-z" } } }, "2026-10-22");
  assert.equal(wrong, null);
  const open = quoteForPlay(data, "2026-10-22", { locked: false, guesses: [], price: 0 });
  assert.equal(open.price, 9.5);
  assert.equal(open.snapshot, true);
  const started = quoteForPlay(data, "2026-10-22", {
    id: "card-b", locked: true, guesses: [4], price: 3.1, variant: "normal", printing: "Normal", live: true
  });
  assert.equal(started.locked, true);
  assert.equal(started.price, 3.1);
  assert.equal(started.snapshot, false);
  const merged = mergeQuotes(data.quotes, today, {
    "2026-10-20": { id: "card-a", price: 99, variant: "holofoil", printing: "Holofoil", alts: 1, source: "tcgplayer" },
    "2026-10-21": { id: "card-a", price: 88, variant: "holofoil", printing: "Holofoil", alts: 3, source: "tcgplayer", at: "now" },
    "2026-10-22": { id: "card-b", price: 9.5, variant: "reverseHolofoil", printing: "Reverse Holofoil", alts: 2, eur: 8, source: "tcgplayer", at: "now" },
    "2026-10-23": { id: "card-c", price: 11.25, variant: "holofoil", printing: "Holofoil", alts: 2, source: "tcgplayer", at: "now" },
    "2026-10-24": { id: "card-d", price: 40, variant: "normal", printing: "Normal", alts: 1, source: "tcgplayer", at: "now" }
  });
  assert.equal(merged["2026-10-21"], todayQuote);
  assert.equal(merged["2026-10-21"].price, 2.25);
  assert.equal(merged["2026-10-22"], tomorrowQuote);
  assert.equal(merged["2026-10-23"].price, 11.25);
  assert.equal(merged["2026-10-23"].id, "card-c");
  assert.equal(merged["2026-10-24"], undefined);
  assert.equal(merged["2026-10-20"], undefined);
  assert.equal(data.pool[0].price, 2);
  assert.equal(quoteForPlay(data, "2026-10-23", null), null);
});

console.log("daily tests passed");
