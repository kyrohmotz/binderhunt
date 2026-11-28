/* Price watch for cards already saved in this browser.
   Loaded as a classic script (window.BinderPriceWatch) and as CommonJS.
   Prices come from data/price-history.json, unpacked by BinderPriceHistory.
   This module does not fetch Scrydex.

   A card saved after this ships keeps its price in bh.pricewatch.v1.
   A card saved before that uses the history point nearest the save day.
   With no save day, the change is the 7-day move from BinderPriceHistory. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderPriceWatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEY = "bh.pricewatch.v1";
  const MIN_PCT = 3;
  const MAX_PRICE = 1000000;

  function cents(value) {
    const n = typeof value === "number" ? value : (value == null || value === "" ? NaN : Number(value));
    if (!Number.isFinite(n) || n < 0.01 || n > MAX_PRICE) return null;
    const rounded = Math.round(n * 100) / 100;
    if (!Number.isFinite(rounded) || rounded < 0.01 || rounded > MAX_PRICE) return null;
    return rounded;
  }

  function finiteTime(value) {
    const n = typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n) || n < 86400000 || n > 4102444800000) return 0;
    return n;
  }

  function cleanId(id) {
    const s = typeof id === "string" ? id.trim() : "";
    if (!s || s.length > 80 || !/^[a-z0-9._-]+$/i.test(s)) return "";
    return s;
  }

  function formatUsd(amount) {
    const n = cents(amount);
    if (n == null) return "";
    const text = "$" + n.toFixed(2);
    if (text === "$0.00" || /NaN|Infinity|undefined/i.test(text)) return "";
    return text;
  }

  function formatPct(shown) {
    if (typeof shown !== "number" || !Number.isFinite(shown) || shown < MIN_PCT) return "";
    const rounded = Math.round(shown * 10) / 10;
    if (!Number.isFinite(rounded) || rounded < MIN_PCT) return "";
    const whole = Math.abs(rounded - Math.round(rounded)) < 0.001;
    return (whole ? String(Math.round(rounded)) : rounded.toFixed(1)) + "%";
  }

  function quote(baseline, latest, basis) {
    const base = cents(baseline);
    const now = cents(latest);
    if (base == null || now == null) return null;
    const delta = Math.round((now - base) * 100) / 100;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return null;
    const pct = (now - base) / base * 100;
    if (!Number.isFinite(pct)) return null;
    const shown = Math.round(Math.abs(pct) * 10) / 10;
    if (!Number.isFinite(shown) || shown < MIN_PCT) return null;
    const dollars = Math.abs(delta);
    const money = formatUsd(dollars);
    const pctText = formatPct(shown);
    if (!money || !pctText) return null;
    const dir = delta < 0 ? "down" : "up";
    return { dir, basis: basis || "", delta, dollars, pct: shown, money, pctText, baseline: base, latest: now };
  }

  function goodPoint(point) {
    return !!(point && point.t > 0 && cents(point.value) != null);
  }

  function series(points) {
    return (Array.isArray(points) ? points : []).filter(goodPoint).slice().sort((a, b) => a.t - b.t);
  }

  function nearest(points, t) {
    const rows = series(points);
    if (!rows.length || !(t > 0)) return null;
    let best = null;
    let bestDist = Infinity;
    rows.forEach(point => {
      const dist = Math.abs(point.t - t);
      if (dist < bestDist || (dist === bestDist && best && point.t < best.t)) {
        best = point;
        bestDist = dist;
      }
    });
    return best;
  }

  function move(opts) {
    const options = opts || {};
    const points = series(options.points);
    if (!points.length) return null;
    const latest = cents(points[points.length - 1].value);
    if (latest == null) return null;
    const savedPrice = cents(options.savedPrice);
    const savedAt = finiteTime(options.savedAt);
    if (savedPrice != null) return quote(savedPrice, latest, "saved");
    if (savedAt) {
      const near = nearest(points, savedAt);
      if (!near) return null;
      return quote(near.value, latest, "nearest");
    }
    if (typeof options.windowMove !== "function") return null;
    let win = null;
    try { win = options.windowMove(points, 7); }
    catch (e) { return null; }
    if (!win || win.dir === "flat") return null;
    return quote(win.baseline, win.latest, "7d");
  }

  function compareDrops(a, b) {
    const am = a && a.move;
    const bm = b && b.move;
    const ap = am && am.dir === "down" ? am.pct : -1;
    const bp = bm && bm.dir === "down" ? bm.pct : -1;
    if (bp !== ap) return bp - ap;
    const ad = am && am.dir === "down" ? am.dollars : 0;
    const bd = bm && bm.dir === "down" ? bm.dollars : 0;
    return bd - ad;
  }

  function ordered(rows) {
    const drops = [];
    const rises = [];
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!row || !row.move) return;
      if (row.move.dir === "down") drops.push(row);
      else if (row.move.dir === "up") rises.push(row);
    });
    drops.sort(compareDrops);
    rises.sort((a, b) => b.move.pct - a.move.pct || b.move.dollars - a.move.dollars);
    return drops.concat(rises);
  }

  function dropping(rows) {
    return ordered(rows).filter(row => row.move && row.move.dir === "down");
  }

  function countLabel(n) {
    const count = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 0;
    if (count < 1) return "";
    return count === 1 ? "1 price drop" : count + " price drops";
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function whenPhrase(row) {
    // A 7-day move is only the fallback when the save day is unknown.
    // Calling that "since you saved it" would describe a different price.
    if (row && row.basis === "7d") return "over the last 7 days";
    return "since you saved it";
  }

  function spoken(row) {
    if (!row || (row.dir !== "down" && row.dir !== "up") || !row.money || !row.pctText) return "";
    const word = row.dir === "down" ? "Down" : "Up";
    const pct = row.pctText.replace("%", "");
    const text = word + " " + row.money + ", " + pct + " percent, " + whenPhrase(row);
    if (/NaN|undefined/.test(text) || /\$0\.00\b|\$0(?!\.?\d)/.test(text)) return "";
    return text;
  }

  function badgeHtml(row) {
    const quiet = spoken(row);
    if (!quiet) return "";
    const sign = row.dir === "down" ? "−" : "+";
    const arrow = row.dir === "down" ? "▼" : "▲";
    const face = arrow + " " + row.money + " (" + sign + row.pctText + ")";
    if (/NaN|undefined/.test(face) || /\$0\.00\b|\$0(?!\.?\d)/.test(face)) return "";
    return `<span class="watch-badge ${row.dir}"><span>${esc(face)}</span><span class="sr-only">${esc(quiet)}</span></span>`;
  }

  function read(storage) {
    const out = {};
    if (!storage || typeof storage.getItem !== "function") return out;
    let raw = null;
    try { raw = JSON.parse(storage.getItem(KEY) || "null"); }
    catch (e) { return out; }
    const cards = raw && raw.cards && typeof raw.cards === "object" && !Array.isArray(raw.cards) ? raw.cards : null;
    if (!cards) return out;
    Object.keys(cards).forEach(key => {
      const id = cleanId(key);
      const rec = cards[key];
      if (!id || !rec || typeof rec !== "object" || Array.isArray(rec)) return;
      const at = finiteTime(rec.at);
      if (!at) return;
      const row = { at };
      const price = cents(rec.price);
      if (price != null) row.price = price;
      out[id] = row;
    });
    return out;
  }

  function write(storage, cards) {
    if (!storage || typeof storage.setItem !== "function") return false;
    try {
      storage.setItem(KEY, JSON.stringify({ v: 1, cards }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function remember(storage, id, rec) {
    const clean = cleanId(id);
    if (!clean) return false;
    const cards = read(storage);
    const row = { at: finiteTime(rec && rec.at) || Date.now() };
    const price = cents(rec && rec.price);
    if (price != null) row.price = price;
    cards[clean] = row;
    const ids = Object.keys(cards);
    if (ids.length > 500) {
      ids.sort((a, b) => cards[a].at - cards[b].at).slice(0, ids.length - 500).forEach(old => { delete cards[old]; });
    }
    return write(storage, cards);
  }

  function forget(storage, id) {
    const clean = cleanId(id);
    if (!clean || !storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return false;
    let raw = null;
    try { raw = JSON.parse(storage.getItem(KEY) || "null"); }
    catch (e) { return false; }
    if (!raw || !raw.cards || typeof raw.cards !== "object" || Array.isArray(raw.cards)) return true;
    if (!Object.prototype.hasOwnProperty.call(raw.cards, clean)) return true;
    delete raw.cards[clean];
    try {
      storage.setItem(KEY, JSON.stringify({ v: 1, cards: raw.cards }));
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    KEY,
    MIN_PCT,
    cents,
    quote,
    nearest,
    move,
    compareDrops,
    ordered,
    dropping,
    countLabel,
    spoken,
    badgeHtml,
    read,
    remember,
    forget
  };
});
