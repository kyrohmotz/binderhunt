/* Wishlist target prices and the Deals shelf.
   Loaded as a classic script (window.BinderTargets) and as CommonJS.
   Prices come from the caller, which reads the cached Scrydex file.
   This module does not fetch anything. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderTargets = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEY = "bh.targets.v1";
  const MEANINGFUL_PCT = 10;
  const MAX_PRICE = 999999.99;

  function cents(value) {
    const n = typeof value === "number" ? value : (value == null || value === "" ? NaN : Number(value));
    if (!Number.isFinite(n) || n < 0.01 || n > MAX_PRICE) return null;
    const rounded = Math.round(n * 100) / 100;
    if (!Number.isFinite(rounded) || rounded < 0.01 || rounded > MAX_PRICE) return null;
    return rounded;
  }

  function cleanId(id) {
    const s = typeof id === "string" ? id.trim() : "";
    if (!s || s.length > 80 || !/^[a-z0-9._-]+$/i.test(s)) return "";
    return s;
  }

  function cleanName(name) {
    const s = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    if (!s || s === "undefined" || s === "NaN") return "";
    return s.slice(0, 80);
  }

  function stamp(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e15) return null;
    return value;
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

  function moneyText(n) {
    const amount = cents(n);
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
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0.1) return "";
    const rounded = Math.round(pct * 10) / 10;
    if (!Number.isFinite(rounded) || rounded <= 0) return "";
    const whole = Math.abs(rounded - Math.round(rounded)) < 0.001;
    return (whole ? String(Math.round(rounded)) : rounded.toFixed(1)) + "%";
  }

  function suggest(market) {
    const base = cents(market);
    if (base == null) return null;
    let next = cents(Math.round(base * 90) / 100);
    if (next == null || next >= base) next = cents(Math.floor(base * 90) / 100);
    if (next == null || next >= base) return null;
    return next;
  }

  function parsePrice(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw || /nan|infinity|undefined|null/i.test(raw)) return null;
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    return cents(Number(cleaned));
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const price = cents(raw.price);
    const priceAtSet = cents(raw.priceAtSet);
    const setAt = stamp(raw.setAt);
    if (price == null || priceAtSet == null || setAt == null) return null;
    const rec = { price: price, setAt: setAt, priceAtSet: priceAtSet };
    const seen = cents(raw.seen);
    const seenAt = stamp(raw.seenAt);
    if (seen != null && seenAt != null) {
      rec.seen = seen;
      rec.seenAt = seenAt;
    }
    return rec;
  }

  function read(storage) {
    const out = {};
    if (!storage || typeof storage.getItem !== "function") return out;
    let raw = null;
    try { raw = JSON.parse(storage.getItem(KEY) || "null"); }
    catch (e) { return out; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(key => {
      const id = cleanId(key);
      const rec = normalizeRecord(raw[key]);
      if (id && rec) out[id] = rec;
    });
    return out;
  }

  function write(storage, map) {
    if (!storage || typeof storage.setItem !== "function") return false;
    const out = {};
    Object.keys(map || {}).forEach(key => {
      const id = cleanId(key);
      const rec = normalizeRecord(map[key]);
      if (id && rec) out[id] = rec;
    });
    try {
      if (!Object.keys(out).length) {
        if (typeof storage.removeItem === "function") storage.removeItem(KEY);
        return true;
      }
      storage.setItem(KEY, JSON.stringify(out));
      return true;
    } catch (e) {
      return false;
    }
  }

  function setTarget(storage, id, price, market, now) {
    const cardId = cleanId(id);
    const target = cents(price);
    const at = cents(market);
    const when = stamp(now) || stamp(Date.now());
    if (!cardId || target == null || at == null || when == null) return null;
    const all = read(storage);
    all[cardId] = { price: target, setAt: when, priceAtSet: at, seen: at, seenAt: when };
    if (!write(storage, all)) return null;
    return all[cardId];
  }

  function clearTarget(storage, id) {
    const cardId = cleanId(id);
    if (!cardId) return false;
    const all = read(storage);
    if (!all[cardId]) return true;
    delete all[cardId];
    return write(storage, all);
  }

  function quoteRecord(rec) {
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
      list.push({ t: t, value: price });
    });
    let best = null;
    byVariant.forEach((points, variant) => {
      points.sort((a, b) => a.t - b.t);
      const latest = points[points.length - 1];
      if (!latest || !(latest.value > 0)) return;
      const better = !best
        || latest.value < best.latest
        || (latest.value === best.latest && points.length > best.points)
        || (latest.value === best.latest && points.length === best.points && variant < best.variant);
      if (better) best = { variant: variant, latest: latest.value, points: points.length, t: latest.t };
    });
    if (!best) return null;
    return { latest: best.latest, variant: best.variant, t: best.t };
  }

  function dropBetween(from, to) {
    const start = cents(from);
    const end = cents(to);
    if (start == null || end == null || !(start > end)) return null;
    const dollars = cents(start - end);
    if (dollars == null) return null;
    const raw = (start - end) / start * 100;
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const pct = Math.round(raw * 10) / 10;
    if (!Number.isFinite(pct) || pct <= 0) return null;
    return { dollars: dollars, pct: pct, raw: raw };
  }

  function listDeals(rows) {
    const deals = [];
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!row) return;
      const id = cleanId(row.id);
      const market = cents(row.market);
      const target = normalizeRecord(row.target);
      if (!id || market == null || !target) return;
      const under = market <= target.price;
      const savedDrop = dropBetween(target.priceAtSet, market);
      const visitPrice = cents(row.visit);
      const visitDrop = dropBetween(visitPrice, market);
      const meaningfulDrop = !!(savedDrop && savedDrop.raw >= MEANINGFUL_PCT);
      if (!under && !meaningfulDrop) return;
      const underDollars = under ? cents(target.price - market) : null;
      const underPct = target.price > 0 ? (target.price - market) / target.price * 100 : 0;
      const savedPct = meaningfulDrop ? savedDrop.pct : 0;
      const score = (under ? 1000 : 0) + Math.max(Number.isFinite(underPct) ? underPct : 0, savedPct);
      const savedDollars = savedDrop ? savedDrop.dollars : 0;
      deals.push({
        id: id,
        name: cleanName(row.name) || "Card",
        market: market,
        target: target,
        under: under,
        underDollars: underDollars,
        savedDrop: savedDrop,
        visit: visitPrice,
        visitDrop: visitDrop,
        meaningfulDrop: meaningfulDrop,
        score: score,
        dollars: Math.max(underDollars || 0, savedDollars)
      });
    });
    deals.sort((a, b) => b.score - a.score || b.dollars - a.dollars || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return deals;
  }

  function dropLine(drop, tail) {
    if (!drop) return "";
    const money = moneyText(drop.dollars);
    const pct = pctText(drop.pct);
    if (!money || !tail) return "";
    return "Down " + money + (pct ? " (" + pct + ")" : "") + " " + tail;
  }

  function dealLines(deal) {
    if (!deal || !deal.target) return [];
    const now = moneyText(deal.market);
    const goal = moneyText(deal.target.price);
    if (!now || !goal) return [];
    const lines = [];
    if (deal.under) {
      const gap = deal.underDollars ? moneyText(deal.underDollars) : "";
      lines.push(gap ? "Under your target by " + gap : "At your target");
    }
    const saved = dropLine(deal.savedDrop, "since you saved it");
    if (saved) lines.push(saved);
    const sameBase = deal.visit != null && cents(deal.visit) === deal.target.priceAtSet;
    if (!sameBase) {
      const visit = dropLine(deal.visitDrop, "since your last visit");
      if (visit) lines.push(visit);
    }
    return lines.filter(line => line && !/NaN|undefined|\$0(?:\.00)?/.test(line));
  }

  function rememberVisit(storage, quotes, openedAt) {
    const all = read(storage);
    const prior = {};
    const opened = stamp(openedAt);
    let dirty = false;
    (Array.isArray(quotes) ? quotes : []).forEach(row => {
      const id = cleanId(row && row.id);
      const market = cents(row && row.market);
      const rec = id && all[id];
      if (!rec || market == null || !opened) return;
      if (rec.seen != null && rec.seenAt != null && rec.seenAt + 1500 < opened) prior[id] = rec.seen;
      const stale = rec.seen == null || rec.seenAt == null || rec.seenAt + 1500 < opened;
      if (stale && (rec.seen !== market || rec.seenAt !== opened)) {
        rec.seen = market;
        rec.seenAt = opened;
        dirty = true;
      }
    });
    if (dirty) write(storage, all);
    return prior;
  }

  return {
    KEY: KEY,
    MEANINGFUL_PCT: MEANINGFUL_PCT,
    cents: cents,
    moneyText: moneyText,
    suggest: suggest,
    parsePrice: parsePrice,
    read: read,
    write: write,
    setTarget: setTarget,
    clearTarget: clearTarget,
    quoteRecord: quoteRecord,
    dropBetween: dropBetween,
    listDeals: listDeals,
    dealLines: dealLines,
    rememberVisit: rememberVisit
  };
});
