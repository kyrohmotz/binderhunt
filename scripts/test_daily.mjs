// Date boundary, guess bands, and streak rules for the Daily Drop.
// Run: node scripts/test_daily.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import daily from "../js/daily-core.js";

const {
  addDays, daysBetween, nyDateISO, msUntilNextNyDay, formatRemain,
  pickDrop, judgeGuess, feedbackLine, applyStreak, shareText, dropNumber
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
  assert.equal(feedbackLine(exact), "Dead on · On it");

  const edge = judgeGuess(21, 20);
  assert.equal(edge.band, "hit");
  assert.equal(edge.direction, "lower");

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
    "🐸 BinderHunt Daily #12 🟩🟨⬜ 2/3\nhttps://kyrohmotz.github.io/binderhunt/"
  );
  assert.equal(
    shareText({ n: 3, bands: ["cold", "cool", "warm"], solved: false, guessesUsed: 3 }),
    "🐸 BinderHunt Daily #3 ⬜🟨🟨 X/3\nhttps://kyrohmotz.github.io/binderhunt/"
  );
});

check("committed schedule is a priced, mixed year", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const data = JSON.parse(readFileSync(resolve(root, "data/daily.json"), "utf8"));
  assert.equal(data.v, 1);
  assert.equal(data.tz, "America/New_York");
  assert.match(data.epoch, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.days.length >= 365, "schedule covers at least 365 days");
  const byId = new Map(data.pool.map(card => [card.id, card]));
  const eras = new Set();
  let gems = 0;
  let under50 = 0;
  data.days.forEach((id, index) => {
    const card = byId.get(id);
    assert.ok(card, "day " + (index + 1) + " is in the pool");
    assert.ok(card.price >= 1, card.id + " has a usable price");
    assert.match(card.image || "", /^https:\/\/assets\.tcgdex\.net\//);
    assert.ok(card.name && card.setId && card.era);
    eras.add(card.era);
    if (card.setId === "ecard2" || card.setId === "ecard3") gems += 1;
    if (card.price < 50) under50 += 1;
  });
  assert.ok(eras.size >= 6, "eras: " + [...eras].join(", "));
  assert.ok(gems >= 8, "expected Skyridge or Aquapolis cards, saw " + gems);
  assert.ok(under50 / data.days.length >= 0.35, "most days should not be chase prices");
  const opening = pickDrop(data, data.epoch);
  assert.equal(opening.card.id, data.days[0]);
  assert.equal(opening.n, 1);
  assert.equal(pickDrop(data, addDays(data.epoch, 11)).n, 12);
  assert.equal(pickDrop(data, data.epoch).card.id, opening.card.id);
});

console.log("daily tests passed");
