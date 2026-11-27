/* Import a collection from a CSV export.
   Loaded as a classic script (window.BinderImport) and as CommonJS.
   Parsing and matching stay in the browser. This file does not fetch
   anything and does not write storage until commit() is called.
   Owned cards use bh.owned.v1. Wishlist cards use binderhuntWish.
   The last import is remembered at bh.import.undo.v1 so it can be undone.
   Keys the import does not change are left untouched, including when
   they are missing. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const OWNED_KEY = "bh.owned.v1";
  const WISH_KEY = "binderhuntWish";
  const UNDO_KEY = "bh.import.undo.v1";
  const MAX_ROWS = 5000;

  const FIELD_ALIASES = [
    ["setCode", ["set code", "setcode", "set id", "set abbreviation"]],
    ["number", ["card number", "collector number", "collector no", "card no", "number", "num", "collector"]],
    ["quantity", ["total quantity", "quantity", "qty", "copies", "owned quantity"]],
    ["condition", ["card condition", "condition", "cond"]],
    ["set", ["set name", "setname", "expansion", "series", "set"]],
    ["name", ["product name", "card name", "simple name", "name", "title", "card"]]
  ];

  const TRAILING_SET = ["reverse holofoil", "reverse holo", "1st edition", "first edition", "unlimited", "shadowless", "holofoil", "holo"];
  const STOP_SET = { set: 1, card: 1, cards: 1, pokemon: 1, tcg: 1, the: 1, promo: 1, collection: 1, series: 1, expansion: 1 };
  const VARIANT_PARENS = /^(?:holo|holofoil|reverse holo|reverse holofoil|normal|unlimited|1st edition|first edition|shadowless|staff|prize pack)$/i;

  /* TCGplayer set codes that are not the TCGdex set id. Names still win when
     the set column resolves on its own. */
  const SET_CODE = {
    bs: "base1", ju: "base2", fo: "base3", b2: "base4", tr: "base5",
    n1: "neo1", n2: "neo2", n3: "neo3", n4: "neo4",
    lc: "lc", aq: "ecard2", sk: "ecard3",
    rs: "ex1", ss: "ex2", dr: "ex3", ma: "ex4", hl: "ex5", rg: "ex6",
    dx: "ex8", em: "ex9", uf: "ex10", ds: "ex11", lm: "ex12", trr: "ex7",
    hp: "ex13", cg: "ex14", df: "ex15", pk: "ex16",
    dp: "dp1", mt: "dp2", sw: "dp3", ge: "dp4", md: "dp5", la: "dp6", sf: "dp7",
    pl: "pl1",
    hs: "hgss1", ul: "hgss2", ud: "hgss3", tm: "hgss4", cl: "col1",
    blw: "bw1", epo: "bw2", nvi: "bw3", nxd: "bw4", dex: "bw5", drx: "bw6",
    bcr: "bw7", pls: "bw8", plf: "bw9", plb: "bw10", ltr: "bw11",
    xy: "xy1", flf: "xy2", ffi: "xy3", phf: "xy4", prc: "xy5", ros: "xy6",
    aor: "xy7", bkt: "xy8", bkp: "xy9", gen: "g1", fco: "xy10", sts: "xy11", evo: "xy12",
    sum: "sm1", gri: "sm2", bus: "sm3", cin: "sm4", upr: "sm5", fli: "sm6",
    ces: "sm7", lot: "sm8", teu: "sm9", unb: "sm10", unm: "sm11", hif: "sm115", cec: "sm12",
    ssh: "swsh1", rcl: "swsh2", daa: "swsh3", cpa: "swsh3.5", viv: "swsh4", shf: "swsh4.5",
    bst: "swsh5", cre: "swsh6", evs: "swsh7", fst: "swsh8", brs: "swsh9", asr: "swsh10",
    pgo: "swsh10.5", lor: "swsh11", sit: "swsh12", crz: "swsh12.5",
    svi: "sv01", pal: "sv02", obf: "sv03", mew: "sv03.5", par: "sv04", paf: "sv04.5",
    tef: "sv05", twm: "sv06", sfa: "sv06.5", scr: "sv07", ssp: "sv08", pre: "sv08.5",
    jtg: "sv09", dri: "sv10", wht: "sv10.5w", blk: "sv10.5b",
    meg: "me01", pfl: "me02"
  };

  const SET_ALIAS = {
    base: "base set",
    expedition: "expedition base set",
    hgss: "heartgold soulsilver",
    "sv base": "scarlet and violet",
    "scarlet and violet base": "scarlet and violet",
    "scarlet and violet base set": "scarlet and violet",
    "pokemon card 151": "151",
    "scarlet and violet 151": "151",
    "sv 151": "151",
    "pokemon 151": "151"
  };

  function norm(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function fold(value) {
    return norm(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function normSet(value) {
    let s = fold(value).replace(/&/g, " and ");
    s = s.replace(/\([^)]*\)/g, " ");
    s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/^(?:pokemon|pokémon)\s+/, "");
    return s;
  }

  function andStrip(value) {
    return String(value || "").replace(/\band\b/g, " ").replace(/\s+/g, " ").trim();
  }

  function stripTrailing(value) {
    let cur = String(value || "");
    let guard = 0;
    while (cur && guard++ < 4) {
      let next = cur;
      for (let i = 0; i < TRAILING_SET.length; i++) {
        const word = TRAILING_SET[i];
        if (next.endsWith(" " + word)) next = next.slice(0, -(word.length + 1)).trim();
      }
      if (next === cur) break;
      cur = next;
    }
    return cur;
  }

  function normName(value) {
    let s = fold(value);
    s = s.replace(/♀/g, " f ").replace(/♂/g, " m ");
    s = s.replace(/\(([^)]*)\)/g, (all, inner) => (VARIANT_PARENS.test(norm(inner)) ? " " : all));
    s = s.replace(/[-–—]\s*(?:reverse holofoil|reverse holo|holofoil|holo|unlimited|1st edition|first edition)\s*$/g, " ");
    s = s.replace(/#?\s*\d+\s*\/\s*\d+\s*$/g, " ");
    s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    return s;
  }

  function numberKeys(value) {
    const raw = fold(value).replace(/^#/, "").replace(/^no\.?\s+/, "");
    if (!raw) return [];
    const keys = [];
    const push = key => { if (key && keys.indexOf(key) < 0) keys.push(key); };
    const compact = raw.replace(/\s+/g, "");
    push(compact);
    const left = compact.split("/")[0];
    push(left);
    const alnum = left.replace(/[^a-z0-9]/g, "");
    push(alnum);
    if (/^\d+$/.test(alnum)) push(String(parseInt(alnum, 10)));
    else {
      const match = alnum.match(/^([a-z]+)0*(\d+)$/);
      if (match) push(match[1] + String(parseInt(match[2], 10)));
    }
    return keys;
  }

  function fieldFor(header) {
    const raw = norm(String(header || "").replace(/^\uFEFF/, ""));
    const rawKey = raw.toLowerCase();
    if (rawKey === "#" || rawKey === "no." || rawKey === "no" || rawKey === "card #" || rawKey === "collector #") return "number";
    const key = rawKey.replace(/[_/]+/g, " ").replace(/#/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    if (!key) return "";
    if (key === "no") return "number";
    for (let i = 0; i < FIELD_ALIASES.length; i++) {
      if (FIELD_ALIASES[i][1].indexOf(key) >= 0) return FIELD_ALIASES[i][0];
    }
    return "";
  }

  function parseQty(value) {
    const text = norm(value);
    if (!text) return 1;
    const match = text.match(/-?\d+/);
    if (!match) return 1;
    const n = parseInt(match[0], 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  }

  function parseCsv(text) {
    let src = String(text == null ? "" : text);
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    const table = [];
    const lineOf = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let line = 1;
    let rowLine = 1;
    function pushRow() {
      row.push(field);
      field = "";
      const blank = row.every(cell => norm(cell) === "");
      const comment = !blank && /^\s*#/.test(String(row[0] || "")) && table.length === 0;
      if (!blank && !comment) {
        table.push(row);
        lineOf.push(rowLine);
      }
      row = [];
      line += 1;
      rowLine = line;
    }
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else if (c === "\r") {
          field += "\n";
          if (src[i + 1] === "\n") i++;
          line += 1;
        } else {
          if (c === "\n") line += 1;
          field += c;
        }
        continue;
      }
      if (c === '"') { inQuotes = true; continue; }
      if (c === ",") { row.push(field); field = ""; continue; }
      if (c === "\n") { pushRow(); continue; }
      if (c === "\r") {
        if (src[i + 1] === "\n") continue;
        pushRow();
        continue;
      }
      field += c;
    }
    if (field.length || row.length) {
      row.push(field);
      const blank = row.every(cell => norm(cell) === "");
      const comment = !blank && /^\s*#/.test(String(row[0] || "")) && table.length === 0;
      if (!blank && !comment) {
        table.push(row);
        lineOf.push(rowLine);
      }
    }
    if (!table.length) return { ok: false, error: "That file has no header row." };
    const header = table[0];
    const columns = {};
    header.forEach((cell, index) => {
      const field = fieldFor(cell);
      if (field && columns[field] == null) columns[field] = index;
    });
    if (columns.name == null && columns.number == null) {
      return { ok: false, error: "No card name or number column. Use a header like name, set, and number." };
    }
    const rows = [];
    const limit = Math.min(table.length, MAX_ROWS + 1);
    for (let r = 1; r < limit; r++) {
      const cells = table[r];
      const take = field => {
        const index = columns[field];
        if (index == null || index >= cells.length) return "";
        return norm(cells[index]);
      };
      rows.push({
        line: lineOf[r],
        name: take("name"),
        set: take("set"),
        number: take("number"),
        quantity: parseQty(columns.quantity == null ? "" : (cells[columns.quantity] || "")),
        condition: take("condition"),
        setCode: take("setCode")
      });
    }
    return {
      ok: true,
      columns,
      rows,
      truncated: table.length - 1 > MAX_ROWS
    };
  }

  function artFor(setId, number, serie) {
    const blank = { thumb: "", img: "" };
    const set = String(setId || "");
    const local = String(number || "");
    if (!set || !local) return blank;
    if ((set === "ecard2" || set === "ecard3") && /^h\d+$/i.test(local)) {
      const n = String(parseInt(local.replace(/\D/g, ""), 10));
      if (!n || n === "NaN") return blank;
      const png = "https://images.pokemontcg.io/" + set + "/H" + n + ".png";
      return { thumb: png, img: png };
    }
    const series = norm(serie).toLowerCase() || ((/^[a-z]+/i.exec(set) || [""])[0].toLowerCase());
    if (!series) return blank;
    const base = "https://assets.tcgdex.net/en/" + series + "/" + set + "/" + local;
    return { thumb: base + "/low.webp", img: base + "/high.webp" };
  }

  function cardsFromPools(pools) {
    const sets = pools && pools.sets && typeof pools.sets === "object" ? pools.sets : null;
    if (!sets) return [];
    const out = [];
    Object.keys(sets).forEach(setId => {
      const set = sets[setId];
      if (!set || typeof set !== "object") return;
      const setName = norm(set.name) || setId;
      const serie = norm(set.serie);
      ["c", "u", "r", "h", "x", "a"].forEach(key => {
        const list = Array.isArray(set[key]) ? set[key] : [];
        list.forEach(raw => {
          const parts = String(raw || "").split("\t");
          const number = norm(parts[0]);
          const name = norm(parts[1]);
          if (!number || !name || number.length > 12) return;
          const id = setId + "-" + number;
          if (!id || id.length > 80) return;
          const art = artFor(setId, number, serie);
          out.push({ id, name, setId, setName, number, thumb: art.thumb, img: art.img });
        });
      });
    });
    return out;
  }

  function splitId(id) {
    const text = String(id || "");
    const cut = text.lastIndexOf("-");
    if (cut <= 0 || cut === text.length - 1) return null;
    return { setId: text.slice(0, cut), number: text.slice(cut + 1) };
  }

  function cardsFromCache(cards, setNames) {
    const names = setNames && typeof setNames === "object" ? setNames : {};
    const bag = cards && typeof cards === "object" ? cards : {};
    const out = [];
    Object.keys(bag).forEach(id => {
      const rec = bag[id];
      if (!rec || rec.missing || typeof rec.name !== "string") return;
      const name = norm(rec.name);
      const parts = splitId(id);
      if (!name || !parts || id.length > 80) return;
      const art = artFor(parts.setId, parts.number, "");
      out.push({
        id,
        name,
        setId: parts.setId,
        setName: norm(names[parts.setId] || ""),
        number: parts.number,
        thumb: art.thumb,
        img: art.img
      });
    });
    return out;
  }

  function mergeCards(lists) {
    const byId = new Map();
    (Array.isArray(lists) ? lists : []).forEach(list => {
      (list || []).forEach(card => {
        if (!card || !card.id) return;
        const prev = byId.get(card.id);
        if (!prev) {
          byId.set(card.id, {
            id: String(card.id),
            name: norm(card.name),
            setId: norm(card.setId),
            setName: norm(card.setName),
            number: norm(card.number),
            thumb: typeof card.thumb === "string" ? card.thumb : "",
            img: typeof card.img === "string" ? card.img : ""
          });
          return;
        }
        if (!prev.name && card.name) prev.name = norm(card.name);
        if (!prev.setName && card.setName) prev.setName = norm(card.setName);
        if (!prev.number && card.number) prev.number = norm(card.number);
        if (!prev.thumb && card.thumb) prev.thumb = card.thumb;
        if (!prev.img && card.img) prev.img = card.img;
      });
    });
    return [...byId.values()];
  }

  function emptyIndex() {
    return { sets: new Map(), byKey: new Map(), byNumber: new Map(), byName: new Map() };
  }

  function addKey(index, key, id) {
    if (!key) return;
    let list = index.byKey.get(key);
    if (!list) {
      list = [];
      index.byKey.set(key, list);
    }
    if (list.indexOf(id) < 0) list.push(id);
  }

  function addBucket(map, key, card) {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    if (!list.some(item => item.id === card.id)) list.push(card);
  }

  function indexCatalog(cards) {
    const index = emptyIndex();
    (Array.isArray(cards) ? cards : []).forEach(card => {
      if (!card || !card.id || !card.setId) return;
      let set = index.sets.get(card.setId);
      if (!set) {
        const name = norm(card.setName) || card.setId;
        const folded = normSet(name);
        set = { id: card.setId, name, norm: folded };
        index.sets.set(card.setId, set);
        addKey(index, folded, card.setId);
        const stripped = andStrip(folded);
        if (stripped && stripped !== folded) addKey(index, stripped, card.setId);
        addKey(index, String(card.setId).trim().toLowerCase(), card.setId);
      } else if ((!set.name || set.name === set.id) && card.setName) {
        set.name = norm(card.setName);
        set.norm = normSet(set.name);
        addKey(index, set.norm, card.setId);
        addKey(index, andStrip(set.norm), card.setId);
      }
      const stored = {
        id: card.id,
        name: norm(card.name),
        setId: card.setId,
        setName: set.name,
        number: norm(card.number),
        thumb: card.thumb || "",
        img: card.img || ""
      };
      numberKeys(stored.number).forEach(key => addBucket(index.byNumber, card.setId + "\0" + key, stored));
      const nameKey = normName(stored.name);
      if (nameKey) addBucket(index.byName, card.setId + "\0" + nameKey, stored);
    });
    return index;
  }

  function phraseHas(hay, needle) {
    if (!hay || !needle || hay === needle) return false;
    return (" " + hay + " ").indexOf(" " + needle + " ") >= 0;
  }

  function isLoose(query, name) {
    if (!query || !name || query === name) return false;
    if (query.length < 4 || STOP_SET[query]) return false;
    return phraseHas(name, query) || phraseHas(query, name);
  }

  function lookupName(index, raw) {
    const name = normSet(raw);
    if (!name || !index) return [];
    const tries = [];
    const push = key => { if (key && tries.indexOf(key) < 0) tries.push(key); };
    push(name);
    push(andStrip(name));
    const trimmed = stripTrailing(name);
    push(trimmed);
    push(andStrip(trimmed));
    push(SET_ALIAS[name]);
    push(SET_ALIAS[trimmed]);
    for (let i = 0; i < tries.length; i++) {
      const ids = index.byKey.get(tries[i]);
      if (ids && ids.length) return ids.slice();
    }
    if (name.length < 4 || STOP_SET[name]) return [];
    const loose = [];
    index.sets.forEach(set => {
      if (isLoose(name, set.norm) || isLoose(trimmed, set.norm) || isLoose(andStrip(name), set.norm)) loose.push(set.id);
    });
    return [...new Set(loose)];
  }

  function lookupCode(index, raw) {
    const code = String(raw || "").trim().toLowerCase();
    if (!code || !index) return [];
    const mapped = SET_CODE[code];
    if (mapped && index.sets.has(mapped)) return [mapped];
    if (index.sets.has(code)) return [code];
    return [];
  }

  function resolveSets(index, setName, setCode) {
    const byName = lookupName(index, setName);
    const byCode = lookupCode(index, setCode);
    if (byName.length === 1) return byName;
    if (byName.length > 1) {
      if (byCode.length === 1 && byName.indexOf(byCode[0]) >= 0) return byCode.slice();
      return byName;
    }
    return byCode;
  }

  function cardsForNumber(index, setId, number) {
    const keys = numberKeys(number);
    for (let i = 0; i < keys.length; i++) {
      const list = index.byNumber.get(setId + "\0" + keys[i]);
      if (list && list.length) return list.slice();
    }
    return [];
  }

  function cardsForName(index, setId, name) {
    const key = normName(name);
    if (!key) return [];
    const list = index.byName.get(setId + "\0" + key);
    return list ? list.slice() : [];
  }

  function uniqueCards(list) {
    const out = [];
    const seen = new Set();
    (list || []).forEach(card => {
      if (!card || !card.id || seen.has(card.id)) return;
      seen.add(card.id);
      out.push(card);
    });
    return out;
  }

  function setLabel(index, ids, fallback) {
    const names = (ids || []).map(id => {
      const set = index.sets.get(id);
      return set && set.name ? set.name : id;
    });
    if (!names.length) return fallback || "that set";
    if (names.length === 1) return names[0];
    return names.slice(0, 3).join(", ");
  }

  function quote(value) {
    const text = norm(value);
    return text ? "“" + text + "”" : "";
  }

  function matched(row, card, via) {
    return { status: "matched", via, row, card, choices: [], reason: "" };
  }

  function ambiguous(row, choices, reason) {
    return { status: "ambiguous", via: "", row, card: null, choices: uniqueCards(choices), reason };
  }

  function unmatched(row, reason) {
    return { status: "unmatched", via: "", row, card: null, choices: [], reason };
  }

  function matchRow(row, index) {
    if (!row.name && !row.number && !row.set && !row.setCode) {
      return unmatched(row, "This row is empty.");
    }
    if (row.quantity === 0) return { status: "skipped", via: "", row, card: null, choices: [], reason: "Quantity is 0." };
    if (!row.name && !row.number) return unmatched(row, "This row has no card name or number.");
    let sets = resolveSets(index, row.set, row.setCode);
    if (sets.length > 1 && row.number) {
      const narrowed = sets.filter(id => cardsForNumber(index, id, row.number).length);
      if (narrowed.length === 1) sets = narrowed;
      else if (narrowed.length > 1) {
        const cards = uniqueCards(narrowed.flatMap(id => cardsForNumber(index, id, row.number)));
        if (cards.length === 1) return matched(row, cards[0], "number");
        if (cards.length > 1) return ambiguous(row, cards, "That number is in more than one set matching " + (quote(row.set) || "that name") + ".");
      }
    }
    if (sets.length === 1 && row.number) {
      const cards = cardsForNumber(index, sets[0], row.number);
      if (cards.length === 1) return matched(row, cards[0], "number");
      if (cards.length > 1) return ambiguous(row, cards, "Several cards share that set and number.");
    }
    const nameSets = sets.length ? sets : [];
    if (row.name && nameSets.length) {
      const cards = uniqueCards(nameSets.flatMap(id => cardsForName(index, id, row.name)));
      if (cards.length === 1) return matched(row, cards[0], "name");
      if (cards.length > 1) {
        const reason = nameSets.length > 1
          ? "That name shows up in more than one matching set."
          : "That name is on more than one card in this set.";
        return ambiguous(row, cards, reason);
      }
    }
    if (!row.set && !row.setCode) return unmatched(row, "No set name, so this row cannot be matched.");
    if (!sets.length) return unmatched(row, "Set " + (quote(row.set) || quote(row.setCode) || "name") + " is not in the catalog.");
    const label = setLabel(index, sets, row.set);
    if (row.number && row.name) return unmatched(row, "No card #" + row.number + " named " + row.name + " in " + label + ".");
    if (row.number) return unmatched(row, "No card #" + row.number + " in " + label + ".");
    return unmatched(row, "No card named " + row.name + " in " + label + ".");
  }

  function matchRows(rows, index) {
    const list = Array.isArray(rows) ? rows : [];
    return { rows: list.map(row => matchRow(row || {}, index || emptyIndex())) };
  }

  function summarize(report) {
    const rows = report && Array.isArray(report.rows) ? report.rows : [];
    const count = status => rows.filter(row => row && row.status === status).length;
    return {
      matched: count("matched"),
      ambiguous: count("ambiguous"),
      unmatched: count("unmatched"),
      skipped: count("skipped")
    };
  }

  function asIdSet(value) {
    const ids = new Set();
    if (value instanceof Set) {
      value.forEach(id => { if (typeof id === "string" && id) ids.add(id); });
      return ids;
    }
    (Array.isArray(value) ? value : []).forEach(id => {
      if (typeof id === "string" && id) ids.add(id);
    });
    return ids;
  }

  function plan(report, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const destination = options.destination === "wish" ? "wish" : "owned";
    const have = destination === "owned" ? asIdSet(options.ownedIds) : asIdSet(options.wishIds);
    const picks = options.picks && typeof options.picks === "object" ? options.picks : {};
    const seen = new Set();
    const add = [];
    const duplicate = [];
    let unresolved = 0;
    const rows = report && Array.isArray(report.rows) ? report.rows : [];
    rows.forEach(item => {
      if (!item || item.status === "unmatched" || item.status === "skipped") return;
      let card = null;
      if (item.status === "matched") card = item.card;
      else if (item.status === "ambiguous") {
        const pick = picks[item.row && item.row.line];
        if (pick == null || pick === "") { unresolved += 1; return; }
        if (pick === "skip") return;
        card = (item.choices || []).find(choice => choice && choice.id === pick) || null;
        if (!card) { unresolved += 1; return; }
      }
      if (!card || !card.id) return;
      if (seen.has(card.id) || have.has(card.id)) {
        duplicate.push({ row: item.row, card, because: have.has(card.id) ? "saved" : "file" });
        seen.add(card.id);
        return;
      }
      seen.add(card.id);
      add.push(card);
    });
    return { destination, add, duplicate, unresolved };
  }

  function readJson(storage, key) {
    const raw = storage.getItem(key);
    if (raw == null) return { missing: true, value: null };
    try { return { missing: false, value: JSON.parse(raw) }; }
    catch (e) { return { missing: false, bad: true, value: null }; }
  }

  function wishSnap(card) {
    const snap = {
      id: card.id,
      name: card.name || "",
      set: card.setName || "",
      setId: card.setId || "",
      number: card.number || ""
    };
    if (card.img) snap.img = card.img;
    if (card.thumb) snap.thumb = card.thumb;
    return snap;
  }

  function blankResult(destination) {
    return { ok: true, destination, added: [], removed: [], wrote: { owned: false, wish: false, undo: false }, error: "" };
  }

  function commit(storage, planned) {
    const planState = planned && typeof planned === "object" ? planned : { destination: "owned", add: [] };
    const destination = planState.destination === "wish" ? "wish" : "owned";
    const cards = Array.isArray(planState.add) ? planState.add.filter(card => card && card.id) : [];
    const result = blankResult(destination);
    if (!storage || !cards.length) return result;
    const added = [];
    const addedSets = {};
    if (destination === "owned") {
      const loaded = readJson(storage, OWNED_KEY);
      if (loaded.bad) {
        result.ok = false;
        result.error = "The owned list could not be read, so nothing was saved.";
        return result;
      }
      let base;
      if (loaded.missing || loaded.value == null) base = { v: 1, ids: [], sets: {}, celebrated: [], seeded: true };
      else if (Array.isArray(loaded.value)) base = { v: 1, ids: loaded.value.slice(), sets: {}, celebrated: [], seeded: true };
      else if (typeof loaded.value === "object") base = loaded.value;
      else {
        result.ok = false;
        result.error = "The owned list could not be read, so nothing was saved.";
        return result;
      }
      if (!Array.isArray(base.ids)) base.ids = [];
      if (!base.sets || typeof base.sets !== "object" || Array.isArray(base.sets)) base.sets = {};
      const have = new Set(base.ids.filter(id => typeof id === "string" && id));
      cards.forEach(card => {
        if (have.has(card.id)) return;
        have.add(card.id);
        base.ids.push(card.id);
        if (card.setId && base.sets[card.id] == null) {
          base.sets[card.id] = card.setId;
          addedSets[card.id] = card.setId;
        }
        added.push(card);
      });
      if (!added.length) return result;
      if (base.v == null) base.v = 1;
      storage.setItem(OWNED_KEY, JSON.stringify(base));
      result.wrote.owned = true;
    } else {
      const loaded = readJson(storage, WISH_KEY);
      if (loaded.bad || (!loaded.missing && loaded.value != null && !Array.isArray(loaded.value))) {
        result.ok = false;
        result.error = "The wishlist could not be read, so nothing was saved.";
        return result;
      }
      const list = loaded.missing || loaded.value == null ? [] : loaded.value.slice();
      const have = new Set(list.filter(card => card && typeof card.id === "string").map(card => card.id));
      cards.forEach(card => {
        if (have.has(card.id)) return;
        have.add(card.id);
        list.push(wishSnap(card));
        added.push(card);
      });
      if (!added.length) return result;
      storage.setItem(WISH_KEY, JSON.stringify(list));
      result.wrote.wish = true;
    }
    const undo = { v: 1, dest: destination, ids: added.map(card => card.id), sets: addedSets };
    storage.setItem(UNDO_KEY, JSON.stringify(undo));
    result.wrote.undo = true;
    result.added = added.map(wishSnap);
    return result;
  }

  function readUndo(storage) {
    if (!storage) return null;
    const loaded = readJson(storage, UNDO_KEY);
    const raw = loaded.value;
    if (!raw || raw.v !== 1) return null;
    if (raw.dest !== "owned" && raw.dest !== "wish") return null;
    if (!Array.isArray(raw.ids) || !raw.ids.length) return null;
    const ids = raw.ids.filter(id => typeof id === "string" && id && id.length <= 80);
    if (!ids.length) return null;
    const sets = raw.sets && typeof raw.sets === "object" && !Array.isArray(raw.sets) ? raw.sets : {};
    return { v: 1, dest: raw.dest, ids, sets };
  }

  function undo(storage) {
    const record = readUndo(storage);
    const result = blankResult(record ? record.dest : "");
    if (!record) {
      result.ok = false;
      result.error = "Nothing to undo.";
      return result;
    }
    const drop = new Set(record.ids);
    if (record.dest === "owned") {
      const loaded = readJson(storage, OWNED_KEY);
      if (!loaded.bad && loaded.value && typeof loaded.value === "object" && !Array.isArray(loaded.value) && Array.isArray(loaded.value.ids)) {
        const base = loaded.value;
        const next = base.ids.filter(id => !(typeof id === "string" && drop.has(id)));
        const removed = base.ids.filter(id => typeof id === "string" && drop.has(id));
        if (removed.length) {
          base.ids = next;
          if (base.sets && typeof base.sets === "object") {
            removed.forEach(id => {
              if (record.sets && record.sets[id] != null && base.sets[id] === record.sets[id]) delete base.sets[id];
            });
          }
          storage.setItem(OWNED_KEY, JSON.stringify(base));
          result.wrote.owned = true;
          result.removed = removed;
        }
      }
    } else {
      const loaded = readJson(storage, WISH_KEY);
      if (!loaded.bad && Array.isArray(loaded.value)) {
        const removed = [];
        const next = loaded.value.filter(card => {
          if (card && typeof card.id === "string" && drop.has(card.id)) {
            removed.push(card.id);
            return false;
          }
          return true;
        });
        if (removed.length) {
          storage.setItem(WISH_KEY, JSON.stringify(next));
          result.wrote.wish = true;
          result.removed = removed;
        }
      }
    }
    storage.removeItem(UNDO_KEY);
    result.wrote.undo = true;
    result.ok = true;
    return result;
  }

  return {
    KEYS: { owned: OWNED_KEY, wish: WISH_KEY, undo: UNDO_KEY },
    MAX_ROWS,
    parseCsv,
    cardsFromPools,
    cardsFromCache,
    mergeCards,
    indexCatalog,
    matchRows,
    summarize,
    plan,
    commit,
    readUndo,
    undo,
    artFor,
    normSet,
    normName,
    numberKeys
  };
});
