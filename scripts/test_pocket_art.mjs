// Pocket art paths. A saved thumb or image base should point at the same
// full-size file the rest of the app already uses. A broken or foreign URL
// adds nothing, and the old 107x150 placeholder is not treated as art.
// Run: npx -y node@22 scripts/test_pocket_art.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const art = require(join(dirname(fileURLToPath(import.meta.url)), "../js/pocket-art.js"));

const low = "https://assets.tcgdex.net/en/base/base1/4/low.webp";
const high = "https://assets.tcgdex.net/en/base/base1/4/high.webp";
const png = "https://assets.tcgdex.net/en/base/base1/4/high.png";
const small = "https://images.pokemontcg.io/base1/4.png";
const hires = "https://images.pokemontcg.io/base1/4_hires.png";

assert.deepEqual(art.sharperFrom(low), [high, png]);
assert.deepEqual(art.sharperFrom(small), [hires]);
assert.deepEqual(art.sharperFrom("https://evil.example/low.webp"), []);
assert.equal(art.isPlaceholderSize(107, 150), true);
assert.equal(art.isPlaceholderSize(245, 337), false);
assert.equal(art.isPlaceholderSize(600, 825), false);

const saved = { id: "base1-4", name: "Charizard", price: 400, thumb: low, img: high };
assert.equal(art.pocketSources(saved, false)[0], low, "a pocket still starts on the preview");
assert.equal(art.pocketSources(saved, true)[0], high, "the full-size webp leads when a scan is asked for");
assert.ok(art.pocketSources(saved, true).includes(png));
assert.ok(art.pocketSources(saved, true).includes(low));

const thumbOnly = { name: "Charizard", price: 400, thumb: low };
assert.equal(art.pocketSources(thumbOnly, true)[0], high, "a thumb alone still offers the high.webp beside it");
assert.ok(art.pocketSources(thumbOnly, true).includes(low));

const baseOnly = { name: "Pikachu", image: "https://assets.tcgdex.net/en/sv/sv03/25" };
assert.equal(art.pocketSources(baseOnly, false)[0], "https://assets.tcgdex.net/en/sv/sv03/25/low.webp");
assert.equal(art.pocketSources(baseOnly, true)[0], "https://assets.tcgdex.net/en/sv/sv03/25/high.webp");
assert.ok(!art.pocketSources(baseOnly, true).some(url => url.includes("/low.webp/")));

const scan = { thumb: small, img: hires };
assert.equal(art.pocketSources(scan, false)[0], small);
assert.equal(art.pocketSources(scan, true)[0], hires);

const pricedButBroken = { name: "Ghost", price: 80, img: "https://cdn.example/card.png", thumb: "not-a-url" };
assert.deepEqual(art.pocketSources(pricedButBroken, true), [], "a foreign URL is not a pocket image");

const alreadyFile = { image: high };
assert.deepEqual(art.pocketSources(alreadyFile, false), [high], "a full file stored on image is not given an extra suffix");

const gone = "https://assets.tcgdex.net/en/sv/sv04.5/003-gone/high.webp";
const otherLow = "https://assets.tcgdex.net/en/sv/sv04.5/003-nocors/low.webp";
const mixed = art.pocketSources({ img: gone, thumb: otherLow, price: 3 }, true);
assert.equal(mixed[0], gone, "an explicit scan stays the scan");
assert.equal(mixed.some(url => url.includes("003-nocors/high.webp")), false, "a different thumb does not invent another card");
assert.ok(mixed.includes(otherLow));

console.log("pocket art tests passed");
