// CSV collection import: parsing, matching, dedupe, and undo.
// The sample fixture is synthetic. It is not a real Collectr export.
// Run: npx -y node@22 scripts/test_import.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Import = require(resolve(root, "js/import-csv.js"));

const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const app = readFileSync(resolve(root, "js/app.js"), "utf8");
assert.match(sw, /const VERSION = "bh-25"/);
assert.match(sw, /"js\/import-csv\.js"/);
assert.match(sw, /"js\/import-ui\.js"/);
assert.match(sw, /"css\/import\.css"/);
assert.equal(html.includes("js/import-csv.js"), false, "import script stays out of the first paint");
assert.match(html, /id="importSheet"/);
assert.match(app, /id="openImportShelf"/);
assert.match(app, /id="openImport"/);
assert.doesNotMatch(readFileSync(resolve(root, "js/import-csv.js"), "utf8"), /scrydex\.com/i);
assert.doesNotMatch(readFileSync(resolve(root, "js/import-ui.js"), "utf8"), /scrydex\.com/i);

const diff = spawnSync("git", ["diff", "--exit-code", "main", "--", "js/binder-turn.js", "js/card-inspect.js", "css/binder.css", "js/pocket-art.js"], { cwd: root, encoding: "utf8" });
assert.equal(diff.status, 0, "open binder files changed\n" + (diff.stdout || diff.stderr || ""));

function memory(seed) {
  const data = new Map(Object.entries(seed || {}));
  const writes = [];
  return {
    writes,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { writes.push(["set", key]); data.set(key, String(value)); },
    removeItem(key) { writes.push(["del", key]); data.delete(key); }
  };
}

const catalog = Import.indexCatalog([
  { id: "base1-4", name: "Charizard", setId: "base1", setName: "Base Set", number: "4" },
  { id: "base1-58", name: "Pikachu", setId: "base1", setName: "Base Set", number: "58" },
  { id: "base1-25", name: "Pikachu", setId: "base1", setName: "Base Set", number: "25" },
  { id: "base4-4", name: "Charizard", setId: "base4", setName: "Base Set 2", number: "4" },
  { id: "base2-10", name: "Scyther", setId: "base2", setName: "Jungle", number: "10" },
  { id: "base5-2", name: "Dark Blastoise", setId: "base5", setName: "Team Rocket", number: "20" },
  { id: "ex7-2", name: "Dark Blastoise", setId: "ex7", setName: "Team Rocket Returns", number: "20" },
  { id: "hgss1-1", name: "Arcanine", setId: "hgss1", setName: "HeartGold SoulSilver", number: "1" },
  { id: "sv01-4", name: "Charmander", setId: "sv01", setName: "Scarlet & Violet", number: "4" },
  { id: "sv08-001", name: "Exeggcute", setId: "sv08", setName: "Surging Sparks", number: "001" },
  { id: "sv08-192", name: "Exeggcute", setId: "sv08", setName: "Surging Sparks", number: "192" }
]);

const messy = "\uFEFFPRODUCT NAME, Set   Name , Card   Number ,Total Quantity,Card Condition,Market Price,Notes\r\n" +
  "Charmander,Scarlet & Violet,004,1,Near Mint,1.00,extra\r\n" +
  "\"Pikachu, the mouse\",Base Set,58,1,NM,1,\"quoted, note\"\r\n";
const messyParsed = Import.parseCsv(messy);
assert.equal(messyParsed.ok, true);
assert.deepEqual(messyParsed.columns, { name: 0, set: 1, number: 2, quantity: 3, condition: 4 });
assert.equal(messyParsed.rows[0].name, "Charmander");
assert.equal(messyParsed.rows[0].number, "004");
assert.equal(messyParsed.rows[1].name, "Pikachu, the mouse");
assert.equal(messyParsed.rows[1].set, "Base Set");

const quotedNewline = Import.parseCsv("name,set,number\n\"Pika\nchu\",Base Set,58\nAbra,Base Set,43\n");
assert.equal(quotedNewline.ok, true);
assert.equal(quotedNewline.rows.length, 2);
assert.equal(quotedNewline.rows[0].name, "Pika chu");
assert.equal(quotedNewline.rows[1].name, "Abra");
assert.equal(quotedNewline.rows[1].line > quotedNewline.rows[0].line, true);

assert.equal(Import.parseCsv("").ok, false);
assert.equal(Import.parseCsv("price,notes\n1,hi\n").ok, false);
assert.equal(Import.parseCsv("name,set,number\n").rows.length, 0);

const tcg = Import.parseCsv("TCGplayer Id,Product Line,Set Name,Product Name,Number,Rarity,Condition,Total Quantity,Photo URL\n9,Pokemon,Jungle,Scyther,10,Holo,Near Mint,1,http://example.invalid/x\n");
assert.equal(tcg.ok, true);
assert.equal(tcg.rows[0].name, "Scyther");
assert.equal(tcg.rows[0].set, "Jungle");
assert.equal(tcg.rows[0].number, "10");
assert.equal(tcg.rows[0].quantity, 1);
assert.equal(tcg.rows[0].condition, "Near Mint");

const fixtureBytes = readFileSync(resolve(root, "fixtures/collectr-sample.csv"));
assert.equal(fixtureBytes[0], 0xEF);
assert.equal(fixtureBytes.includes(Buffer.from("\r\n")), true);
assert.match(fixtureBytes.toString("utf8"), /Not a real collection/);
const fixture = Import.parseCsv(fixtureBytes.toString("utf8"));
assert.equal(fixture.ok, true, fixture.error);
assert.equal(fixture.rows.length, 7);
assert.equal(fixture.rows[0].name, "Charizard");
assert.equal(fixture.rows[0].set, "Base Set");
assert.equal(fixture.rows[0].number, "4/102");
assert.equal(fixture.rows[1].set, "Base Set, Unlimited");
assert.equal(fixture.rows[1].quantity, 2);
assert.equal(fixture.rows[2].number, "");
assert.equal(fixture.rows[6].quantity, 0);

const report = Import.matchRows(fixture.rows, catalog);
const byLine = new Map(report.rows.map(row => [row.row.line, row]));
assert.equal(byLine.get(fixture.rows[0].line).status, "matched");
assert.equal(byLine.get(fixture.rows[0].line).via, "number");
assert.equal(byLine.get(fixture.rows[0].line).card.id, "base1-4");
assert.equal(byLine.get(fixture.rows[1].line).card.id, "base1-58");
assert.equal(byLine.get(fixture.rows[2].line).status, "ambiguous");
assert.deepEqual(byLine.get(fixture.rows[2].line).choices.map(card => card.id).sort(), ["base1-25", "base1-58"]);
assert.equal(byLine.get(fixture.rows[3].line).status, "matched");
assert.equal(byLine.get(fixture.rows[3].line).via, "name");
assert.equal(byLine.get(fixture.rows[3].line).card.id, "base2-10");
assert.equal(byLine.get(fixture.rows[4].line).status, "unmatched");
assert.match(byLine.get(fixture.rows[4].line).reason, /Fakemon Island/);
assert.equal(byLine.get(fixture.rows[5].line).card.id, "base1-4");
assert.equal(byLine.get(fixture.rows[6].line).status, "skipped");
assert.match(byLine.get(fixture.rows[6].line).reason, /Quantity is 0/);

const baseOnly = Import.matchRows([{ line: 1, name: "Charizard", set: "Base", number: "4", quantity: 1, condition: "", setCode: "" }], catalog);
assert.equal(baseOnly.rows[0].card.id, "base1-4");
const hgss = Import.matchRows([{ line: 1, name: "Arcanine", set: "HeartGold & SoulSilver", number: "1", quantity: 1, condition: "", setCode: "" }], catalog);
assert.equal(hgss.rows[0].card.id, "hgss1-1");
const codeOnly = Import.matchRows([{ line: 1, name: "Charmander", set: "", number: "4", quantity: 1, condition: "Near Mint", setCode: "SVI" }], catalog);
assert.equal(codeOnly.rows[0].status, "matched");
assert.equal(codeOnly.rows[0].card.id, "sv01-4");
const padded = Import.matchRows([{ line: 1, name: "Exeggcute", set: "Surging Sparks", number: "001", quantity: 1, condition: "", setCode: "" }], catalog);
assert.equal(padded.rows[0].card.id, "sv08-001");
const eggs = Import.matchRows([{ line: 1, name: "Exeggcute", set: "Surging Sparks", number: "", quantity: 1, condition: "", setCode: "" }], catalog);
assert.equal(eggs.rows[0].status, "ambiguous");
const rocket = Import.matchRows([{ line: 1, name: "Dark Blastoise", set: "Rocket", number: "20", quantity: 1, condition: "", setCode: "" }], catalog);
assert.equal(rocket.rows[0].status, "ambiguous");
const missingNumber = Import.matchRows([{ line: 1, name: "Missingno", set: "Base Set", number: "999", quantity: 1, condition: "", setCode: "" }], catalog);
assert.equal(missingNumber.rows[0].status, "unmatched");
assert.match(missingNumber.rows[0].reason, /999/);
assert.match(missingNumber.rows[0].reason, /Base Set/);

const planned = Import.plan(report, { destination: "owned", ownedIds: ["base1-58"], wishIds: [], picks: {} });
assert.deepEqual(planned.add.map(card => card.id), ["base1-4", "base2-10"]);
assert.equal(planned.unresolved, 1);
assert.equal(planned.duplicate.some(row => row.card.id === "base1-58" && row.because === "saved"), true);
assert.equal(planned.duplicate.some(row => row.card.id === "base1-4" && row.because === "file"), true);

const picked = Import.plan(report, { destination: "wish", ownedIds: [], wishIds: [], picks: { [fixture.rows[2].line]: "base1-25" } });
assert.equal(picked.add.some(card => card.id === "base1-25"), true);
assert.equal(picked.unresolved, 0);
const skippedPick = Import.plan(report, { destination: "wish", ownedIds: [], wishIds: [], picks: { [fixture.rows[2].line]: "skip" } });
assert.equal(skippedPick.add.some(card => card.id === "base1-25"), false);
assert.equal(skippedPick.unresolved, 0);

const store = memory({
  "bh.owned.v1": JSON.stringify({ v: 1, ids: ["base1-58"], sets: { "base1-58": "base1" }, celebrated: ["set:base1"], seeded: true, note: "keep" }),
  "bh.filters.v3": JSON.stringify({ set: "sv08" }),
  "bh.settings.v1": JSON.stringify({ sound: false }),
  "bh.binders.v1": JSON.stringify({ discoveryId: "", binders: [] }),
  "bh.log.v1": JSON.stringify({ v: 1, days: [], events: [] })
});
const first = Import.commit(store, planned);
assert.equal(first.ok, true);
assert.deepEqual(first.added.map(card => card.id), ["base1-4", "base2-10"]);
assert.deepEqual(store.writes.map(row => row[1]), [Import.KEYS.owned, Import.KEYS.undo]);
const owned = JSON.parse(store.getItem(Import.KEYS.owned));
assert.deepEqual(owned.ids, ["base1-58", "base1-4", "base2-10"]);
assert.equal(owned.sets["base1-58"], "base1");
assert.equal(owned.sets["base1-4"], "base1");
assert.deepEqual(owned.celebrated, ["set:base1"]);
assert.equal(owned.note, "keep");
assert.equal(owned.seeded, true);
assert.equal(store.getItem(Import.KEYS.wish), null);
assert.equal(store.getItem("bh.filters.v3"), JSON.stringify({ set: "sv08" }));
assert.equal(store.getItem("bh.settings.v1"), JSON.stringify({ sound: false }));
assert.equal(store.getItem("bh.binders.v1"), JSON.stringify({ discoveryId: "", binders: [] }));
assert.equal(store.getItem("bh.log.v1"), JSON.stringify({ v: 1, days: [], events: [] }));

const again = Import.plan(report, { destination: "owned", ownedIds: owned.ids, wishIds: [], picks: {} });
const writeCount = store.writes.length;
const second = Import.commit(store, again);
assert.equal(second.added.length, 0);
assert.equal(store.writes.length, writeCount);
assert.equal(store.getItem(Import.KEYS.wish), null);

const undone = Import.undo(store);
assert.equal(undone.ok, true);
assert.deepEqual(undone.removed, ["base1-4", "base2-10"]);
const restored = JSON.parse(store.getItem(Import.KEYS.owned));
assert.deepEqual(restored.ids, ["base1-58"]);
assert.equal(restored.sets["base1-58"], "base1");
assert.equal(restored.sets["base1-4"], undefined);
assert.deepEqual(restored.celebrated, ["set:base1"]);
assert.equal(restored.note, "keep");
assert.equal(store.getItem(Import.KEYS.undo), null);
assert.equal(store.getItem("bh.filters.v3"), JSON.stringify({ set: "sv08" }));
const afterUndo = store.writes.length;
const secondUndo = Import.undo(store);
assert.equal(secondUndo.ok, false);
assert.equal(store.writes.length, afterUndo);

const wishStore = memory({ "bh.filters.v3": "{}" });
const wishPlan = Import.plan(report, { destination: "wish", ownedIds: [], wishIds: [], picks: { [fixture.rows[2].line]: "base1-25" } });
const wished = Import.commit(wishStore, wishPlan);
assert.equal(wished.wrote.wish, true);
assert.equal(wished.wrote.owned, false);
assert.equal(wishStore.getItem(Import.KEYS.owned), null);
assert.equal(wishStore.getItem("bh.filters.v3"), "{}");
const wish = JSON.parse(wishStore.getItem(Import.KEYS.wish));
assert.equal(wish.some(card => card.id === "base1-4"), true);
assert.equal(wish.some(card => card.id === "base1-25"), true);
wish.forEach(card => {
  assert.equal(Object.hasOwn(card, "condition"), false);
  assert.equal(Object.hasOwn(card, "quantity"), false);
  assert.equal(Object.hasOwn(card, "price"), false);
});
const wishAgain = Import.commit(wishStore, Import.plan(report, {
  destination: "wish",
  ownedIds: [],
  wishIds: wish.map(card => card.id),
  picks: { [fixture.rows[2].line]: "base1-25" }
}));
assert.equal(wishAgain.added.length, 0);
const wishUndo = Import.undo(wishStore);
assert.equal(wishUndo.destination, "wish");
assert.equal(wishStore.getItem(Import.KEYS.owned), null);
assert.equal(JSON.parse(wishStore.getItem(Import.KEYS.wish)).length, 0);
assert.equal(wishStore.getItem("bh.filters.v3"), "{}");

const emptyStore = memory({ "bh.settings.v1": "{\"sound\":false}" });
const before = emptyStore.writes.length;
Import.commit(emptyStore, { destination: "owned", add: [] });
assert.equal(emptyStore.writes.length, before);
assert.equal(emptyStore.getItem(Import.KEYS.owned), null);
assert.equal(emptyStore.getItem("bh.settings.v1"), "{\"sound\":false}");

const broken = memory({ "bh.owned.v1": "{", "bh.filters.v3": "[]" });
const broke = Import.commit(broken, planned);
assert.equal(broke.ok, false);
assert.equal(broken.getItem(Import.KEYS.owned), "{");
assert.equal(broken.getItem(Import.KEYS.undo), null);
assert.equal(broken.getItem("bh.filters.v3"), "[]");

const pools = JSON.parse(readFileSync(resolve(root, "data/pack-pools.json"), "utf8"));
const real = Import.indexCatalog(Import.cardsFromPools(pools));
const realHit = Import.matchRows([{ line: 2, name: "Charizard", set: "Base Set", number: "4/102", quantity: 1, condition: "Near Mint", setCode: "" }], real);
assert.equal(realHit.rows[0].status, "matched");
assert.equal(realHit.rows[0].card.id, "base1-4");
assert.match(realHit.rows[0].card.thumb, /base1\/4\/low\.webp$/);
const realEggs = Import.matchRows([{ line: 3, name: "Exeggcute", set: "Surging Sparks", number: "", quantity: 1, condition: "", setCode: "" }], real);
assert.equal(realEggs.rows[0].status, "ambiguous");
assert.equal(realEggs.rows[0].choices.length >= 2, true);

console.log("import ok", Import.summarize(report));
