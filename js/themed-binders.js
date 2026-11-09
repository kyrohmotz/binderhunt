/* Themed binders sit beside the one master wishlist.
   Right-swipe still saves to binderhuntWish. A binder only stores ids of
   cards that also live, or used to live, on that wishlist. The same card
   may sit in several binders. Removing it from a binder, or deleting the
   binder, never writes binderhuntWish or bh.owned.v1.

   Storage stays bh.binders.v1. Older binders (no theme, no cards array,
   a bare id string in cards) are repaired in memory. Nothing is wiped. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderThemes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEYS = {
    binders: "bh.binders.v1",
    wish: "binderhuntWish",
    owned: "bh.owned.v1"
  };
  const DEFAULT_COVER = "#E9D5C0";

  function cleanId(id) {
    const s = typeof id === "string" ? id.trim() : "";
    return s && s.length <= 80 ? s : "";
  }

  function cleanName(value, max) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max || 40);
  }

  function normalizeCover(value) {
    const raw = String(value == null ? "" : value).trim();
    const hex = raw.charAt(0) === "#" ? raw.slice(1) : raw;
    return /^[0-9a-fA-F]{6}$/.test(hex) ? "#" + hex.toUpperCase() : DEFAULT_COVER;
  }

  function validCover(value) {
    const raw = String(value == null ? "" : value).trim();
    const hex = raw.charAt(0) === "#" ? raw.slice(1) : raw;
    return /^[0-9a-fA-F]{6}$/.test(hex) ? "#" + hex.toUpperCase() : "";
  }

  function normalizeCharm(value) {
    const charm = String(value == null ? "" : value).trim();
    if (charm === "toad" || charm === "sticker" || charm === "none") return charm;
    if (charm && charm.length <= 24 && /^[a-z0-9-]+$/i.test(charm)) return charm;
    return "none";
  }

  function normalizeTheme(theme) {
    const blank = { kind: "none", setId: "", type: "", name: "" };
    if (!theme || typeof theme !== "object" || Array.isArray(theme)) return blank;
    let kind = theme.kind === "set" || theme.kind === "type" || theme.kind === "pokemon" || theme.kind === "name"
      ? theme.kind
      : "none";
    if (kind === "name") kind = "pokemon";
    const setId = cleanId(typeof theme.setId === "string" ? theme.setId : "");
    const type = cleanName(theme.type, 32);
    const name = cleanName(theme.name, 24);
    if (kind === "set" && !setId) kind = "none";
    if (kind === "type" && !type) kind = "none";
    if (kind === "pokemon" && !name) kind = "none";
    return {
      kind,
      setId: kind === "set" ? setId : "",
      type: kind === "type" ? type : "",
      name: kind === "pokemon" ? name : ""
    };
  }

  function copyCard(card) {
    if (typeof card === "string") {
      const id = cleanId(card);
      return id ? { id } : null;
    }
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    const id = cleanId(card.id);
    if (!id) return null;
    return Object.assign({}, card, { id });
  }

  function normalizeCards(list) {
    const cards = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach(item => {
      const card = copyCard(item);
      if (!card || seen.has(card.id)) return;
      seen.add(card.id);
      cards.push(card);
    });
    return cards;
  }

  function normalizeState(raw) {
    const empty = { discoveryId: "", binders: [] };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
    const binders = [];
    const seen = new Set();
    (Array.isArray(raw.binders) ? raw.binders : []).forEach(binder => {
      if (!binder || typeof binder !== "object" || Array.isArray(binder)) return;
      const id = cleanId(binder.id);
      const name = cleanName(binder.name, 40);
      if (!id || !name || seen.has(id)) return;
      seen.add(id);
      binders.push(Object.assign({}, binder, {
        id,
        name,
        color: normalizeCover(binder.color),
        theme: normalizeTheme(binder.theme),
        charm: normalizeCharm(binder.charm),
        cards: normalizeCards(binder.cards)
      }));
    });
    let discoveryId = cleanId(typeof raw.discoveryId === "string" ? raw.discoveryId : "");
    if (discoveryId && !binders.some(b => b.id === discoveryId)) discoveryId = "";
    return { discoveryId, binders };
  }

  function findBinder(state, id) {
    const clean = cleanId(id);
    if (!clean || !state || !Array.isArray(state.binders)) return null;
    return state.binders.find(b => b && b.id === clean) || null;
  }

  function themeOf(binder) {
    return normalizeTheme(binder && binder.theme);
  }

  function speciesHit(cardName, species) {
    const n = String(cardName || "").toLowerCase();
    const s = String(species || "").toLowerCase().trim();
    if (!s) return false;
    if (n === s) return true;
    const edges = [" ", "-"];
    for (let i = 0; i < edges.length; i++) {
      if (n.startsWith(s + edges[i]) || n.endsWith(edges[i] + s)) return true;
      for (let j = 0; j < edges.length; j++) {
        if (n.includes(edges[i] + s + edges[j])) return true;
      }
    }
    return false;
  }

  function matchesTheme(card, theme) {
    const t = normalizeTheme(theme);
    if (t.kind === "none") return true;
    if (!card) return false;
    if (t.kind === "set") return !!t.setId && card.setId === t.setId;
    if (t.kind === "type") return !!t.type && (card.types || []).includes(t.type);
    if (t.kind === "pokemon") return !!t.name && speciesHit(card.name, t.name);
    return true;
  }

  function huntFilters(theme) {
    const t = normalizeTheme(theme);
    if (t.kind === "set") return { set: t.setId, type: "", names: [] };
    if (t.kind === "type") return { set: "", type: t.type, names: [] };
    if (t.kind === "pokemon") return { set: "", type: "", names: t.name ? [t.name] : [] };
    return { set: "", type: "", names: [] };
  }

  function createBinder(state, input) {
    if (!state || !Array.isArray(state.binders)) return null;
    const name = cleanName(input && input.name, 40);
    if (!name) return null;
    let id = cleanId(input && input.id);
    if (!id || state.binders.some(b => b && b.id === id)) {
      id = "b" + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
    }
    const binder = {
      id,
      name,
      color: normalizeCover(input && input.color),
      theme: normalizeTheme(input && input.theme),
      charm: normalizeCharm(input && input.charm),
      cards: []
    };
    state.binders.push(binder);
    return binder;
  }

  function renameBinder(state, id, name) {
    const binder = findBinder(state, id);
    const next = cleanName(name, 40);
    if (!binder || !next) return false;
    binder.name = next;
    return true;
  }

  function recolorBinder(state, id, color) {
    const binder = findBinder(state, id);
    const next = validCover(color);
    if (!binder || !next) return false;
    binder.color = next;
    return true;
  }

  function deleteBinder(state, id) {
    if (!state || !Array.isArray(state.binders)) return false;
    const clean = cleanId(id);
    if (!clean) return false;
    const next = state.binders.filter(b => b && b.id !== clean);
    if (next.length === state.binders.length) return false;
    state.binders = next;
    if (state.discoveryId === clean) state.discoveryId = "";
    return true;
  }

  function switchActive(state, id) {
    if (!state || !Array.isArray(state.binders)) return false;
    const clean = id ? cleanId(id) : "";
    if (!clean) {
      state.discoveryId = "";
      return true;
    }
    if (!state.binders.some(b => b && b.id === clean)) return false;
    state.discoveryId = clean;
    return true;
  }

  function addCard(binder, card) {
    if (!binder || !card || typeof card !== "object") return false;
    const copy = copyCard(card);
    if (!copy) return false;
    if (!Array.isArray(binder.cards)) binder.cards = [];
    if (binder.cards.some(c => c && c.id === copy.id)) return false;
    binder.cards.push(copy);
    return true;
  }

  function removeCard(binder, id) {
    if (!binder || !Array.isArray(binder.cards)) return false;
    const clean = cleanId(id);
    if (!clean) return false;
    const next = binder.cards.filter(c => c && c.id !== clean);
    if (next.length === binder.cards.length) return false;
    binder.cards = next;
    return true;
  }

  function bindersHolding(state, cardId) {
    const id = cleanId(cardId);
    if (!id || !state || !Array.isArray(state.binders)) return [];
    return state.binders.filter(b => (b.cards || []).some(c => c && c.id === id)).map(b => b.id);
  }

  return {
    KEYS,
    DEFAULT_COVER,
    normalizeState,
    findBinder,
    themeOf,
    speciesHit,
    matchesTheme,
    huntFilters,
    createBinder,
    renameBinder,
    recolorBinder,
    deleteBinder,
    switchActive,
    addCard,
    removeCard,
    bindersHolding
  };
});
