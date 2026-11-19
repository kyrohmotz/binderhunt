// Monthly budget math: month rollover, remaining, fit order, and undo.
// The budget key stays absent until a number is saved, and other keys are left alone.
// Run: npx -y node@22 scripts/test_budget.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Budget = require(resolve(root, "js/budget.js"));

const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
const ui = readFileSync(resolve(root, "js/budget-ui.js"), "utf8");
const core = readFileSync(resolve(root, "js/budget.js"), "utf8");
assert.match(sw, /const VERSION = "bh-19"/);
assert.match(sw, /"js\/budget\.js"/);
assert.match(sw, /"js\/budget-ui\.js"/);
assert.match(sw, /"css\/budget\.css"/);
assert.equal(html.includes("js/budget.js"), false, "budget script stays out of the first paint");
assert.match(html, /id="budgetSheet"/);
assert.match(app, /id="openPlan"/);
assert.match(app, /bh\.budget\.v1|BinderBudget/);
assert.doesNotMatch(core, /scrydex\.com/i);
assert.doesNotMatch(ui, /scrydex\.com/i);
assert.doesNotMatch(core, /binderhuntWish|bh\.owned\.v1|bh\.targets\.v1/);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

function memory(seed) {
  const data = new Map(Object.entries(seed || {}));
  let writes = 0;
  return {
    get writes() { return writes; },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { writes += 1; data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

function history(variant, start, end, days, latest) {
  const last = latest || Date.UTC(2026, 9, 1);
  const rows = [];
  for (let ago = days; ago >= 0; ago--) {
    const t = new Date(last - ago * 86400000);
    const iso = t.getUTCFullYear() + "/" + String(t.getUTCMonth() + 1).padStart(2, "0") + "/" + String(t.getUTCDate()).padStart(2, "0");
    const price = start + (end - start) * (days - ago) / days;
    rows.push({ d: iso, v: variant, m: Math.round(price * 100) / 100 });
  }
  return rows;
}

const november = new Date(2026, 10, 13, 12, 0, 0);
const october = new Date(2026, 9, 31, 12, 0, 0);
const january = new Date(2027, 0, 1, 12, 0, 0);
const december = new Date(2026, 11, 31, 12, 0, 0);

assert.equal(Budget.monthKey(october), "2026-10");
assert.equal(Budget.monthKey(november), "2026-11");
assert.equal(Budget.monthKey(december), "2026-12");
assert.equal(Budget.monthKey(january), "2027-01");
assert.equal(Budget.dateKey(november), "2026-11-13");
assert.equal(Budget.monthLabel("2026-11"), "November");
assert.equal(Budget.monthLabel("nope"), "");
assert.equal(Budget.moneyText(0), "");
assert.equal(Budget.moneyText(NaN), "");
assert.equal(Budget.moneyText(0.004), "");
assert.equal(Budget.moneyText(12.5), "$12.50");
assert.equal(Budget.parsePrice("50"), 50);
assert.equal(Budget.parsePrice("$12.50"), 12.5);
assert.equal(Budget.parsePrice("0"), null);
assert.equal(Budget.parsePrice("0.00"), null);
assert.equal(Budget.parsePrice("NaN"), null);
assert.equal(Budget.parsePrice("undefined"), null);
assert.equal(Budget.cents("nope"), null);

const fresh = memory({ "binderhuntWish": "[]", "bh.owned.v1": "{\"v\":1,\"ids\":[]}", "bh.targets.v1": "{}" });
assert.equal(Budget.read(fresh, november), null);
assert.equal(Budget.recordPurchase(fresh, { id: "base1-4", price: 12.5, date: "2026-11-13" }, november), null);
assert.equal(Budget.undoPurchase(fresh, "base1-4", november), null);
assert.equal(Budget.setBudget(fresh, 0, november), null);
assert.equal(Budget.setBudget(fresh, NaN, november), null);
assert.equal(Budget.setBudget(fresh, "undefined", november), null);
assert.equal(fresh.writes, 0);
assert.equal(fresh.getItem(Budget.KEY), null);
assert.equal(fresh.getItem("binderhuntWish"), "[]");
assert.equal(fresh.getItem("bh.owned.v1"), "{\"v\":1,\"ids\":[]}");
assert.equal(fresh.getItem("bh.targets.v1"), "{}");

const corrupt = memory();
corrupt.setItem(Budget.KEY, "{");
const beforeCorrupt = corrupt.writes;
assert.equal(Budget.read(corrupt, november), null);
assert.equal(corrupt.getItem(Budget.KEY), "{");
assert.equal(corrupt.writes, beforeCorrupt);
const emptyObject = memory();
emptyObject.setItem(Budget.KEY, "{}");
assert.equal(Budget.read(emptyObject, november), null);
assert.equal(emptyObject.getItem(Budget.KEY), "{}");

const store = memory({
  "binderhuntWish": "[{\"id\":\"base1-4\"}]",
  "bh.owned.v1": "{\"v\":1,\"ids\":[\"base1-2\"]}",
  "bh.targets.v1": "{\"base1-4\":{\"price\":20}}"
});
const saved = Budget.setBudget(store, 50, november);
assert.ok(saved);
assert.equal(saved.amount, 50);
assert.equal(saved.month, "2026-11");
assert.deepEqual(saved.purchases, []);
assert.equal(Budget.remaining(saved), 50);
assert.equal(Budget.spent(saved), 0);
const raw = JSON.parse(store.getItem(Budget.KEY));
assert.deepEqual(Object.keys(raw), ["amount", "month", "purchases"]);
assert.equal(raw.amount, 50);
assert.equal(store.getItem("binderhuntWish"), "[{\"id\":\"base1-4\"}]");
assert.equal(store.getItem("bh.owned.v1"), "{\"v\":1,\"ids\":[\"base1-2\"]}");
assert.equal(store.getItem("bh.targets.v1"), "{\"base1-4\":{\"price\":20}}");

const again = Budget.read(store, november);
assert.equal(again.rolled, undefined);
assert.equal(Budget.remaining(again), 50);

assert.equal(Budget.recordPurchase(store, { id: "base1-4", price: 0, date: "2026-11-13" }, november), null);
assert.equal(Budget.recordPurchase(store, { id: "base1-4", price: 12.5, date: "2026-10-13" }, november), null);
assert.equal(Budget.recordPurchase(store, { id: "nope id", price: 12.5, date: "2026-11-13" }, november), null);
assert.equal(Budget.remaining(Budget.read(store, november)), 50);

const first = Budget.recordPurchase(store, { id: "base1-4", price: 12.5, date: "2026-11-01" }, november);
assert.ok(first);
assert.equal(first.purchase.price, 12.5);
assert.equal(first.purchase.date, "2026-11-01");
assert.deepEqual(Object.keys(first.purchase), ["id", "price", "date"]);
assert.equal(Budget.recordPurchase(store, { id: "base1-4", price: 9, date: "2026-11-02" }, november), null);
const second = Budget.recordPurchase(store, { id: "base1-25", price: 0.1 }, november);
const third = Budget.recordPurchase(store, { id: "sv1-1", price: 0.2, date: "2026-11-13" }, november);
assert.ok(second && third);
assert.equal(Budget.spent(third.state), 12.8);
assert.equal(Budget.remaining(third.state), 37.2);
assert.equal(Budget.fitsBudget(37.2, Budget.remaining(third.state)), true);
assert.equal(Budget.fitsBudget(37.21, Budget.remaining(third.state)), false);

const undone = Budget.undoPurchase(store, null, november);
assert.ok(undone);
assert.equal(undone.removed.id, "sv1-1");
assert.equal(Budget.remaining(undone.state), 37.4);
const undoneNamed = Budget.undoPurchase(store, "base1-4", november);
assert.equal(undoneNamed.removed.price, 12.5);
assert.equal(Budget.remaining(undoneNamed.state), 49.9);
assert.equal(Budget.undoPurchase(store, "missing", november), null);
assert.equal(Budget.remaining(Budget.read(store, november)), 49.9);
const redo = Budget.recordPurchase(store, { id: "base1-4", price: 10, date: "2026-11-13" }, november);
assert.equal(Budget.remaining(redo.state), 39.9);

const tighter = Budget.setBudget(store, 8, november);
assert.equal(tighter.amount, 8);
assert.equal(tighter.purchases.length, 2);
assert.equal(Budget.remaining(tighter), -2.1);
assert.equal(Budget.fitsBudget(1, Budget.remaining(tighter)), false);
Budget.setBudget(store, 50, november);

const octoberStore = memory();
octoberStore.setItem(Budget.KEY, JSON.stringify({
  amount: 40,
  month: "2026-10",
  purchases: [
    { id: "base1-4", price: 10, date: "2026-10-02" },
    { id: "bad", price: 0, date: "2026-10-02" }
  ]
}));
octoberStore.setItem("bh.owned.v1", "{\"v\":1,\"ids\":[]}");
const rolled = Budget.read(octoberStore, november);
assert.equal(rolled.rolled, true);
assert.equal(rolled.month, "2026-11");
assert.equal(rolled.amount, 40);
assert.deepEqual(rolled.purchases, []);
assert.equal(Budget.remaining(rolled), 40);
const rolledRaw = JSON.parse(octoberStore.getItem(Budget.KEY));
assert.equal(rolledRaw.rolled, undefined);
assert.deepEqual(rolledRaw.purchases, []);
assert.equal(octoberStore.getItem("bh.owned.v1"), "{\"v\":1,\"ids\":[]}");
assert.equal(Budget.undoPurchase(octoberStore, "base1-4", november), null);
const stayed = Budget.read(octoberStore, november);
assert.equal(stayed.rolled, undefined);
assert.equal(stayed.amount, 40);

const year = memory();
year.setItem(Budget.KEY, JSON.stringify({
  amount: 25,
  month: "2026-12",
  purchases: [{ id: "base1-2", price: 5, date: "2026-12-24" }]
}));
const newYear = Budget.read(year, january);
assert.equal(newYear.month, "2027-01");
assert.equal(newYear.amount, 25);
assert.deepEqual(newYear.purchases, []);
assert.equal(Budget.remaining(newYear), 25);
assert.equal(Budget.recordPurchase(year, { id: "base1-2", price: 4, date: "2026-12-24" }, january), null);
const januaryBuy = Budget.recordPurchase(year, { id: "base1-2", price: 4, date: "2027-01-02" }, january);
assert.equal(Budget.remaining(januaryBuy.state), 21);

const dropped = Budget.quoteRecord({
  name: "Charizard",
  history: history("holofoil", 90, 60, 40).concat([
    { d: "2026/10/01", v: "holofoil", m: 0 },
    { d: "2026/10/01", v: "holofoil", m: NaN },
    { d: "2026/10/01", v: "firstEditionHolofoil", m: 400 }
  ])
});
assert.equal(dropped.market, 60);
assert.equal(dropped.variant, "holofoil");
assert.ok(dropped.cheapPct >= 1);
const rising = Budget.quoteRecord({ history: history("normal", 10, 18, 40) });
assert.equal(rising.market, 18);
assert.equal(rising.cheapPct, 0);
assert.equal(Budget.quoteRecord({ missing: true, history: history("normal", 10, 4, 40) }), null);
assert.equal(Budget.quoteRecord({ history: [{ d: "2026/10/01", v: "normal", m: 0 }] }), null);
assert.equal(Budget.quoteRecord({ history: [] }), null);
const single = Budget.quoteRecord({ history: [{ d: "2026/10/01", v: "normal", m: 7.5 }] });
assert.equal(single.market, 7.5);
assert.equal(single.cheapPct, 0);

const picked = Budget.selectFits([
  { id: "flat", name: "Flat", market: 8, cheapPct: 0 },
  { id: "cheap", name: "Cheap", market: 9, cheapPct: 40 },
  { id: "goal", name: "Goal", market: 10, target: 12, cheapPct: 0 },
  { id: "both", name: "Both", market: 11, target: 11, cheapPct: 5 },
  { id: "rich", name: "Rich", market: 30, target: 40, cheapPct: 80 },
  { id: "gap", name: "Gap", market: null, target: 5 },
  { id: "zero", name: "Zero", market: 0 },
  { id: "nan", name: "undefined", market: NaN },
  { id: "owned", name: "Owned", market: 4, target: 9, owned: true },
  { id: "bought", name: "Bought", market: 3, purchased: true },
  { id: "flat", name: "Flat again", market: 1 },
  { id: "edge", name: "Edge", market: 20, target: 20, cheapPct: 0 }
], 20);
assert.deepEqual(picked.fits.map(row => row.id), ["both", "goal", "edge", "cheap", "flat"]);
assert.equal(picked.fits[0].underTarget, true);
assert.equal(picked.fits[0].fits, true);
assert.equal(picked.fits.every(row => row.market <= 20), true);
assert.deepEqual(picked.waiting.map(row => row.id), ["rich"]);
assert.equal(picked.waiting[0].fits, false);
assert.equal(picked.waiting[0].underTarget, true);
assert.deepEqual(picked.unpriced.map(row => row.name), ["Card", "Gap", "Zero"]);
assert.equal(picked.fits.some(row => row.id === "owned" || row.id === "bought"), false);
assert.equal(picked.unpriced.every(row => row.market == null && row.fits === false), true);

const exact = Budget.selectFits([{ id: "base1-25", name: "Pikachu", market: 20, target: 19 }], 20);
assert.equal(exact.fits.length, 1);
assert.equal(exact.fits[0].underTarget, false);
const over = Budget.selectFits([{ id: "base1-25", name: "Pikachu", market: 20.01 }], 20);
assert.equal(over.fits.length, 0);
assert.equal(over.waiting[0].id, "base1-25");
const none = Budget.selectFits([{ id: "base1-25", name: "Pikachu", market: 5, target: 4, cheapPct: 12 }], -1);
assert.equal(none.fits.length, 0);
assert.equal(none.waiting[0].cheapPct, 12);

const shown = [dropped, rising, single].concat(picked.fits, picked.waiting);
shown.forEach(row => {
  const money = Budget.moneyText(row.market);
  const goal = Budget.moneyText(row.target);
  const pct = Budget.pctText(row.cheapPct);
  [money, goal, pct].forEach(text => {
    if (!text) return;
    assert.equal(/NaN|undefined|\$0(?:\.00)?\b/.test(text), false, text);
  });
});

console.log("ok budget math");
