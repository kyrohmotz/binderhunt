/* Browse by Pokémon and by illustrator.
   Loaded as a classic script (window.BinderBrowse) and as CommonJS.
   Reads only records already in memory. It does not fetch Scrydex or
   TCGdex. The price file stores a name and raw market history, and it
   does not store an illustrator. Cards with no illustrator stay out of
   that shelf. A card opened later can be attached with noteArtist. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderBrowse = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SPECIES_SKIP = {
    dark: 1, light: 1, shining: 1, shiny: 1, team: 1, rocket: 1, rockets: 1,
    radiant: 1, amazing: 1, galarian: 1, alolan: 1, hisuian: 1, paldean: 1,
    the: 1, an: 1, ex: 1, gx: 1, v: 1, vmax: 1, vstar: 1,
    break: 1, legend: 1, star: 1, prism: 1, lv: 1, lvx: 1,
    union: 1, "v-union": 1, vunion: 1
  };
  const NOT_POKEMON = /\b(?:energy|professor|boss'?s orders|stadium|supporter)\b/i;
  const NOT_SPECIES = { energy: 1, orders: 1, recycler: 1, juniper: 1 };

  function norm(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function keyOf(value) {
    return norm(value).toLowerCase();
  }

  function positive(value) {
    const n = typeof value === "number" ? value : (value == null || value === "" ? NaN : Number(value));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function dayKey(value) {
    const m = String(value || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!m) return 0;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
    return y * 10000 + mo * 100 + d;
  }

  function cleanPerson(value) {
    if (typeof value !== "string") return "";
    const name = norm(value).slice(0, 80);
    if (!name || name === "[object Object]") return "";
    return name;
  }

  function speciesName(name) {
    const words = String(name || "").match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const kept = [];
    words.forEach(word => {
      let display = word.replace(/['’]s$/i, "");
      let token = display.toLowerCase();
      if (SPECIES_SKIP[token]) return;
      let guard = 0;
      while (guard++ < 4) {
        const dash = token.lastIndexOf("-");
        if (dash <= 0 || !SPECIES_SKIP[token.slice(dash + 1)]) break;
        display = display.slice(0, display.lastIndexOf("-"));
        token = token.slice(0, dash);
      }
      if (SPECIES_SKIP[token] || token.length <= 1) return;
      kept.push(display);
    });
    return kept.length ? kept[kept.length - 1] : "";
  }

function pokemonSpecies(name) {
  const raw = norm(name);
  if (!raw || NOT_POKEMON.test(raw)) return "";
  const species = speciesName(raw);
  if (species && !NOT_SPECIES[species.toLowerCase()] && speciesHit(raw, species)) return species;
  // Porygon2 is one word to collectors. The letter-only species trim would
  // call it Porygon, and a Porygon hunt would not keep it.
  if (/^[A-Za-z][A-Za-z0-9'.-]{1,40}$/.test(raw) && !NOT_SPECIES[raw.toLowerCase()]) return raw;
  return "";
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

  function artistAllowed(cardArtist, filter) {
    const want = keyOf(filter);
    if (!want) return true;
    const got = keyOf(cardArtist);
    return !!got && got === want;
  }

  function illustratorOf(rec) {
    if (!rec || typeof rec !== "object") return "";
    return cleanPerson(typeof rec.illustrator === "string" ? rec.illustrator : rec.artist);
  }

  function latestPrice(rec) {
    const rows = rec && Array.isArray(rec.history) ? rec.history : [];
    const latest = new Map();
    rows.forEach(row => {
      if (!row || typeof row !== "object") return;
      const price = positive(row.m);
      const day = dayKey(row.d);
      if (!price || !day) return;
      const variant = String(row.v || "");
      const prev = latest.get(variant);
      if (!prev || day >= prev.day) latest.set(variant, { day, price });
    });
    let best = null;
    latest.forEach(item => {
      if (best == null || item.price < best) best = item.price;
    });
    return best;
  }

  function serieOf(setId) {
    const match = /^[a-z]+/i.exec(String(setId || ""));
    return match ? match[0].toLowerCase() : "";
  }

  function splitId(id) {
    const text = String(id || "");
    const cut = text.lastIndexOf("-");
    if (cut <= 0 || cut === text.length - 1) return { setId: "", number: "" };
    return { setId: text.slice(0, cut), number: text.slice(cut + 1) };
  }

  function artFor(id) {
    const blank = { image: "", thumb: "", img: "", backup: "" };
    const parts = splitId(id);
    if (!parts.setId || !parts.number) return blank;
    if ((parts.setId === "ecard2" || parts.setId === "ecard3") && /^h\d+$/i.test(parts.number)) {
      const n = String(parseInt(parts.number.replace(/\D/g, ""), 10));
      if (!n || n === "NaN") return blank;
      const png = "https://images.pokemontcg.io/" + parts.setId + "/H" + n + ".png";
      return { image: "", thumb: png, img: png, backup: png };
    }
    const serie = serieOf(parts.setId);
    if (!serie) return blank;
    const base = "https://assets.tcgdex.net/en/" + serie + "/" + parts.setId + "/" + parts.number;
    return {
      image: base,
      thumb: base + "/low.webp",
      img: base + "/high.webp",
      backup: "https://images.pokemontcg.io/" + parts.setId + "/" + parts.number + ".png"
    };
  }

  function emptyIndex() {
    return {
      byId: new Map(),
      species: new Map(),
      artists: new Map(),
      speciesList: [],
      artistList: [],
      coverage: { cards: 0, named: 0, priced: 0, withIllustrator: 0 }
    };
  }

  function groupNames(map) {
    return [...map.values()].map(group => group.name).sort((a, b) => a.localeCompare(b));
  }

  function addToGroup(map, label, row) {
    const key = keyOf(label);
    if (!key) return;
    let group = map.get(key);
    if (!group) {
      group = { name: norm(label), cards: [] };
      map.set(key, group);
    }
    if (!group.cards.some(card => card.id === row.id)) group.cards.push(row);
  }

  function removeFromGroup(map, label, id) {
    const group = map.get(keyOf(label));
    if (!group) return;
    group.cards = group.cards.filter(card => card.id !== id);
    if (!group.cards.length) map.delete(keyOf(label));
  }

  function makeRow(id, name, price, artist) {
    const parts = splitId(id);
    const art = artFor(id);
    return {
      id: id,
      name: name,
      price: price,
      artist: artist || "",
      species: pokemonSpecies(name),
      setId: parts.setId,
      number: parts.number,
      image: art.image,
      img: art.img,
      thumb: art.thumb,
      backup: art.backup,
      source: "cache"
    };
  }

  function addRecord(index, id, rec) {
    if (!index || !id || index.byId.has(id)) return;
    index.coverage.cards += 1;
    const artist = illustratorOf(rec);
    if (artist) index.coverage.withIllustrator += 1;
    if (!rec || typeof rec !== "object" || rec.missing) return;
    const name = typeof rec.name === "string" ? norm(rec.name) : "";
    if (name) index.coverage.named += 1;
    const price = latestPrice(rec);
    if (!price) return;
    index.coverage.priced += 1;
    const species = pokemonSpecies(name);
    if (!species && !artist) return;
    const row = makeRow(id, name || id, price, artist);
    index.byId.set(id, row);
    if (species) addToGroup(index.species, species, row);
    if (artist) addToGroup(index.artists, artist, row);
  }

  function finishIndex(index) {
    index.speciesList = groupNames(index.species);
    index.artistList = groupNames(index.artists);
    return index;
  }

  function buildIndex(cards) {
    const index = emptyIndex();
    const bag = cards && typeof cards === "object" ? cards : {};
    Object.keys(bag).forEach(id => addRecord(index, id, bag[id]));
    return finishIndex(index);
  }

  function byPrice(a, b) {
    return b.price - a.price || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  }

  function cardsForSpecies(index, name) {
    if (!index) return [];
    const group = index.species.get(keyOf(name));
    return group ? group.cards.slice().sort(byPrice) : [];
  }

  function cardsForArtist(index, name) {
    if (!index) return [];
    const group = index.artists.get(keyOf(name));
    return group ? group.cards.slice().sort(byPrice) : [];
  }

  function noteArtist(index, id, artist, extra) {
    if (!index || !id) return false;
    const name = cleanPerson(artist);
    if (!name) return false;
    const info = extra && typeof extra === "object" ? extra : {};
let row = index.byId.get(id);
  if (!row) {
    const price = positive(info.price);
    if (!price) return false;
    const cardName = norm(info.name) || id;
    const art = artFor(id);
    const parts = splitId(id);
    // A card opened from the catalog joins the illustrator shelf only.
    // The Pokémon shelf stays the priced file, so a hunt cannot flood it.
    row = {
      id: id,
      name: cardName,
      price: price,
      artist: "",
      species: "",
      setId: norm(info.setId) || parts.setId,
      number: norm(info.number) || parts.number,
      image: typeof info.image === "string" && info.image ? info.image : art.image,
      img: typeof info.img === "string" && info.img ? info.img : art.img,
      thumb: typeof info.thumb === "string" && info.thumb ? info.thumb : art.thumb,
      backup: art.backup,
      source: "opened"
    };
    index.byId.set(id, row);
  }
    if (keyOf(row.artist) === keyOf(name)) return false;
    if (row.artist) removeFromGroup(index.artists, row.artist, id);
    row.artist = name;
    addToGroup(index.artists, name, row);
    index.artistList = groupNames(index.artists);
    index.speciesList = groupNames(index.species);
    return true;
  }

  function suggest(options, query, limit) {
    const q = keyOf(query);
    const cap = limit > 0 ? limit : 8;
    if (!q) return [];
    const starts = [];
    const rest = [];
    const seen = new Set();
    (Array.isArray(options) ? options : []).forEach(item => {
      const label = norm(item);
      const key = label.toLowerCase();
      if (!key || seen.has(key)) return;
      if (key.startsWith(q)) {
        starts.push(label);
        seen.add(key);
      } else if (key.includes(q)) {
        rest.push(label);
        seen.add(key);
      }
    });
    const order = (a, b) => a.localeCompare(b);
    starts.sort(order);
    rest.sort(order);
    return starts.concat(rest).slice(0, cap);
  }

  function popular(index, limit) {
    if (!index) return [];
    const cap = limit > 0 ? limit : 8;
    return [...index.species.values()]
      .sort((a, b) => b.cards.length - a.cards.length || a.name.localeCompare(b.name))
      .slice(0, cap)
      .map(group => group.name);
  }

  return {
    speciesName,
    pokemonSpecies,
    speciesHit,
    artistAllowed,
    cleanPerson,
    positive,
    latestPrice,
    artFor,
    buildIndex,
    noteArtist,
    cardsForSpecies,
    cardsForArtist,
    suggest,
    popular
  };
});
