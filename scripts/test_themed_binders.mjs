// Themed binder storage. A card may live in several binders. Removing it
// from one binder, or deleting that binder, does not touch the wishlist
// array or the owned list. Run: node scripts/test_themed_binders.mjs
import assert from "node:assert/strict";
import themes from "../js/themed-binders.js";

const {
  KEYS, normalizeState, themeOf, matchesTheme, huntFilters, speciesHit,
  createBinder, renameBinder, recolorBinder, deleteBinder, switchActive,
  addCard, removeCard, bindersHolding
} = themes;

function check(name, fn) {
  try {
    fn();
    console.log("ok", name);
  } catch (error) {
    console.error("FAIL", name);
    throw error;
  }
}

const charizard = { id: "base1-4", name: "Charizard", setId: "base1", types: ["Fire"], artist: "Mitsuhiro Arita" };
const squirtle = { id: "base1-63", name: "Squirtle", setId: "base2", types: ["Water"] };
const iono = { id: "sv2-185", name: "Iono", setId: "sv2", types: ["Colorless"] };
const ionoEx = { id: "sv2-254", name: "Iono ex", setId: "sv2", types: ["Colorless"] };

check("storage keys stay the wishlist, binders, and owned keys", () => {
  assert.equal(KEYS.binders, "bh.binders.v1");
  assert.equal(KEYS.wish, "binderhuntWish");
  assert.equal(KEYS.owned, "bh.owned.v1");
  assert.notEqual(KEYS.binders, KEYS.wish);
  assert.notEqual(KEYS.binders, KEYS.owned);
});

check("a broken record becomes an empty binder list and does not throw", () => {
  assert.deepEqual(normalizeState(null), { discoveryId: "", binders: [] });
  assert.deepEqual(normalizeState("nope"), { discoveryId: "", binders: [] });
  assert.deepEqual(normalizeState([]), { discoveryId: "", binders: [] });
  assert.deepEqual(normalizeState({ binders: "Jungle" }), { discoveryId: "", binders: [] });
});

check("an older binder keeps its cards, extras, and a missing theme", () => {
  const raw = {
    discoveryId: "missing",
    binders: [
      {
        id: "jungle",
        name: " Jungle ",
        color: "abb28d",
        cards: ["base1-4", { id: "base1-4", name: "dup" }, { id: "base1-15", name: "Venusaur", artist: "Ken Sugimori", price: 12 }],
        charm: "toad",
        note: "kept"
      },
      { id: "nameless" },
      null,
      { name: "No id" }
    ]
  };
  const state = normalizeState(raw);
  assert.equal(state.discoveryId, "");
  assert.equal(state.binders.length, 1);
  const jungle = state.binders[0];
  assert.equal(jungle.name, "Jungle");
  assert.equal(jungle.color, "#ABB28D");
  assert.equal(jungle.charm, "toad");
  assert.equal(jungle.note, "kept");
  assert.deepEqual(themeOf(jungle), { kind: "none", setId: "", type: "", name: "" });
  assert.equal(jungle.cards.length, 2);
  assert.equal(jungle.cards[0].id, "base1-4");
  assert.equal(jungle.cards[1].name, "Venusaur");
  assert.equal(jungle.cards[1].artist, "Ken Sugimori");
  assert.equal(jungle.cards[1].price, 12);
});

check("create, rename, and recolor leave the wishlist array alone", () => {
  const wish = [charizard, squirtle];
  const before = JSON.stringify(wish);
  const state = normalizeState({ discoveryId: "", binders: [] });
  const jungle = createBinder(state, {
    id: "jungle",
    name: "  Jungle ",
    color: "#abb28d",
    theme: { kind: "set", setId: "base2" },
    charm: "toad"
  });
  assert.equal(jungle.name, "Jungle");
  assert.equal(jungle.color, "#ABB28D");
  assert.equal(jungle.theme.kind, "set");
  assert.equal(jungle.theme.setId, "base2");
  assert.equal(createBinder(state, { name: "   " }), null);
  assert.equal(renameBinder(state, "jungle", " Jungle Holos "), true);
  assert.equal(jungle.name, "Jungle Holos");
  assert.equal(renameBinder(state, "jungle", " "), false);
  assert.equal(recolorBinder(state, "jungle", "86DEFF"), true);
  assert.equal(jungle.color, "#86DEFF");
  assert.equal(recolorBinder(state, "jungle", "nope"), false);
  assert.equal(jungle.color, "#86DEFF");
  assert.equal(JSON.stringify(wish), before);
});

check("one card can sit in two binders, and leaving one keeps the wishlist", () => {
  const wish = [charizard, squirtle, iono];
  const before = JSON.stringify(wish);
  const state = normalizeState({
    discoveryId: "",
    binders: [
      { id: "jungle", name: "Jungle", color: "#ABB28D", theme: { kind: "set", setId: "base2" }, cards: [] },
      { id: "water", name: "Water", color: "#86DEFF", theme: { kind: "type", type: "Water" }, cards: [] }
    ]
  });
  const jungle = state.binders[0];
  const water = state.binders[1];
  assert.equal(addCard(jungle, charizard), true);
  assert.equal(addCard(water, charizard), true);
  assert.equal(addCard(water, charizard), false);
  assert.equal(addCard(water, squirtle), true);
  assert.deepEqual(bindersHolding(state, "base1-4"), ["jungle", "water"]);
  assert.equal(removeCard(jungle, "base1-4"), true);
  assert.equal(jungle.cards.some(c => c.id === "base1-4"), false);
  assert.equal(water.cards.some(c => c.id === "base1-4"), true);
  assert.equal(water.cards.some(c => c.id === "base1-63"), true);
  assert.equal(JSON.stringify(wish), before);
  assert.notEqual(water.cards[0], charizard);
});

check("deleting a binder keeps the wishlist, other binders, and drops only that hunt", () => {
  const wish = [charizard, squirtle];
  const owned = ["base1-4"];
  const wishBefore = JSON.stringify(wish);
  const ownedBefore = JSON.stringify(owned);
  const state = normalizeState({
    discoveryId: "jungle",
    binders: [
      { id: "jungle", name: "Jungle", cards: [charizard] },
      { id: "iono", name: "Iono", color: "#F6C9C9", theme: { kind: "name", name: "Iono" }, cards: [iono] }
    ]
  });
  assert.equal(state.binders[1].theme.kind, "pokemon");
  assert.equal(state.binders[1].theme.name, "Iono");
  assert.equal(deleteBinder(state, "jungle"), true);
  assert.equal(state.discoveryId, "");
  assert.equal(state.binders.length, 1);
  assert.equal(state.binders[0].id, "iono");
  assert.equal(state.binders[0].cards[0].id, "sv2-185");
  assert.equal(deleteBinder(state, "jungle"), false);
  assert.equal(JSON.stringify(wish), wishBefore);
  assert.equal(JSON.stringify(owned), ownedBefore);
});

check("switching the active binder does not move cards or the wishlist", () => {
  const wish = [iono];
  const before = JSON.stringify(wish);
  const state = normalizeState({
    discoveryId: "water",
    binders: [
      { id: "water", name: "Water", cards: [squirtle] },
      { id: "iono", name: "Iono", cards: [iono] }
    ]
  });
  assert.equal(switchActive(state, "missing"), false);
  assert.equal(state.discoveryId, "water");
  assert.equal(switchActive(state, "iono"), true);
  assert.equal(state.discoveryId, "iono");
  assert.equal(state.binders[0].cards[0].id, "base1-63");
  assert.equal(state.binders[1].cards[0].id, "sv2-185");
  assert.equal(switchActive(state, ""), true);
  assert.equal(state.discoveryId, "");
  assert.equal(JSON.stringify(wish), before);
});

check("theme filters match a set, a type, and a name like Iono", () => {
  const jungle = { kind: "set", setId: "base2" };
  const water = { kind: "type", type: "Water" };
  const named = { kind: "name", name: "Iono" };
  assert.equal(matchesTheme(squirtle, jungle), true);
  assert.equal(matchesTheme(charizard, jungle), false);
  assert.equal(matchesTheme(squirtle, water), true);
  assert.equal(matchesTheme(charizard, water), false);
  assert.equal(matchesTheme(iono, named), true);
  assert.equal(matchesTheme(ionoEx, named), true);
  assert.equal(matchesTheme(squirtle, named), false);
  assert.equal(matchesTheme(charizard, { kind: "none" }), true);
  assert.equal(speciesHit("Iono's Bellibolt", "Iono"), false);
  assert.deepEqual(huntFilters(jungle), { set: "base2", type: "", names: [] });
  assert.deepEqual(huntFilters(water), { set: "", type: "Water", names: [] });
  assert.deepEqual(huntFilters(named), { set: "", type: "", names: ["Iono"] });
  assert.deepEqual(huntFilters({ kind: "none" }), { set: "", type: "", names: [] });
});

check("a half-finished theme does not lock the hunt onto nothing", () => {
  const state = normalizeState({
    binders: [{ id: "fresh", name: "Fresh", theme: { kind: "set", setId: "" }, cards: [charizard] }]
  });
  assert.equal(state.binders[0].theme.kind, "none");
  assert.equal(state.binders[0].cards.length, 1);
  assert.deepEqual(huntFilters(state.binders[0].theme), { set: "", type: "", names: [] });
});

console.log("themed binder checks passed");
