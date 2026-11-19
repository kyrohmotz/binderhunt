/* Rip a pack. Just for fun, not real pull rates.
   Loaded as a classic script (window.BinderRips) and as CommonJS.
   Packs are dealt from cards already in memory: the Scrydex cache for
   raw near-mint prices, the seed file and Daily Drop pool for rarity,
   and any card the hunt has already opened. It does not fetch Scrydex
   or any other price API. Prices under one cent, zeroes, and non-finite
   numbers are "No price yet", never $0 or NaN. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderRips = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEY = "bh.rips.v1";
  const MIN_CARDS = 4;
  const LOG_CAP = 50;
  const DISCLAIMER = "Just for fun, not real pull rates.";
  const HIT_ULTRA = 0.08;
  const HIT_HOLO = 0.30;
  const RANK = { common: 1, uncommon: 2, rare: 3, holo: 4, ultra: 5 };
  const VINTAGE = ["common", "common", "common", "common", "common", "common", "common", "uncommon", "uncommon", "uncommon", "hit"];
  const MID = ["common", "common", "common", "common", "common", "uncommon", "uncommon", "uncommon", "rare", "hit"];
  const MODERN = ["common", "common", "common", "common", "uncommon", "uncommon", "uncommon", "rare", "rare", "hit"];
  const FALLBACK = {
    common: ["common", "uncommon", "rare", "holo", "ultra"],
    uncommon: ["uncommon", "common", "rare", "holo", "ultra"],
    rare: ["rare", "holo", "uncommon", "ultra", "common"],
    holo: ["holo", "ultra", "rare", "uncommon", "common"],
    ultra: ["ultra", "holo", "rare", "uncommon", "common"]
  };
  const SEED_LINE = /^([AB])\s+(\S+)\s+#\s+(.*?)\s+·\s+(.*?)\s+·\s+([0-9.]+)\s+(USD|EUR)\s*$/;
  const ERA_ORDER = ["Mega Evolution", "Scarlet & Violet", "Sword & Shield", "Sun & Moon", "XY", "Black & White", "HeartGold & SoulSilver", "Diamond & Pearl", "EX", "WOTC", "Other"];

  function browseApi() {
    if (typeof BinderBrowse !== "undefined" && BinderBrowse && BinderBrowse.latestPrice) return BinderBrowse;
    if (typeof globalThis !== "undefined" && globalThis.BinderBrowse && globalThis.BinderBrowse.latestPrice) return globalThis.BinderBrowse;
    return null;
  }

  function norm(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function cleanId(id) {
    const text = norm(id);
    return text && text.length <= 80 && text.indexOf("-") > 0 ? text : "";
  }

  function splitId(id) {
    const text = String(id || "");
    const cut = text.lastIndexOf("-");
    if (cut <= 0 || cut === text.length - 1) return { setId: "", number: "" };
    return { setId: text.slice(0, cut), number: text.slice(cut + 1) };
  }

  function eraOf(id) {
    const s = String(id || "");
    if (/^me/.test(s)) return "Mega Evolution";
    if (/^sv/.test(s)) return "Scarlet & Violet";
    if (/^swsh/.test(s)) return "Sword & Shield";
    if (/^sm/.test(s)) return "Sun & Moon";
    if (/^xy/.test(s)) return "XY";
    if (/^bw/.test(s)) return "Black & White";
    if (/^(hgss|col)/.test(s)) return "HeartGold & SoulSilver";
    if (/^(dp|pl)/.test(s)) return "Diamond & Pearl";
    if (/^ex/.test(s)) return "EX";
    if (/^(base|gym|neo|ecard|pop|np|si|lc)/.test(s)) return "WOTC";
    return "Other";
  }

  function slotsFor(setId) {
    const era = eraOf(setId);
    if (era === "WOTC") return VINTAGE.slice();
    if (era === "EX" || era === "Diamond & Pearl" || era === "HeartGold & SoulSilver") return MID.slice();
    return MODERN.slice();
  }

  function bucketOf(rarity) {
    const t = norm(rarity).toLowerCase();
    if (!t || t === "—" || t === "-" || t === "unknown") return "";
    if (t.indexOf("uncommon") !== -1) return "uncommon";
    if (t.indexOf("common") !== -1) return "common";
    if (/illustration|hyper rare|secret|ultra|shiny ultra|radiant|amazing|mega hyper|ace spec|classic collection|legend|rare prime|double rare|shiny rare/.test(t)) return "ultra";
    if (t.indexOf("holo") !== -1 || t.indexOf("☆") !== -1) return "holo";
    if (t === "rare" || /^rare\b/.test(t)) return "rare";
    return "rare";
  }

  function positivePrice(value) {
    const n = typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n) || n < 0.01) return null;
    const rounded = Math.round(n * 100) / 100;
    return rounded >= 0.01 ? rounded : null;
  }

  function priceLabel(value) {
    const amount = positivePrice(value);
    if (amount == null) return "No price yet";
    let text = "";
    try {
      text = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
    } catch (e) {
      text = "$" + amount.toFixed(2);
    }
    if (!text || /NaN|Infinity/i.test(text) || /^[^0-9]*0(?:\.00)?$/.test(text)) return "No price yet";
    return text;
  }

  function localLatest(rec) {
    const rows = rec && Array.isArray(rec.history) ? rec.history : [];
    const latest = new Map();
    rows.forEach(row => {
      if (!row || typeof row !== "object") return;
      const price = positivePrice(typeof row.m === "number" ? row.m : NaN);
      const match = String(row.d || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (!price || !match) return;
      const day = Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
      if (!(day > 0)) return;
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

  function latestPrice(rec) {
    const browse = browseApi();
    if (browse) return positivePrice(browse.latestPrice(rec));
    return localLatest(rec);
  }

  function localArt(id) {
    const blank = { image: "", thumb: "", img: "", backup: "" };
    const parts = splitId(id);
    if (!parts.setId || !parts.number) return blank;
    if ((parts.setId === "ecard2" || parts.setId === "ecard3") && /^h\d+$/i.test(parts.number)) {
      const n = String(parseInt(parts.number.replace(/\D/g, ""), 10));
      if (!n || n === "NaN") return blank;
      const png = "https://images.pokemontcg.io/" + parts.setId + "/H" + n + ".png";
      return { image: "", thumb: png, img: png, backup: png };
    }
    const serie = (/^[a-z]+/i.exec(parts.setId) || [""])[0].toLowerCase();
    if (!serie) return blank;
    const base = "https://assets.tcgdex.net/en/" + serie + "/" + parts.setId + "/" + parts.number;
    return {
      image: base,
      thumb: base + "/low.webp",
      img: base + "/high.webp",
      backup: "https://images.pokemontcg.io/" + parts.setId + "/" + parts.number + ".png"
    };
  }

  function artFor(id) {
    const browse = browseApi();
    if (browse && browse.artFor) return browse.artFor(id);
    return localArt(id);
  }

  function parseSeed(text) {
    const rows = [];
    String(text || "").split(/\n/).forEach(line => {
      const raw = line.trim();
      if (!raw || raw.charAt(0) === "#") return;
      const match = SEED_LINE.exec(raw);
      if (!match) return;
      const id = cleanId(match[2]);
      if (!id) return;
      rows.push({ id, name: norm(match[3]), rarity: norm(match[4]) });
    });
    return rows;
  }

  function blankCard(id) {
    const parts = splitId(id);
    const art = artFor(id);
    return {
      id,
      name: "",
      setId: parts.setId,
      setName: "",
      number: parts.number,
      rarity: "",
      bucket: "",
      price: null,
      priceLabel: "No price yet",
      image: art.image,
      thumb: art.thumb,
      img: art.img,
      backup: art.backup
    };
  }

  function buildCatalog(input) {
    const opts = input && typeof input === "object" ? input : {};
    const cache = opts.cards && typeof opts.cards === "object" ? opts.cards : {};
    const names = opts.names && typeof opts.names === "object" ? opts.names : {};
    const byId = new Map();

    function take(id) {
      const clean = cleanId(id);
      if (!clean) return null;
      let row = byId.get(clean);
      if (!row) {
        row = blankCard(clean);
        byId.set(clean, row);
      }
      return row;
    }

    Object.keys(cache).forEach(id => {
      const rec = cache[id];
      if (!rec || rec.missing) return;
      const row = take(id);
      if (!row) return;
      if (!row.name && typeof rec.name === "string") row.name = norm(rec.name);
      const price = latestPrice(rec);
      if (price) {
        row.price = price;
        row.priceLabel = priceLabel(price);
      }
    });

    parseSeed(opts.seedText || "").forEach(seed => {
      const row = take(seed.id);
      if (!row) return;
      if (!row.name && seed.name) row.name = seed.name;
      if (!row.rarity && seed.rarity) row.rarity = seed.rarity;
    });

    (Array.isArray(opts.pool) ? opts.pool : []).forEach(card => {
      if (!card || !card.id) return;
      const row = take(card.id);
      if (!row) return;
      if (!row.name && card.name) row.name = norm(card.name);
      if (!row.rarity && card.rarity) row.rarity = norm(card.rarity);
      if (!row.setName && card.set) row.setName = norm(card.set);
    });

    (Array.isArray(opts.extras) ? opts.extras : []).forEach(card => {
      if (!card || !card.id) return;
      const row = take(card.id);
      if (!row) return;
      if (!row.name && card.name) row.name = norm(card.name);
      if (!row.rarity && card.rarity) row.rarity = norm(card.rarity);
      if (!row.setName && card.set) row.setName = norm(card.set);
      if (card.number && !row.number) row.number = norm(card.number);
      const artImage = typeof card.image === "string" ? card.image : "";
      const thumb = typeof card.thumb === "string" ? card.thumb : "";
      const img = typeof card.img === "string" ? card.img : "";
      if (artImage && !row.image) row.image = artImage;
      if (thumb && row.thumb.indexOf("tcgdex.net") === -1 && row.thumb.indexOf("pokemontcg.io") === -1) row.thumb = thumb;
      if (img && !row.img) row.img = img;
    });

    const sets = new Map();
    byId.forEach(row => {
      row.bucket = bucketOf(row.rarity);
      if (!row.bucket || !row.setId) return;
      if (!row.name) row.name = row.id;
      if (!row.setName && names[row.setId]) row.setName = norm(names[row.setId]);
      if (!row.priceLabel) row.priceLabel = priceLabel(row.price);
      let set = sets.get(row.setId);
      if (!set) {
        set = {
          id: row.setId,
          name: row.setName || names[row.setId] || row.setId,
          era: eraOf(row.setId),
          cards: [],
          buckets: { common: 0, uncommon: 0, rare: 0, holo: 0, ultra: 0 }
        };
        sets.set(row.setId, set);
      }
      if (row.setName && set.name === set.id) set.name = row.setName;
      set.cards.push(row);
      set.buckets[row.bucket] += 1;
    });

    const list = [];
    sets.forEach(set => {
      if (set.cards.length < MIN_CARDS) return;
      set.count = set.cards.length;
      list.push(set);
    });
    list.sort((a, b) => {
      const era = ERA_ORDER.indexOf(a.era) - ERA_ORDER.indexOf(b.era);
      if (era) return era;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
    return { sets: list, byId };
  }

  function listSets(catalog) {
    return catalog && Array.isArray(catalog.sets) ? catalog.sets.slice() : [];
  }

  function hashString(value) {
    let h = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rngFrom(seed) {
    let h = hashString(seed) || 1;
    return function () {
      h += 0x6D2B79F5;
      let t = h;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function takeFrom(pools, bucket, rng) {
    const order = FALLBACK[bucket] || FALLBACK.rare;
    for (let i = 0; i < order.length; i++) {
      const bag = pools[order[i]];
      if (!bag || !bag.length) continue;
      const index = Math.min(bag.length - 1, Math.floor(rng() * bag.length));
      return bag.splice(index, 1)[0];
    }
    return null;
  }

  function hitBucket(roll, counts) {
    const has = key => counts && counts[key] > 0;
    const n = typeof roll === "number" && Number.isFinite(roll) ? roll : 1;
    if (n < HIT_ULTRA && has("ultra")) return "ultra";
    if (n < HIT_HOLO && has("holo")) return "holo";
    if (has("rare")) return "rare";
    if (has("holo")) return "holo";
    if (has("ultra")) return "ultra";
    if (has("uncommon")) return "uncommon";
    if (has("common")) return "common";
    return "";
  }

  function copyCard(card) {
    return {
      id: card.id,
      name: card.name,
      setId: card.setId,
      setName: card.setName,
      number: card.number,
      rarity: card.rarity,
      bucket: card.bucket,
      price: card.price,
      priceLabel: card.priceLabel || priceLabel(card.price),
      image: card.image,
      thumb: card.thumb,
      img: card.img,
      backup: card.backup,
      hit: false
    };
  }

  function packValue(cards) {
    let total = 0;
    let priced = 0;
    (Array.isArray(cards) ? cards : []).forEach(card => {
      const amount = positivePrice(card && card.price);
      if (amount == null) return;
      total += amount;
      priced += 1;
    });
    if (!priced) return { total: null, priced: 0, label: "No price yet" };
    const rounded = positivePrice(Math.round(total * 100) / 100);
    return { total: rounded, priced, label: priceLabel(rounded) };
  }

  function bestCard(cards) {
    const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
    if (!list.length) return null;
    let best = null;
    list.forEach(card => {
      const amount = positivePrice(card.price);
      if (amount == null) return;
      if (!best || amount > best.price || (amount === best.price && RANK[card.bucket] > RANK[best.bucket])) {
        best = card;
      }
    });
    if (best) return best;
    return list.reduce((top, card) => (RANK[card.bucket] || 0) >= (RANK[top.bucket] || 0) ? card : top, list[0]);
  }

  function buildPack(cards, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const source = (Array.isArray(cards) ? cards : []).filter(card => card && card.id && card.bucket);
    const seen = new Set();
    const unique = [];
    source.forEach(card => {
      if (seen.has(card.id)) return;
      seen.add(card.id);
      unique.push(card);
    });
    if (unique.length < MIN_CARDS) return null;
    const setId = options.setId || unique[0].setId || "";
    let slots = slotsFor(setId);
    if (unique.length < slots.length) slots = slots.slice(slots.length - unique.length);
    const pools = { common: [], uncommon: [], rare: [], holo: [], ultra: [] };
    unique.forEach(card => {
      if (pools[card.bucket]) pools[card.bucket].push(card);
    });
    const rng = typeof options.rng === "function" ? options.rng : rngFrom(options.seed != null ? options.seed : String(Math.random()));
    const drawn = [];
    for (let i = 0; i < slots.length; i++) {
      let bucket = slots[i];
      if (bucket === "hit") {
        const counts = {
          common: pools.common.length,
          uncommon: pools.uncommon.length,
          rare: pools.rare.length,
          holo: pools.holo.length,
          ultra: pools.ultra.length
        };
        bucket = hitBucket(rng(), counts);
      }
      const card = bucket ? takeFrom(pools, bucket, rng) : null;
      if (card) drawn.push(copyCard(card));
    }
    if (!drawn.length) return null;
    const hit = drawn[drawn.length - 1];
    const rest = drawn.slice(0, -1);
    rest.sort((a, b) => (RANK[a.bucket] || 0) - (RANK[b.bucket] || 0) || a.id.localeCompare(b.id));
    const ordered = rest.concat(hit);
    let maxIndex = 0;
    ordered.forEach((card, index) => {
      if ((RANK[card.bucket] || 0) >= (RANK[ordered[maxIndex].bucket] || 0)) maxIndex = index;
    });
    if (maxIndex !== ordered.length - 1) ordered.push(ordered.splice(maxIndex, 1)[0]);
    ordered[ordered.length - 1].hit = true;
    const setName = options.setName || ordered[0].setName || setId;
    ordered.forEach(card => { card.setName = card.setName || setName; });
    return {
      setId,
      setName,
      era: eraOf(setId),
      disclaimer: DISCLAIMER,
      cards: ordered,
      value: packValue(ordered),
      best: bestCard(ordered)
    };
  }

  function bonusSetId(sets, dayKey, prefer) {
    const list = (Array.isArray(sets) ? sets : []).map(set => (set && set.id) || set).filter(Boolean);
    const ids = list.slice().sort();
    if (!ids.length || !dayKey) return "";
    if (prefer && ids.indexOf(prefer) !== -1) return prefer;
    return ids[hashString(String(dayKey)) % ids.length];
  }

  function slimCard(card) {
    if (!card || !card.id) return null;
    return {
      id: String(card.id),
      name: norm(card.name).slice(0, 80),
      rarity: norm(card.rarity).slice(0, 60),
      bucket: RANK[card.bucket] ? card.bucket : "",
      price: positivePrice(card.price),
      setId: norm(card.setId).slice(0, 40),
      setName: norm(card.setName).slice(0, 80)
    };
  }

  function emptyLog() {
    return { v: 1, rips: [], best: null, bonusDay: "" };
  }

  function cleanBest(raw) {
    const card = slimCard(raw);
    if (!card) return null;
    const at = raw && typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0;
    card.at = at > 0 ? at : 0;
    return card;
  }

  function normalizeLog(raw) {
    const next = emptyLog();
    if (!raw || typeof raw !== "object") return next;
    const rips = Array.isArray(raw.rips) ? raw.rips : [];
    rips.forEach(entry => {
      if (!entry || typeof entry !== "object") return;
      const cards = (Array.isArray(entry.cards) ? entry.cards : []).map(slimCard).filter(Boolean);
      if (!entry.setId || !cards.length) return;
      const best = slimCard(entry.best) || cards[cards.length - 1];
      next.rips.push({
        at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
        day: typeof entry.day === "string" ? entry.day : "",
        setId: norm(entry.setId).slice(0, 40),
        setName: norm(entry.setName).slice(0, 80),
        bonus: entry.bonus === true,
        total: positivePrice(entry.total),
        priced: typeof entry.priced === "number" && entry.priced > 0 ? Math.floor(entry.priced) : 0,
        count: cards.length,
        best,
        cards
      });
    });
    if (next.rips.length > LOG_CAP) next.rips = next.rips.slice(next.rips.length - LOG_CAP);
    next.best = cleanBest(raw.best);
    next.bonusDay = typeof raw.bonusDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.bonusDay) ? raw.bonusDay : "";
    return next;
  }

  function loadLog(storage) {
    if (!storage || typeof storage.getItem !== "function") return emptyLog();
    try {
      return normalizeLog(JSON.parse(storage.getItem(KEY) || "null"));
    } catch (e) {
      return emptyLog();
    }
  }

  function saveLog(storage, state) {
    if (!storage || typeof storage.setItem !== "function") return false;
    try {
      storage.setItem(KEY, JSON.stringify(normalizeLog(state)));
      return true;
    } catch (e) {
      return false;
    }
  }

  function recordRip(state, pack, meta) {
    const next = normalizeLog(state);
    if (!pack || !Array.isArray(pack.cards) || !pack.cards.length || !pack.setId) return next;
    const info = meta && typeof meta === "object" ? meta : {};
    const cards = pack.cards.map(slimCard).filter(Boolean);
    if (!cards.length) return next;
    const best = slimCard(pack.best) || cards[cards.length - 1];
    const at = typeof info.at === "number" && Number.isFinite(info.at) ? info.at : Date.now();
    next.rips.push({
      at,
      day: typeof info.day === "string" ? info.day : "",
      setId: pack.setId,
      setName: pack.setName || pack.setId,
      bonus: info.bonus === true,
      total: pack.value ? positivePrice(pack.value.total) : null,
      priced: pack.value && pack.value.priced ? pack.value.priced : 0,
      count: cards.length,
      best,
      cards
    });
    if (next.rips.length > LOG_CAP) next.rips = next.rips.slice(next.rips.length - LOG_CAP);
    const amount = best && positivePrice(best.price);
    const prev = next.best && positivePrice(next.best.price);
    if (amount != null && (prev == null || amount > prev)) {
      next.best = cleanBest(Object.assign({}, best, { at }));
    }
    if (info.bonus === true && typeof info.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(info.day)) next.bonusDay = info.day;
    return next;
  }

  function bonusReady(state, dayKey) {
    if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey))) return false;
    const log = normalizeLog(state);
    return log.bonusDay !== dayKey;
  }

  return {
    KEY,
    MIN_CARDS,
    LOG_CAP,
    DISCLAIMER,
    HIT_ULTRA,
    HIT_HOLO,
    bucketOf,
    eraOf,
    slotsFor,
    priceLabel,
    packValue,
    bestCard,
    parseSeed,
    buildCatalog,
    listSets,
    buildPack,
    hitBucket,
    bonusSetId,
    bonusReady,
    loadLog,
    saveLog,
    recordRip,
    normalizeLog,
    latestPrice,
    artFor
  };
});
