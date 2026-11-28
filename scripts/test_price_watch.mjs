// Price watch math: change since a card was saved, from cached history only.
// Missing data, zero and negative prices, and rounding under 3% stay blank.
// Run: npx -y node@22 scripts/test_price_watch.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Watch = require(resolve(root, "js/price-watch.js"));
const History = require(resolve(root, "js/price-history.js"));
const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const source = readFileSync(resolve(root, "js/price-watch.js"), "utf8");

assert.match(sw, /const VERSION = "bh-26"/);
assert.match(sw, /"js\/price-watch\.js"/);
assert.match(sw, /"css\/price-watch\.css"/);
assert.match(html, /css\/price-watch\.css/);
assert.equal(html.includes("js/price-watch.js"), false);
assert.match(app, /bh\.pricewatch\.v1|BinderPriceWatch/);
assert.match(app, /rememberWatch/);
assert.doesNotMatch(source, /scrydex\.com/i);
assert.doesNotMatch(app, /api\.scrydex\.com/);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

const DAY = 86400000;
const t0 = Date.UTC(2026, 9, 1);

function point(day, value) {
  return { t: t0 + day * DAY, value };
}

assert.equal(Watch.move(null), null);
assert.equal(Watch.move({}), null);
assert.equal(Watch.move({ points: [] }), null);
assert.equal(Watch.move({ points: [{ t: t0, value: 10 }] }), null, "one point and no saved price is not a change");
assert.equal(Watch.move({ points: null, savedPrice: 10 }), null);
assert.equal(Watch.quote(undefined, 10), null);
assert.equal(Watch.quote(10, undefined), null);
assert.equal(Watch.quote(NaN, 12), null);
assert.equal(Watch.quote(10, NaN), null);
assert.equal(Watch.quote(0, 10), null);
assert.equal(Watch.quote(10, 0), null);
assert.equal(Watch.quote(-4, 10), null);
assert.equal(Watch.quote(10, -4), null);
assert.equal(Watch.quote(0.004, 1), null);
assert.equal(Watch.quote(10, 10), null);
assert.equal(Watch.quote(10, 9.98), null, "a two-cent move is under 3 percent");
assert.equal(Watch.quote(10, 9.71), null, "2.9 percent stays blank");
assert.equal(Watch.quote(100, 97.06), null, "2.94 percent rounds to 2.9 and stays blank");

const just = Watch.quote(10, 9.7);
assert.ok(just && just.dir === "down" && just.pct === 3 && just.money === "$0.30" && just.pctText === "3%");
assert.equal(just.dollars, 0.3);

const roundedUp = Watch.quote(100, 96.96);
assert.ok(roundedUp && roundedUp.dir === "down" && roundedUp.pct === 3 && roundedUp.money === "$3.04");

const rise = Watch.quote(20, 26.5);
assert.ok(rise && rise.dir === "up" && rise.pct === 32.5 && rise.money === "$6.50" && rise.pctText === "32.5%");
assert.doesNotMatch(Watch.badgeHtml(just), /NaN|undefined|\$0\.00\b|\$0(?!\.?\d)/);
assert.match(Watch.badgeHtml(just), /watch-badge down/);
assert.match(Watch.badgeHtml(just), /▼ \$0\.30 \(−3%\)/);
assert.match(Watch.badgeHtml(just), /Down \$0\.30, 3 percent, since you saved it/);
assert.match(Watch.badgeHtml(rise), /watch-badge up/);
assert.match(Watch.badgeHtml(rise), /▲ \$6\.50 \(\+32\.5%\)/);
assert.match(Watch.badgeHtml(rise), /Up \$6\.50, 32\.5 percent, since you saved it/);
assert.equal(Watch.badgeHtml(null), "");
assert.equal(Watch.badgeHtml({ dir: "down", money: "$0.00", pctText: "10%" }), "");
assert.equal(Watch.countLabel(0), "");
assert.equal(Watch.countLabel(1), "1 price drop");
assert.equal(Watch.countLabel(3), "3 price drops");
assert.equal(Watch.countLabel(NaN), "");

const points = [point(0, 40), point(10, 30), point(20, 24)];
const saved = Watch.move({ points, savedPrice: 40, savedAt: points[0].t });
assert.equal(saved.basis, "saved");
assert.equal(saved.dir, "down");
assert.equal(saved.latest, 24);
assert.equal(saved.baseline, 40);
assert.equal(saved.pct, 40);

const nearest = Watch.move({ points, savedAt: points[0].t + 4 * DAY, windowMove: History.windowMove });
assert.equal(nearest.basis, "nearest");
assert.equal(nearest.baseline, 40, "the nearer point is the earlier price");
const later = Watch.move({ points, savedAt: points[1].t + DAY });
assert.equal(later.basis, "nearest");
assert.equal(later.baseline, 30);

const weekPoints = [];
for (let day = 0; day <= 14; day++) weekPoints.push(point(day, day <= 7 ? 20 : 16));
const week = Watch.move({ points: weekPoints, windowMove: History.windowMove });
assert.equal(week.basis, "7d");
assert.equal(week.dir, "down");
assert.ok(week.pct >= 3);

const short = [point(12, 20), point(14, 10)];
assert.equal(Watch.move({ points: short, windowMove: History.windowMove }), null, "no 7-day baseline stays blank");
assert.equal(Watch.move({ points, windowMove: () => ({ dir: "flat", baseline: 10, latest: 10, shown: 0 }) }), null);
assert.equal(Watch.move({ points: weekPoints, windowMove: () => null }), null);

const tiny = Watch.move({
  points: [point(0, 10), point(14, 10.2)],
  windowMove: History.windowMove
});
assert.equal(tiny, null, "a real 7-day move under 3 percent stays blank");

const memory = {
  bag: {},
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.bag, key) ? this.bag[key] : null; },
  setItem(key, value) { this.bag[key] = String(value); }
};
assert.deepEqual(Watch.read(memory), {});
assert.equal(Watch.remember(memory, "sv10-229", { price: 70.5, at: t0 }), true);
assert.equal(Watch.remember(memory, "", { price: 10, at: t0 }), false);
assert.equal(Watch.remember(memory, "bad id", { price: 10, at: t0 }), false);
assert.equal(Watch.remember(memory, "base1-44", { price: 0, at: t0 }), true);
assert.equal(Watch.remember(memory, "neg", { price: -3, at: t0 }), true);
const stored = Watch.read(memory);
assert.equal(stored["sv10-229"].price, 70.5);
assert.equal(stored["sv10-229"].at, t0);
assert.equal(stored["base1-44"].price, undefined, "zero is not a saved price");
assert.equal(stored["base1-44"].at, t0);
assert.equal(stored.neg.price, undefined);
assert.equal(Watch.read({ getItem() { return "{"; } }) && true, true);
assert.deepEqual(Watch.read({ getItem() { return "{"; } }), {});
assert.deepEqual(Watch.read(null), {});

const ranked = Watch.dropping([
  { id: "a", move: Watch.quote(10, 8) },
  { id: "b", move: Watch.quote(10, 6) },
  { id: "c", move: Watch.quote(10, 12) },
  { id: "d", move: null },
  { id: "e", move: Watch.quote(50, 40) }
]);
assert.deepEqual(ranked.map(row => row.id), ["b", "e", "a"]);
const mixed = Watch.ordered([
  { id: "rise", move: Watch.quote(10, 14) },
  { id: "drop", move: Watch.quote(10, 7) }
]);
assert.deepEqual(mixed.map(row => row.id), ["drop", "rise"]);

const packed = History.unpack([20261001, 4000, 10, -1000, 10, -600]);
const fromHistory = Watch.move({ points: packed, savedPrice: 40, windowMove: History.windowMove });
assert.equal(fromHistory.dir, "down");
assert.equal(fromHistory.latest, 24);
assert.match(Watch.badgeHtml(fromHistory), /▼ \$16\.00 \(−40%\)/);
assert.doesNotMatch(Watch.badgeHtml(fromHistory), /NaN|undefined|\$0\.00\b|\$0(?!\.?\d)/);

console.log("price watch math ok");
