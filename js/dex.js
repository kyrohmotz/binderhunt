/* Pokédex completion from the saved catalog only.
   Loaded as a classic script (window.BinderDex) and as CommonJS.
   It does not fetch Scrydex, TCGdex, or any other host. Species names
   come from cards already in memory. National dex numbers and
   generations come from data/dex.json, matched through the same
   species parser browse-by-Pokémon uses. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderDex = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEY = "bh.dex.v1";
  const MILESTONES = [25, 50, 75, 100];
  const GENS = [
    { id: 1, name: "Kanto", end: 151 },
    { id: 2, name: "Johto", end: 251 },
    { id: 3, name: "Hoenn", end: 386 },
    { id: 4, name: "Sinnoh", end: 493 },
    { id: 5, name: "Unova", end: 649 },
    { id: 6, name: "Kalos", end: 721 },
    { id: 7, name: "Alola", end: 809 },
    { id: 8, name: "Galar", end: 905 },
    { id: 9, name: "Paldea", end: 1025 }
  ];

  function fold(value) {
    return String(value == null ? "" : value)
      .replace(/[’‘]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function genOf(dex) {
    const n = Number(dex);
    if (!Number.isInteger(n) || n < 1) return null;
    for (let i = 0; i < GENS.length; i++) {
      if (n <= GENS[i].end) return GENS[i];
    }
    return null;
  }

  function loadTable(data) {
    const names = data && Array.isArray(data.names) ? data.names : [];
    const table = [];
    names.forEach((name, index) => {
      if (typeof name !== "string") return;
      const clean = name.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
      if (!clean) return;
      const dex = index + 1;
      const gen = genOf(dex);
      if (!gen) return;
      table.push({ name: clean, dex: dex, gen: gen.id, genName: gen.name });
    });
    return table;
  }

  function phraseHit(cardName, canonical) {
    const n = fold(cardName);
    const s = fold(canonical);
    if (!n || !s) return false;
    let from = 0;
    while (from <= n.length) {
      const at = n.indexOf(s, from);
      if (at < 0) return false;
      const before = at === 0 ? "" : n.charAt(at - 1);
      const after = at + s.length >= n.length ? "" : n.charAt(at + s.length);
      const boundary = ch => !ch || !/[a-z0-9]/i.test(ch);
      if (boundary(before) && boundary(after)) return true;
      from = at + 1;
    }
    return false;
  }

  function groupsFrom(cards, speciesOf) {
    const map = new Map();
    const bag = cards && typeof cards === "object" ? cards : {};
    Object.keys(bag).forEach(id => {
      const rec = bag[id];
      if (!id || !rec || typeof rec !== "object" || rec.missing) return;
      const name = typeof rec.name === "string" ? rec.name.replace(/\s+/g, " ").trim() : "";
      if (!name) return;
      let species = "";
      try { species = speciesOf(name) || ""; } catch (e) { species = ""; }
      species = String(species).replace(/\s+/g, " ").trim();
      if (!species) return;
      const key = fold(species);
      if (!key) return;
      let group = map.get(key);
      if (!group) {
        group = { name: species, cards: [] };
        map.set(key, group);
      }
      if (!group.cards.some(card => card.id === id)) group.cards.push({ id: id, name: name });
    });
    return [...map.values()];
  }

  function indexTable(table, speciesOf) {
    const byFold = new Map();
    const bySpecies = new Map();
    (Array.isArray(table) ? table : []).forEach(entry => {
      if (!entry || !entry.name || !entry.dex) return;
      const key = fold(entry.name);
      if (key && !byFold.has(key)) byFold.set(key, entry);
      let species = "";
      try { species = speciesOf(entry.name) || ""; } catch (e) { species = ""; }
      const sp = fold(species);
      if (!sp) return;
      if (!bySpecies.has(sp)) bySpecies.set(sp, []);
      bySpecies.get(sp).push(entry);
    });
    return { byFold: byFold, bySpecies: bySpecies };
  }

  function soleMatch(name, table) {
    let found = null;
    const list = Array.isArray(table) ? table : [];
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || !entry.name || !phraseHit(name, entry.name)) continue;
      if (found) return null;
      found = entry;
    }
    return found;
  }

  function resolveGroup(group, index) {
    const key = fold(group.name);
    const exact = index.byFold.get(key);
    if (exact && group.cards.some(card => phraseHit(card.name, exact.name))) return exact;
    const candidates = index.bySpecies.get(key) || [];
    const hits = candidates.filter(entry => group.cards.length && group.cards.every(card => phraseHit(card.name, entry.name)));
    if (hits.length === 1) return hits[0];
    return null;
  }

  function rankCard(card, canonical) {
    const name = fold(card.name);
    const want = fold(canonical);
    if (!name || !want) return 0;
    if (name === want) return 100;
    if (name.startsWith(want + " ") || name.startsWith(want + "-")) return 40;
    if (phraseHit(card.name, canonical)) return 10;
    return 1;
  }

  function artUrl(id, artFor) {
    if (!artFor || !id) return "";
    let art = null;
    try { art = artFor(id); } catch (e) { art = null; }
    const url = art && (art.thumb || art.img) || "";
    return typeof url === "string" ? url : "";
  }

  function buildSpecies(cards, table, speciesOf, artFor) {
    const unmatched = [];
    if (typeof speciesOf !== "function") return { species: [], unmatched: unmatched };
    const list = Array.isArray(table) ? table : [];
    const index = indexTable(list, speciesOf);
    const byDex = new Map();
    const claimed = new Set();
    const bag = cards && typeof cards === "object" ? cards : {};

    function ensure(match) {
      let row = byDex.get(match.dex);
      if (!row) {
        row = {
          name: match.name,
          dex: match.dex,
          gen: match.gen,
          genName: match.genName,
          browseName: "",
          ids: [],
          cards: [],
          art: ""
        };
        byDex.set(match.dex, row);
      }
      return row;
    }

    function take(row, card) {
      if (row.ids.indexOf(card.id) >= 0) return;
      row.ids.push(card.id);
      row.cards.push(card);
    }

    function noteBrowse(row, label, match, allowEmpty) {
      const name = String(label || "").replace(/\s+/g, " ").trim();
      if (!name) return;
      let want = "";
      try { want = fold(speciesOf(match.name) || match.name); } catch (e) { want = fold(match.name); }
      if (fold(name) === want || (allowEmpty && !row.browseName)) row.browseName = name;
    }

    // A title that phrase-matches exactly one national entry is that species.
    // Titles with two or more (Latias & Latios, Porygon-Z) stay on the
    // last-species path below so an existing mapping does not move.
    Object.keys(bag).forEach(id => {
      const rec = bag[id];
      if (!id || !rec || typeof rec !== "object" || rec.missing) return;
      const name = typeof rec.name === "string" ? rec.name.replace(/\s+/g, " ").trim() : "";
      if (!name) return;
      const hit = soleMatch(name, list);
      if (!hit) return;
      const row = ensure(hit);
      take(row, { id: id, name: name });
      let label = "";
      try { label = speciesOf(name) || ""; } catch (e) { label = ""; }
      noteBrowse(row, label, hit, false);
      claimed.add(id);
    });

    const rest = {};
    Object.keys(bag).forEach(id => {
      if (!claimed.has(id)) rest[id] = bag[id];
    });
    const groups = groupsFrom(rest, speciesOf);
    groups.forEach(group => {
      const match = resolveGroup(group, index);
      if (!match) {
        unmatched.push(group.name);
        return;
      }
      const row = ensure(match);
      noteBrowse(row, group.name, match, true);
      group.cards.forEach(card => take(row, card));
    });
    const species = [...byDex.values()].sort((a, b) => a.dex - b.dex || a.name.localeCompare(b.name));
    species.forEach(row => {
      if (!row.browseName) {
        let fallback = "";
        try { fallback = speciesOf(row.name) || ""; } catch (e) { fallback = ""; }
        row.browseName = String(fallback || row.name).replace(/\s+/g, " ").trim() || row.name;
      }
      const ranked = row.cards.slice().sort((a, b) => {
        const diff = rankCard(b, row.name) - rankCard(a, row.name);
        if (diff) return diff;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return String(a.id).localeCompare(String(b.id));
      });
      for (let i = 0; i < ranked.length; i++) {
        const url = artUrl(ranked[i].id, artFor);
        if (url) { row.art = url; break; }
      }
      row.ids.sort();
      delete row.cards;
    });
    unmatched.sort((a, b) => a.localeCompare(b));
    return { species: species, unmatched: unmatched };
  }

  function asIds(value) {
    const out = [];
    const push = id => {
      if (typeof id !== "string") return;
      const clean = id.trim();
      if (clean && out.indexOf(clean) < 0) out.push(clean);
    };
    if (!value) return out;
    if (typeof value.forEach === "function" && !Array.isArray(value)) {
      value.forEach(item => {
        if (typeof item === "string") push(item);
        else if (item && typeof item.id === "string") push(item.id);
      });
      return out;
    }
    if (Array.isArray(value)) {
      value.forEach(item => {
        if (typeof item === "string") push(item);
        else if (item && typeof item.id === "string") push(item.id);
      });
    }
    return out;
  }

  function pctOf(owned, total) {
    const have = Number(owned);
    const all = Number(total);
    if (!Number.isFinite(have) || !Number.isFinite(all) || all <= 0 || have <= 0) return 0;
    const pct = Math.floor((have * 100) / all);
    if (!Number.isFinite(pct) || pct < 0) return 0;
    return pct > 100 ? 100 : pct;
  }

  function collection(entries, ownedIds, wishIds) {
    const owned = new Set(asIds(ownedIds));
    const wish = new Set(asIds(wishIds));
    const species = (Array.isArray(entries) ? entries : []).map(entry => {
      const ids = Array.isArray(entry.ids) ? entry.ids : [];
      const hasOwned = ids.some(id => owned.has(id));
      const hasWish = !hasOwned && ids.some(id => wish.has(id));
      const status = hasOwned ? "owned" : hasWish ? "wish" : "missing";
      return {
        name: entry.name,
        dex: entry.dex,
        gen: entry.gen,
        genName: entry.genName,
        browseName: entry.browseName || entry.name,
        ids: ids.slice(),
        art: entry.art || "",
        status: status
      };
    });
    const generations = GENS.map(gen => {
      const rows = species.filter(entry => entry.gen === gen.id);
      const have = rows.filter(entry => entry.status === "owned").length;
      const saved = rows.filter(entry => entry.status === "wish").length;
      const total = rows.length;
      return {
        id: gen.id,
        name: gen.name,
        owned: have,
        wish: saved,
        missing: total - have - saved,
        total: total,
        pct: pctOf(have, total)
      };
    }).filter(gen => gen.total > 0);
    const total = species.length;
    const have = species.filter(entry => entry.status === "owned").length;
    const saved = species.filter(entry => entry.status === "wish").length;
    return {
      species: species,
      generations: generations,
      overall: {
        owned: have,
        wish: saved,
        missing: total - have - saved,
        total: total,
        pct: pctOf(have, total)
      }
    };
  }

  function marksReached(owned, total) {
    const have = Number(owned);
    const all = Number(total);
    if (!Number.isFinite(have) || !Number.isFinite(all) || all <= 0 || have <= 0) return [];
    return MILESTONES.filter(mark => have * 100 >= mark * all);
  }

  function pendingMilestones(generations, seen) {
    const have = seen && typeof seen.has === "function" ? seen : new Set();
    const events = [];
    (Array.isArray(generations) ? generations : []).forEach(gen => {
      if (!gen || !gen.total) return;
      const marks = marksReached(gen.owned, gen.total).filter(mark => !have.has(gen.id + ":" + mark));
      if (!marks.length) return;
      events.push({
        gen: gen.id,
        name: gen.name,
        milestone: marks[marks.length - 1],
        marks: marks
      });
    });
    return events;
  }

  function celebrateCopy(events) {
    if (!Array.isArray(events) || !events.length) return "";
    const top = events.slice().sort((a, b) => b.milestone - a.milestone || a.gen - b.gen)[0];
    const word = { 25: "a quarter caught", 50: "halfway there", 75: "three quarters caught", 100: "complete" };
    const lead = "Gen " + top.gen + " is " + (word[top.milestone] || "further along") + ".";
    if (events.length === 1) return lead;
    return lead + " " + events.length + " generations reached a new mark.";
  }

  function readSeen(raw) {
    const seen = new Set();
    const list = raw && typeof raw === "object" && Array.isArray(raw.seen) ? raw.seen : [];
    list.forEach(item => {
      if (typeof item === "string" && /^[1-9]:(?:25|50|75|100)$/.test(item)) seen.add(item);
    });
    return seen;
  }

  function payload(seen) {
    const have = seen && typeof seen.forEach === "function" ? seen : [];
    const list = [];
    have.forEach(item => {
      if (typeof item === "string" && /^[1-9]:(?:25|50|75|100)$/.test(item) && list.indexOf(item) < 0) list.push(item);
    });
    list.sort();
    return { v: 1, seen: list };
  }

  function queryHit(entry, query) {
    const q = fold(query).replace(/\s+/g, " ");
    if (!q) return true;
    if (fold(entry.name).indexOf(q) >= 0) return true;
    if (entry.browseName && fold(entry.browseName).indexOf(q) >= 0) return true;
    const digits = q.charAt(0) === "#" ? q.slice(1) : q;
    if (!/^\d{1,4}$/.test(digits)) return false;
    const num = String(entry.dex);
    const padded = num.padStart(3, "0");
    return digits === num || digits === padded || num.indexOf(digits) === 0;
  }

  function visibleSpecies(model, filter, query) {
    const want = filter === "owned" || filter === "wish" || filter === "missing" ? filter : "all";
    const species = model && Array.isArray(model.species) ? model.species : [];
    return species.filter(entry => {
      if (want !== "all" && entry.status !== want) return false;
      return queryHit(entry, query);
    });
  }

  function countLabel(genId, owned, total) {
    const have = Number.isFinite(Number(owned)) && Number(owned) > 0 ? Math.floor(Number(owned)) : 0;
    const all = Number.isFinite(Number(total)) && Number(total) > 0 ? Math.floor(Number(total)) : 0;
    return "Gen " + genId + ": " + have + "/" + all;
  }

  function cellLabel(entry) {
    const num = "#" + String(entry.dex).padStart(3, "0");
    const state = entry.status === "owned" ? "owned" : entry.status === "wish" ? "wishlisted" : "missing";
    return entry.name + " " + num + ", " + state;
  }

  return {
    KEY: KEY,
    MILESTONES: MILESTONES,
    GENS: GENS,
    fold: fold,
    genOf: genOf,
    loadTable: loadTable,
    phraseHit: phraseHit,
    buildSpecies: buildSpecies,
    collection: collection,
    pctOf: pctOf,
    marksReached: marksReached,
    pendingMilestones: pendingMilestones,
    celebrateCopy: celebrateCopy,
    readSeen: readSeen,
    payload: payload,
    visibleSpecies: visibleSpecies,
    countLabel: countLabel,
    cellLabel: cellLabel
  };
});
