/* Market movers from the cached Scrydex file only.
   Loaded as a classic script (window.BinderMovers) and as CommonJS.
   It does not fetch Scrydex or TCGdex.

   A 7-day move compares the latest cached price with the newest price on
   or before 7 days earlier. That baseline has to land 7 to 14 days before
   the latest day. A 30-day move uses 30 to 45 days. The window ends on
   each card's latest saved price, the same rule as collection value and
   the price-drop badge, not on today's calendar date. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderMovers = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEY = "bh.movers.v1";
  const DAY = 86400000;
  const MIN_PRICE = 1;
  const MIN_ABS = 1;
  const MIN_PCT = 1;
  const SPARK_CAP = 16;
  const DEFAULT_LIMIT = 12;

  let cache = null;

  function cents(value) {
    const n = typeof value === "number" ? value : (value == null || value === "" ? NaN : Number(value));
    if (!Number.isFinite(n) || n < 0.01) return null;
    const rounded = Math.round(n * 100) / 100;
    return rounded >= 0.01 ? rounded : null;
  }

  function dayTime(value) {
    const m = String(value || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!m) return 0;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
    const t = Date.UTC(y, mo - 1, d);
    const check = new Date(t);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return 0;
    return t;
  }

  function cleanId(id) {
    const s = typeof id === "string" ? id.trim() : "";
    return s && s.length <= 80 ? s : "";
  }

  function cleanName(name, id) {
    const s = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    if (!s || s === "undefined" || s === "NaN") return id || "Card";
    return s.slice(0, 80);
  }

  function uniqueIds(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach(item => {
      const id = cleanId(typeof item === "string" ? item : (item && item.id));
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
    return out;
  }

  function splitId(id) {
    const text = String(id || "");
    const cut = text.lastIndexOf("-");
    if (cut <= 0 || cut === text.length - 1) return { setId: "", number: "" };
    return { setId: text.slice(0, cut), number: text.slice(cut + 1) };
  }

  function artFor(id) {
    const blank = { image: "", thumb: "", img: "", backup: "", setId: "", number: "" };
    const parts = splitId(id);
    if (!parts.setId || !parts.number) return blank;
    if ((parts.setId === "ecard2" || parts.setId === "ecard3") && /^h\d+$/i.test(parts.number)) {
      const n = String(parseInt(parts.number.replace(/\D/g, ""), 10));
      if (!n || n === "NaN") return blank;
      const png = "https://images.pokemontcg.io/" + parts.setId + "/H" + n + ".png";
      return { image: "", thumb: png, img: png, backup: png, setId: parts.setId, number: parts.number };
    }
    const serie = (/^[a-z]+/i.exec(parts.setId) || [""])[0].toLowerCase();
    if (!serie) return Object.assign(blank, parts);
    const base = "https://assets.tcgdex.net/en/" + serie + "/" + parts.setId + "/" + parts.number;
    return {
      image: base,
      thumb: base + "/low.webp",
      img: base + "/high.webp",
      backup: "https://images.pokemontcg.io/" + parts.setId + "/" + parts.number + ".png",
      setId: parts.setId,
      number: parts.number
    };
  }

  function labelVariant(key) {
    return String(key || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  function seriesFor(rec) {
    if (!rec || rec.missing || !Array.isArray(rec.history)) return null;
    const byVariant = new Map();
    rec.history.forEach(row => {
      if (!row || typeof row !== "object") return;
      const price = cents(row.m);
      const t = dayTime(row.d);
      const variant = typeof row.v === "string" ? row.v : "";
      if (!price || !t || !variant) return;
      let list = byVariant.get(variant);
      if (!list) {
        list = [];
        byVariant.set(variant, list);
      }
      list.push({ t, value: price });
    });
    let best = null;
    byVariant.forEach((points, variant) => {
      points.sort((a, b) => a.t - b.t);
      const compact = [];
      points.forEach(point => {
        const prev = compact[compact.length - 1];
        if (prev && prev.t === point.t) compact[compact.length - 1] = point;
        else compact.push(point);
      });
      const latest = compact[compact.length - 1];
      if (!latest || !(latest.value > 0)) return;
      const better = !best
        || latest.value < best.latest.value
        || (latest.value === best.latest.value && compact.length > best.points.length)
        || (latest.value === best.latest.value && compact.length === best.points.length && variant < best.variant);
      if (better) best = { variant, points: compact, latest };
    });
    return best;
  }

  function windowMove(points, days, minLag, maxLag) {
    if (!points || points.length < 2) return null;
    const last = points[points.length - 1];
    if (!last || !(last.value >= MIN_PRICE) || !(last.t > 0)) return null;
    const target = last.t - days * DAY;
    let prev = null;
    let from = -1;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point && point.t <= target && point.value >= MIN_PRICE) {
        prev = point;
        from = i;
      }
    }
    if (!prev || from < 0 || !(prev.t > 0) || !(prev.value >= MIN_PRICE)) return null;
    const lag = (last.t - prev.t) / DAY;
    if (!(lag >= minLag && lag <= maxLag)) return null;
    const rawDelta = last.value - prev.value;
    const rawPct = rawDelta / prev.value * 100;
    if (!Number.isFinite(rawDelta) || !Number.isFinite(rawPct)) return null;
    if (Math.abs(rawPct) < MIN_PCT) return null;
    const money = cents(Math.abs(rawDelta));
    if (money == null || money < MIN_ABS) return null;
    const pct = Math.round(Math.abs(rawPct) * 10) / 10;
    if (!Number.isFinite(pct) || pct < MIN_PCT) return null;
    const dir = rawDelta > 0 ? "up" : "down";
    return {
      baseline: prev.value,
      latest: last.value,
      delta: dir === "up" ? money : -money,
      pct,
      dir,
      spanDays: Math.round(lag),
      from
    };
  }

  function sample(points) {
    if (!points || points.length < 2) return [];
    const cap = SPARK_CAP;
    if (points.length <= cap) return points.map(point => ({ t: point.t, value: point.value }));
    const out = [];
    const last = points.length - 1;
    for (let i = 0; i < cap; i++) {
      const index = Math.round(i * last / (cap - 1));
      const point = points[index];
      if (!point) continue;
      if (!out.length || out[out.length - 1].t !== point.t) out.push({ t: point.t, value: point.value });
    }
    const end = points[last];
    if (end && out.length && out[out.length - 1].t !== end.t) out.push({ t: end.t, value: end.value });
    return out;
  }

  function quoteCard(id, rec) {
    const cardId = cleanId(id);
    const series = seriesFor(rec);
    if (!cardId || !series) return null;
    const move7 = windowMove(series.points, 7, 7, 14);
    const move30 = windowMove(series.points, 30, 30, 45);
    if (!move7 && !move30) return null;
    const art = artFor(cardId);
    return {
      id: cardId,
      name: cleanName(rec && rec.name, cardId),
      variant: series.variant,
      latest: series.latest.value,
      setId: art.setId,
      number: art.number,
      move7,
      move30,
      points7: move7 ? sample(series.points.slice(move7.from)) : [],
      points30: move30 ? sample(series.points.slice(move30.from)) : []
    };
  }

  function indexCards(cards) {
    const source = cards && typeof cards === "object" ? cards : {};
    let count = 0;
    const ids = Object.keys(source);
    count = ids.length;
    if (cache && cache.source === source && cache.count === count) return cache;
    const rows = [];
    ids.forEach(id => {
      const quote = quoteCard(id, source[id]);
      if (quote) rows.push(quote);
    });
    cache = { source, count, rows };
    return cache;
  }

  function moneyText(n) {
    const amount = cents(typeof n === "number" ? Math.abs(n) : NaN);
    if (amount == null) return "";
    let text = "";
    try {
      text = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
    } catch (e) {
      text = "$" + amount.toFixed(2);
    }
    if (!text || /NaN|Infinity|undefined/i.test(text) || /^[^0-9]*0(?:\.00)?$/.test(text)) return "";
    return text;
  }

  function pctText(pct) {
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < MIN_PCT) return "";
    const rounded = Math.round(pct * 10) / 10;
    if (!Number.isFinite(rounded) || rounded < MIN_PCT) return "";
    const whole = Math.abs(rounded - Math.round(rounded)) < 0.001;
    return (whole ? String(Math.round(rounded)) : rounded.toFixed(1)) + "%";
  }

  function rowFrom(quote, move, points, wish, owned) {
    const dollars = moneyText(move.delta);
    const now = moneyText(move.latest);
    const pct = pctText(move.pct);
    if (!dollars || !now || !pct) return null;
    if (!(move.latest >= MIN_PRICE) || !(move.baseline >= MIN_PRICE)) return null;
    if (!(Math.abs(move.delta) >= MIN_ABS)) return null;
    return {
      id: quote.id,
      name: quote.name,
      variant: quote.variant,
      setId: quote.setId,
      number: quote.number,
      latest: move.latest,
      baseline: move.baseline,
      delta: move.delta,
      pct: move.pct,
      dir: move.dir,
      spanDays: move.spanDays,
      points,
      wish: wish.has(quote.id),
      owned: owned.has(quote.id)
    };
  }

  function list(cards, opts) {
    const days = opts && opts.days === 30 ? 30 : 7;
    const limit = opts && opts.limit > 0 ? Math.min(40, Math.floor(opts.limit)) : DEFAULT_LIMIT;
    const wish = new Set(uniqueIds(opts && opts.wishIds));
    const owned = new Set(uniqueIds(opts && opts.ownedIds));
    const built = indexCards(cards);
    const risers = [];
    const fallers = [];
    built.rows.forEach(quote => {
      const move = days === 30 ? quote.move30 : quote.move7;
      const points = days === 30 ? quote.points30 : quote.points7;
      if (!move) return;
      const row = rowFrom(quote, move, points, wish, owned);
      if (!row) return;
      if (row.dir === "up") risers.push(row);
      else if (row.dir === "down") fallers.push(row);
    });
    const byMove = (a, b) => b.pct - a.pct || Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    risers.sort(byMove);
    fallers.sort(byMove);
    return {
      days,
      minLag: days === 30 ? 30 : 7,
      maxLag: days === 30 ? 45 : 14,
      measuredFrom: "latest-cached-price",
      label: days === 30 ? "30 days" : "7 days",
      minPrice: MIN_PRICE,
      minAbs: MIN_ABS,
      minPct: MIN_PCT,
      considered: built.rows.length,
      risers: risers.slice(0, limit),
      fallers: fallers.slice(0, limit)
    };
  }

  function readDays(storage) {
    if (!storage || typeof storage.getItem !== "function") return 7;
    try {
      const raw = JSON.parse(storage.getItem(KEY) || "null");
      if (raw && raw.v === 1 && raw.days === 30) return 30;
    } catch (e) {}
    return 7;
  }

  function writeDays(storage, days) {
    if (!storage || typeof storage.setItem !== "function") return false;
    const next = days === 30 ? 30 : 7;
    try {
      storage.setItem(KEY, JSON.stringify({ v: 1, days: next }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function sparkSvg(points, dir, label) {
    if (!points || points.length < 2) return "";
    if (!points.every(point => point && typeof point.value === "number" && Number.isFinite(point.value) && point.value >= 0.01)) return "";
    const vals = points.map(point => point.value);
    let min = Math.min.apply(null, vals);
    let max = Math.max.apply(null, vals);
    if (!(max > 0) || !Number.isFinite(min) || !Number.isFinite(max)) return "";
    if (min === max) {
      min *= 0.98;
      max *= 1.02;
    }
    if (!(max > min)) return "";
    const w = 88;
    const h = 28;
    const padX = 2;
    const padY = 3;
    const xOf = i => padX + (points.length === 1 ? 0 : i * (w - padX * 2) / (points.length - 1));
    const yOf = v => padY + (1 - (v - min) / (max - min)) * (h - padY * 2);
    const line = points.map((point, i) => (i ? "L" : "M") + xOf(i).toFixed(1) + "," + yOf(point.value).toFixed(1)).join(" ");
    const stroke = dir === "down" ? "#8d4a4a" : "#3d4a28";
    const name = label && !/NaN|Infinity|undefined/i.test(label) ? label : "Cached price history";
    return `<svg class="mover-spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(name)}" focusable="false"><path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function deckCard(row, setName) {
    if (!row || !row.id || !(row.latest >= MIN_PRICE) || !row.variant) return null;
    const now = moneyText(row.latest);
    if (!now) return null;
    const art = artFor(row.id);
    if (!art.img && !art.thumb && !art.backup) return null;
    const named = typeof setName === "function" ? setName(art.setId) : "";
    return {
      id: row.id,
      name: row.name || row.id,
      set: typeof named === "string" ? named : "",
      setId: art.setId,
      number: art.number,
      img: art.img,
      thumb: art.thumb,
      image: art.image,
      backup: art.backup,
      price: row.latest,
      variants: [{ key: row.variant, label: labelVariant(row.variant), market: row.latest }],
      mover: true
    };
  }

  function deckCards(model, setName) {
    const rows = (model && model.risers || []).concat(model && model.fallers || []);
    const out = [];
    const seen = new Set();
    rows.forEach(row => {
      if (!row || seen.has(row.id)) return;
      const card = deckCard(row, setName);
      if (!card) return;
      seen.add(row.id);
      out.push(card);
    });
    return out;
  }

  return {
    KEY,
    MIN_PRICE,
    MIN_ABS,
    MIN_PCT,
    DEFAULT_LIMIT,
    cents,
    seriesFor,
    windowMove,
    quoteCard,
    list,
    readDays,
    writeDays,
    moneyText,
    pctText,
    artFor,
    sparkSvg,
    deckCard,
    deckCards
  };
});
