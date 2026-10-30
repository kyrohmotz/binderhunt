/* Gemfinder. Overlooked cards, not a population census.
   Loaded as a classic script in the browser (window.BinderGems) and as
   CommonJS by scripts/test_gems.mjs. No network, no DOM, no Scrydex.

   A gem is a physical card we already know from data/scrydex-seed.txt or
   data/daily.json (or any object with the same fields). The Scrydex cache
   does hold grade counts for some cards, but those reports are incomplete:
   many cards were never fetched, the file is not a live census, and auth
   or qualifier grades are mixed in. Gemfinder does not read them and does
   not call a card low-pop.

   A card is a gem when all of these are true:

   1. Overlooked printing, from data we already store.
      - e-Card holo: Expedition (ecard1), Aquapolis (ecard2), or Skyridge
        (ecard3), and the rarity contains "Holo" or the collector number
        starts with H (the e-Card holo slot).
      - Older holo or special rarity: set id starts with ex, pop, dp, pl,
        hgss, col, bw, xy, or sm, and the rarity is Rare Holo, Holo Rare,
        Rare Holo EX, Rare Holo LV.X, Rare PRIME, or LEGEND.
      - Ultra Rare only for EX, POP, DP, Platinum, HGSS, and Call of
        Legends (set id starts with ex, pop, dp, pl, hgss, or col).
        BW, XY, and SM Ultra Rares are full-art chase cards (EX, GX, and
        full-art supporters), so that whole group stays out.
      - Topps Chrome / Tekno: the set id, set name, or card name contains
        "topps" or "tekno". The seed and the daily pool have none today.
        The rule stays so a later list is picked up without a new definition.
      Call of Legends holos (set col1) are badged "Call of Legends holo",
      not "HGSS holo". Seed lines have no types. buildCatalog copies a
      type from the daily pool when the card id matches, or when every
      saved card with that exact name agrees. A gem left with no types is
      unknown, and a type filter keeps it.
   2. Cached raw price is a buy. USD from 8 through 150 inclusive, using the
      cheapest positive TCGplayer market on the card, or the seed's USD
      quote. An EUR-only quote counts only when multiplied by the eurUsd
      rate already in data/fx.json. Missing, zero, and non-finite prices
      are not gems. Nothing here is a grade-population adjustment.
   3. Not a card the main hunt already leads with. The rarity is not a
      modern chase rarity, the set is not one of the default opening sets,
      and the card is not tier A of the chase seed (the weekly headliners).
      Set ids that contain a dot, and the imageless gallery ids, are left
      out because we have no reliable scan for them in the cached lists.
   4. Not already saved often on this browser. saveHeat counts "save"
      events. Three or more and the card leaves the pocket. No history
      counts as zero.

   The deck built from this list is finite. takeGemCycle walks it and, once
   every card has been served, starts again at the top. A fill that only
   stacks the whole small pool does not count as that lap. wrapped is set
   when a card from the next lap is dealt, including a pocket of 4 or
   fewer whose cursor was left at the end. WRAP_MESSAGE is the line to
   show then. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BinderGems = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const GEM_MIN = 8;
  const GEM_MAX = 150;
  const GEM_HEAT = 3;
  const EXPLAIN = "Hand-picked eras and rarities that fly under the radar.";
  const WRAP_MESSAGE = "That's the pocket. These gems are shuffled back in.";
  const LINE = /^([AB])\s+(\S+)\s+#\s+(.*?)\s+·\s+(.*?)\s+·\s+([0-9.]+)\s+(USD|EUR)\s*$/;
  const CHASE = {
    "Special illustration rare": 1,
    "Illustration rare": 1,
    "Hyper rare": 1,
    "Mega Hyper Rare": 1,
    "Secret Rare": 1,
    "Shiny Ultra Rare": 1,
    "Shiny rare VMAX": 1,
    "Shiny rare V": 1,
    "Holo Rare VMAX": 1,
    "Holo Rare VSTAR": 1,
    "Radiant Rare": 1,
    "Amazing Rare": 1
  };
  const MID_RARITY = {
    "Rare Holo": 1,
    "Holo Rare": 1,
    "Rare Holo EX": 1,
    "Rare Holo LV.X": 1,
    "Rare PRIME": 1,
    "LEGEND": 1
  };
  const OLD_ULTRA = /^(?:ex|pop|dp|pl|hgss|col)/;
  const OPENING = {
    "sv08": 1, "sv04.5": 1, "sv07": 1, "sv06": 1, "sv01": 1, "me02": 1, "sv02": 1,
    "swsh7": 1, "swsh12.5": 1, "swsh11": 1, "swsh12": 1, "swsh8": 1,
    "sv03.5": 1, "base1": 1, "base4": 1, "neo1": 1, "sv03": 1
  };
  const SET_NAMES = {
    ecard1: "Expedition Base Set",
    ecard2: "Aquapolis",
    ecard3: "Skyridge"
  };
  const ERA_ORDER = ["ecard", "ex", "pop", "dp", "pl", "hgss", "col", "bw", "xy", "sm", "other"];

  function setIdOf(card) {
    if (card && typeof card.setId === "string" && card.setId.trim()) return card.setId.trim();
    const id = String(card && card.id || "");
    const cut = id.lastIndexOf("-");
    return cut > 0 ? id.slice(0, cut) : "";
  }

  function numberOf(card) {
    if (card && card.number != null && String(card.number).trim()) return String(card.number).trim();
    if (card && card.localId != null && String(card.localId).trim()) return String(card.localId).trim();
    const id = String(card && card.id || "");
    const cut = id.lastIndexOf("-");
    return cut >= 0 ? id.slice(cut + 1) : "";
  }

  function openingHas(setId, opening) {
    if (!setId) return false;
    if (opening && typeof opening.has === "function" && !Array.isArray(opening)) return opening.has(setId);
    if (Array.isArray(opening)) return opening.indexOf(setId) !== -1;
    return !!OPENING[setId];
  }

  function gemUsd(card, fx) {
    if (!card || typeof card !== "object") return null;
    if (card.quoteCurrency === "EUR") {
      const rate = Number(fx);
      const eur = Number(card.quoteAmount != null ? card.quoteAmount : card.price);
      if (!(rate > 0.2 && rate < 5) || !Number.isFinite(eur) || eur <= 0) return null;
      return Math.round(eur * rate * 100) / 100;
    }
    const vals = [];
    const variants = Array.isArray(card.variants) ? card.variants : [];
    variants.forEach(variant => {
      const n = Number(variant && variant.market);
      if (Number.isFinite(n) && n > 0) vals.push(n);
    });
    const raw = Number(card.price);
    if (Number.isFinite(raw) && raw > 0 && card.quoteCurrency !== "EUR") vals.push(raw);
    if (!vals.length) return null;
    return Math.min.apply(null, vals);
  }

  function heatOf(card, heat) {
    if (!heat || !card || !card.id) return 0;
    const n = Number(heat[card.id]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function saveHeat(events) {
    const heat = {};
    (Array.isArray(events) ? events : []).forEach(event => {
      if (!event || event.k !== "save" || typeof event.id !== "string" || !event.id) return;
      heat[event.id] = (heat[event.id] || 0) + 1;
    });
    return heat;
  }

  function toppsKind(card) {
    const blob = [card && card.setId, card && card.set, card && card.name, card && card.series, card && card.id].join(" ").toLowerCase();
    if (blob.indexOf("tekno") !== -1) return "tekno";
    if (blob.indexOf("topps") !== -1) return "topps";
    return "";
  }

  function isEcardHolo(card) {
    const setId = setIdOf(card);
    if (setId !== "ecard1" && setId !== "ecard2" && setId !== "ecard3") return false;
    const rarity = String(card && card.rarity || "");
    const num = numberOf(card);
    if (/holo/i.test(rarity)) return true;
    if (/^h\d+$/i.test(num)) return true;
    return card && card.holo === true;
  }

  function isMid(card) {
    const setId = setIdOf(card);
    if (!/^(?:ex|pop|dp|pl|hgss|col|bw|xy|sm)/.test(setId)) return false;
    const rarity = String(card && card.rarity || "");
    if (MID_RARITY[rarity]) return true;
    return rarity === "Ultra Rare" && OLD_ULTRA.test(setId);
  }

  function eraKey(setId) {
    const id = String(setId || "");
    for (let i = 0; i < ERA_ORDER.length - 1; i++) {
      if (id.indexOf(ERA_ORDER[i]) === 0) return ERA_ORDER[i];
    }
    return "other";
  }

  function hintFor(card) {
    const kind = toppsKind(card);
    if (kind === "tekno") return "Tekno Chrome";
    if (kind === "topps") return "Topps Chrome";
    const setId = setIdOf(card);
    if (setId === "ecard3") return "Skyridge holo";
    if (setId === "ecard2") return "Aquapolis holo";
    if (setId === "ecard1") return "Expedition holo";
    const rarity = String(card && card.rarity || "");
    const era = {
      ex: "EX", pop: "EX", dp: "DP", pl: "DP", hgss: "HGSS", col: "Call of Legends",
      bw: "BW", xy: "XY", sm: "SM"
    }[eraKey(setId)] || "Mid-era";
    if (rarity === "Rare Holo LV.X") return era + " LV.X";
    if (rarity === "Rare PRIME") return era + " Prime";
    if (rarity === "LEGEND") return era + " LEGEND";
    if (rarity === "Ultra Rare") return era + " ultra";
    if (rarity === "Rare Holo EX") return era + " EX";
    return era + " holo";
  }

  function whyFor(card) {
    return hintFor(card) + ". A hand-picked rarity that flies under the radar, priced like a buy. Not a grade population.";
  }

  function blank(reason) {
    return { gem: false, hint: "", why: "", usd: null, reason: reason || "" };
  }

  function judgeGem(card, ctx) {
    const context = ctx || {};
    if (!card || typeof card !== "object") return blank("missing");
    if (card.digital === true) return blank("digital");
    const setId = setIdOf(card);
    if (!setId) return blank("set");
    if (setId.indexOf(".") !== -1) return blank("no-scan");
    if (openingHas(setId, context.opening)) return blank("opening");
    if (card.tier === "A") return blank("chase-tier");
    const rarity = String(card.rarity || "");
    if (CHASE[rarity]) return blank("chase-rarity");
    const usd = gemUsd(card, context.fx);
    if (usd == null) return blank("price");
    if (usd < GEM_MIN || usd > GEM_MAX) return blank("band");
    if (heatOf(card, context.heat) >= GEM_HEAT) return blank("saved-often");
    const kind = toppsKind(card);
    const ecard = isEcardHolo(card);
    const mid = isMid(card);
    if (!kind && !ecard && !mid) return blank("printing");
    return {
      gem: true,
      hint: hintFor(card),
      why: whyFor(card),
      usd: usd,
      reason: kind || (ecard ? "ecard-holo" : "mid-era")
    };
  }

  function serieOf(setId) {
    const match = /^[a-z]+/.exec(String(setId || ""));
    return match ? match[0] : String(setId || "");
  }

  function gemArt(setId, num) {
    const number = String(num || "");
    if ((setId === "ecard2" || setId === "ecard3") && /^h\d+$/i.test(number)) {
      const n = String(parseInt(number.replace(/\D/g, ""), 10));
      const png = "https://images.pokemontcg.io/" + setId + "/H" + n + ".png";
      return { img: png, thumb: png, image: "" };
    }
    const base = "https://assets.tcgdex.net/en/" + serieOf(setId) + "/" + setId + "/" + number;
    const pngNum = /^h\d+$/i.test(number) ? "H" + String(parseInt(number.replace(/\D/g, ""), 10)) : number;
    return {
      img: base + "/high.webp",
      thumb: base + "/low.webp",
      image: base,
      backup: "https://images.pokemontcg.io/" + setId + "/" + pngNum + ".png"
    };
  }

  function asCard(row, names) {
    const setId = row.setId;
    const art = gemArt(setId, row.number);
    const setName = (names && names[setId]) || SET_NAMES[setId] || row.set || "";
    return {
      id: row.id,
      name: row.name,
      set: setName,
      setId: setId,
      number: row.number,
      rarity: row.rarity,
      types: Array.isArray(row.types) ? row.types.slice() : [],
      price: row.usd,
      variants: [{ key: "market", label: "Holofoil", market: row.usd }],
      img: art.img,
      thumb: art.thumb,
      image: art.image,
      backup: art.backup || "",
      holo: true,
      gemReady: true,
      gemHint: row.hint,
      gemWhy: row.why,
      source: row.source || "seed"
    };
  }

  function consider(list, seen, row, ctx, names) {
    if (!row || !row.id || seen[row.id]) return;
    const verdict = judgeGem(row, ctx);
    if (!verdict.gem) return;
    seen[row.id] = 1;
    list.push(asCard({
      id: row.id,
      name: row.name || row.id,
      set: row.set || "",
      setId: setIdOf(row),
      number: numberOf(row),
      rarity: row.rarity || "",
      types: row.types,
      usd: verdict.usd,
      hint: verdict.hint,
      why: verdict.why,
      source: row.source || ""
    }, names));
  }

  function parseSeed(text, ctx, names, into, seen) {
    String(text || "").split(/\n/).forEach(line => {
      const raw = line.trim();
      if (!raw || raw.charAt(0) === "#") return;
      const match = LINE.exec(raw);
      if (!match) return;
      const tier = match[1];
      const id = match[2];
      const cut = id.lastIndexOf("-");
      if (cut <= 0) return;
      consider(into, seen, {
        id: id,
        name: match[3],
        rarity: match[4],
        price: Number(match[5]),
        quoteCurrency: match[6] === "EUR" ? "EUR" : "",
        quoteAmount: match[6] === "EUR" ? Number(match[5]) : null,
        tier: tier,
        setId: id.slice(0, cut),
        number: id.slice(cut + 1),
        source: "seed"
      }, ctx, names);
    });
  }

  function buildCatalog(opts) {
    const options = opts || {};
    const names = Object.assign({}, SET_NAMES, options.names || {});
    const ctx = {
      fx: options.fx,
      heat: options.heat || null,
      opening: options.opening
    };
    const list = [];
    const seen = {};
    parseSeed(options.seedText || "", ctx, names, list, seen);
    const dailyPool = Array.isArray(options.dailyPool) ? options.dailyPool : [];
    dailyPool.forEach(card => {
      if (!card || !card.id) return;
      if (card.setId && card.set) names[card.setId] = card.set;
      consider(list, seen, {
        id: card.id,
        name: card.name,
        set: card.set,
        setId: card.setId,
        number: card.num || card.number,
        rarity: card.rarity,
        types: card.types,
        price: card.price,
        source: "daily"
      }, ctx, names);
    });
    list.forEach(card => {
      if (!card.set) card.set = names[card.setId] || SET_NAMES[card.setId] || "";
    });
    applyLocalTypes(list, dailyPool);
    return list;
  }

  function shuffle(list, rng) {
    const random = typeof rng === "function" ? rng : Math.random;
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  /* Oldest overlooked era first, then the next, so a fresh pocket opens
     on e-Card holos before later holos. */
  function dealGems(cards, rng) {
    const groups = {};
    ERA_ORDER.forEach(key => { groups[key] = []; });
    (Array.isArray(cards) ? cards : []).forEach(card => {
      if (!card || !card.id) return;
      const key = eraKey(setIdOf(card));
      (groups[key] || groups.other).push(card);
    });
    ERA_ORDER.forEach(key => { groups[key] = shuffle(groups[key], rng); });
    const out = [];
    let left = true;
    while (left) {
      left = false;
      ERA_ORDER.forEach(key => {
        const bag = groups[key];
        if (bag.length) {
          out.push(bag.pop());
          left = true;
        }
      });
    }
    return out;
  }

  function cleanTypes(types) {
    if (!Array.isArray(types)) return [];
    const out = [];
    types.forEach(type => {
      if (typeof type !== "string") return;
      const text = type.trim();
      if (text && out.indexOf(text) === -1) out.push(text);
    });
    return out;
  }

  /* Unknown types match. A stored list has to include the selected type. */
  function typeMatches(card, type) {
    const wanted = typeof type === "string" ? type.trim() : "";
    if (!wanted) return true;
    const types = cleanTypes(card && card.types);
    if (!types.length) return true;
    return types.indexOf(wanted) !== -1;
  }

  /* Seed lines carry no types. The daily pool does. An exact id wins.
     A name is used only when every saved card with that name agrees.
     Anything left blank stays unknown. */
  function applyLocalTypes(list, dailyPool) {
    const byId = {};
    const byName = {};
    (Array.isArray(dailyPool) ? dailyPool : []).forEach(card => {
      if (!card) return;
      const types = cleanTypes(card.types);
      if (!types.length) return;
      if (card.id && !byId[card.id]) byId[card.id] = types;
      const name = String(card.name || "").trim().toLowerCase();
      if (!name) return;
      const key = types.slice().sort().join("|");
      const prev = byName[name];
      if (!prev) byName[name] = { key: key, types: types };
      else if (prev.key !== key) byName[name] = { key: "", types: null };
    });
    (Array.isArray(list) ? list : []).forEach(card => {
      if (!card || cleanTypes(card.types).length) return;
      const fromId = card.id && byId[card.id];
      if (fromId) {
        card.types = fromId.slice();
        return;
      }
      const name = String(card.name || "").trim().toLowerCase();
      const fromName = name && byName[name];
      if (fromName && fromName.types) card.types = fromName.types.slice();
    });
  }

  /* Walk `cycle.cards`. `holding` is the ids already on the table, so a
     small pool is not stacked twice in one fill. wrapped is true when a
     card from the next lap is actually dealt. A pocket of 4 or fewer
     follows the same rule: the cursor stays at the end when this fill
     cannot deal another lap, and the next call that deals one sets
     wrapped. An empty catalog is dry. A catalog that is merely all on
     the table is not. */
  function takeGemCycle(cycle, count, holding) {
    const hold = holding instanceof Set ? holding : new Set(holding || []);
    const out = [];
    const lap = cycle && Number.isFinite(cycle.lap) ? cycle.lap : 0;
    if (!cycle || !Array.isArray(cycle.cards) || !cycle.cards.length || !(count > 0)) {
      return { cards: out, wrapped: false, dry: !cycle || !Array.isArray(cycle.cards) || !cycle.cards.length, lap: lap };
    }
    if (!Number.isFinite(cycle.cursor) || cycle.cursor < 0) cycle.cursor = 0;
    if (!Number.isFinite(cycle.lap) || cycle.lap < 0) cycle.lap = 0;
    let wrapped = false;
    let pendingWrap = false;
    let guard = 0;
    const max = cycle.cards.length * 2 + count + 2;
    while (out.length < count && guard < max) {
      guard++;
      if (cycle.cursor >= cycle.cards.length) {
        const free = cycle.cards.some(card => card && card.id && !hold.has(card.id) && !out.some(item => item.id === card.id));
        if (!free) break;
        cycle.cursor = 0;
        cycle.lap += 1;
        pendingWrap = true;
      }
      const card = cycle.cards[cycle.cursor++];
      if (!card || !card.id || hold.has(card.id) || out.some(item => item.id === card.id)) continue;
      if (pendingWrap) wrapped = true;
      out.push(card);
    }
    return { cards: out, wrapped: wrapped, dry: false, lap: cycle.lap };
  }

  return {
    GEM_MIN: GEM_MIN,
    GEM_MAX: GEM_MAX,
    GEM_HEAT: GEM_HEAT,
    EXPLAIN: EXPLAIN,
    WRAP_MESSAGE: WRAP_MESSAGE,
    SET_NAMES: SET_NAMES,
    setIdOf: setIdOf,
    numberOf: numberOf,
    gemUsd: gemUsd,
    saveHeat: saveHeat,
    judgeGem: judgeGem,
    gemArt: gemArt,
    hintFor: hintFor,
    typeMatches: typeMatches,
    buildCatalog: buildCatalog,
    dealGems: dealGems,
    takeGemCycle: takeGemCycle,
    eraKey: eraKey
  };
});
