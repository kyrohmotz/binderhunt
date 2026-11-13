/* Monthly budget and the buy-plan picker.
   Loaded as a classic script (window.BinderBudget) and as CommonJS.
   Prices come from the caller, which reads the cached Scrydex file.
   This module does not fetch anything, and it does not touch other storage keys.
   A missing budget stays missing: nothing writes bh.budget.v1 until a number is saved. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderBudget = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEY = "bh.budget.v1";
  const MAX_PRICE = 999999.99;
  const DAY = 86400000;

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

  function asDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    return new Date();
  }

  function monthKey(value) {
    const date = asDate(value);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    if (!Number.isFinite(year) || year < 1970 || year > 9999 || month < 1 || month > 12) return "";
    return year + "-" + String(month).padStart(2, "0");
  }

  function dateKey(value) {
    const date = asDate(value);
    const month = monthKey(date);
    const day = date.getDate();
    if (!month || day < 1 || day > 31) return "";
    const check = new Date(date.getFullYear(), date.getMonth(), day);
    if (check.getFullYear() !== date.getFullYear() || check.getMonth() !== date.getMonth() || check.getDate() !== day) return "";
    return month + "-" + String(day).padStart(2, "0");
  }

  function monthLabel(month) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
    if (!match) return "";
    const year = Number(match[1]);
    const mo = Number(match[2]);
    if (mo < 1 || mo > 12) return "";
    const date = new Date(year, mo - 1, 1);
    if (Number.isNaN(date.getTime()) || date.getMonth() !== mo - 1) return "";
    let text = "";
    try { text = new Intl.DateTimeFormat("en-US", { month: "long" }).format(date); }
    catch (e) { text = ""; }
    if (!text || /NaN|undefined/i.test(text)) return "";
    return text;
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
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 1) return "";
    const rounded = Math.round(pct * 10) / 10;
    if (!Number.isFinite(rounded) || rounded < 1) return "";
    const whole = Math.abs(rounded - Math.round(rounded)) < 0.001;
    return (whole ? String(Math.round(rounded)) : rounded.toFixed(1)) + "%";
  }

  function parsePrice(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw || /nan|infinity|undefined|null/i.test(raw)) return null;
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    return cents(Number(cleaned));
  }

  function validMonth(month) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
    if (!match) return "";
    const year = Number(match[1]);
    const mo = Number(match[2]);
    if (year < 1970 || year > 9999 || mo < 1 || mo > 12) return "";
    return match[1] + "-" + match[2];
  }

  function validDate(value, month) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return "";
    const year = Number(match[1]);
    const mo = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, mo - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== mo - 1 || date.getDate() !== day) return "";
    const key = match[1] + "-" + match[2] + "-" + match[3];
    if (month && key.slice(0, 7) !== month) return "";
    return key;
  }

  function normalizePurchase(raw, month) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = cleanId(raw.id);
    const price = cents(raw.price);
    const date = validDate(raw.date, month);
    if (!id || price == null || !date) return null;
    return { id: id, price: price, date: date };
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const amount = cents(raw.amount);
    const month = validMonth(raw.month);
    if (amount == null || !month) return null;
    const purchases = [];
    const seen = new Set();
    (Array.isArray(raw.purchases) ? raw.purchases : []).forEach(row => {
      const rec = normalizePurchase(row, month);
      if (!rec || seen.has(rec.id)) return;
      seen.add(rec.id);
      purchases.push(rec);
    });
    return { amount: amount, month: month, purchases: purchases };
  }

  function payload(state) {
    return {
      amount: state.amount,
      month: state.month,
      purchases: state.purchases.map(row => ({ id: row.id, price: row.price, date: row.date }))
    };
  }

  function write(storage, state) {
    if (!storage || typeof storage.setItem !== "function") return false;
    const clean = normalizeState(state);
    if (!clean) return false;
    try {
      storage.setItem(KEY, JSON.stringify(payload(clean)));
      return true;
    } catch (e) {
      return false;
    }
  }

  function read(storage, now) {
    if (!storage || typeof storage.getItem !== "function") return null;
    let raw = null;
    try { raw = JSON.parse(storage.getItem(KEY) || "null"); }
    catch (e) { return null; }
    if (raw == null) return null;
    const state = normalizeState(raw);
    if (!state) return null;
    const current = monthKey(asDate(now));
    if (!current || state.month === current) return state;
    const rolled = { amount: state.amount, month: current, purchases: [], rolled: true };
    write(storage, rolled);
    return rolled;
  }

  function setBudget(storage, amount, now) {
    const value = cents(amount);
    const when = asDate(now);
    const month = monthKey(when);
    if (value == null || !month) return null;
    const existing = read(storage, when);
    const purchases = existing && existing.month === month ? existing.purchases.slice() : [];
    const next = { amount: value, month: month, purchases: purchases };
    if (!write(storage, next)) return null;
    return next;
  }

  function recordPurchase(storage, purchase, now) {
    const when = asDate(now);
    const state = read(storage, when);
    if (!state) return null;
    const date = purchase && purchase.date ? String(purchase.date) : dateKey(when);
    const rec = normalizePurchase({
      id: purchase && purchase.id,
      price: purchase && purchase.price,
      date: date
    }, state.month);
    if (!rec) return null;
    if (state.purchases.some(row => row.id === rec.id)) return null;
    const next = { amount: state.amount, month: state.month, purchases: state.purchases.concat(rec) };
    if (!write(storage, next)) return null;
    return { state: next, purchase: rec };
  }

  function undoPurchase(storage, id, now) {
    const when = asDate(now);
    const state = read(storage, when);
    if (!state || !state.purchases.length) return null;
    let index = -1;
    if (id == null || id === "") index = state.purchases.length - 1;
    else {
      const cardId = cleanId(id);
      if (!cardId) return null;
      for (let i = state.purchases.length - 1; i >= 0; i--) {
        if (state.purchases[i].id === cardId) { index = i; break; }
      }
    }
    if (index < 0) return null;
    const removed = state.purchases[index];
    const purchases = state.purchases.slice();
    purchases.splice(index, 1);
    const next = { amount: state.amount, month: state.month, purchases: purchases };
    if (!write(storage, next)) return null;
    return { state: next, removed: removed };
  }

  function roundMoney(n) {
    const rounded = Math.round(n * 100) / 100;
    return Number.isFinite(rounded) ? rounded : null;
  }

  function spent(state) {
    if (!state || !Array.isArray(state.purchases)) return null;
    let total = 0;
    state.purchases.forEach(row => {
      const price = cents(row && row.price);
      if (price == null) return;
      total += price;
    });
    const rounded = roundMoney(total);
    if (rounded == null || rounded < 0) return null;
    return rounded;
  }

  function remaining(state) {
    if (!state) return null;
    const used = spent(state);
    const amount = cents(state.amount);
    if (used == null || amount == null) return null;
    const left = roundMoney(amount - used);
    return Number.isFinite(left) ? left : null;
  }

  function fitsBudget(price, left) {
    const market = cents(price);
    if (market == null || typeof left !== "number" || !Number.isFinite(left)) return false;
    return market <= roundMoney(left);
  }

  function dayTime(value) {
    const match = String(value || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!match) return 0;
    const year = Number(match[1]);
    const mo = Number(match[2]);
    const day = Number(match[3]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return 0;
    const t = Date.UTC(year, mo - 1, day);
    const check = new Date(t);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) return 0;
    return t;
  }

  function cheapestSeries(rec) {
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
      if (better) best = { variant: variant, points: compact, latest: latest };
    });
    return best;
  }

  function cheapPct(points) {
    if (!points || points.length < 2) return 0;
    const last = points[points.length - 1];
    if (!last || !(last.value > 0) || !(last.t > 0)) return 0;
    const target = last.t - 30 * DAY;
    let prev = null;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point && point.t <= target && point.t < last.t && point.value > 0) prev = point;
    }
    if (!prev || !(prev.value > last.value)) return 0;
    const lag = (last.t - prev.t) / DAY;
    if (!(lag >= 30 && lag <= 45)) return 0;
    const raw = (prev.value - last.value) / prev.value * 100;
    if (!Number.isFinite(raw) || raw < 1) return 0;
    const rounded = Math.round(raw * 10) / 10;
    if (!Number.isFinite(rounded) || rounded < 1) return 0;
    if (cents(prev.value - last.value) == null) return 0;
    return rounded;
  }

  function quoteRecord(rec) {
    const series = cheapestSeries(rec);
    if (!series) return null;
    const market = cents(series.latest.value);
    if (market == null) return null;
    return {
      market: market,
      variant: series.variant,
      cheapPct: cheapPct(series.points)
    };
  }

  function selectFits(rows, left) {
    const room = typeof left === "number" && Number.isFinite(left) ? roundMoney(left) : null;
    const fits = [];
    const waiting = [];
    const unpriced = [];
    const seen = new Set();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!row) return;
      const id = cleanId(row.id);
      if (!id || seen.has(id) || row.owned || row.purchased) return;
      seen.add(id);
      const name = cleanName(row.name) || "Card";
      const market = cents(row.market);
      const target = cents(row.target);
      const drop = typeof row.cheapPct === "number" && Number.isFinite(row.cheapPct) && row.cheapPct >= 1
        ? Math.round(row.cheapPct * 10) / 10
        : 0;
      if (market == null) {
        unpriced.push({ id: id, name: name, market: null, target: null, cheapPct: 0, underTarget: false, fits: false });
        return;
      }
      const underTarget = !!(target != null && market <= target);
      const canFit = fitsBudget(market, room == null ? NaN : room);
      const item = {
        id: id,
        name: name,
        market: market,
        target: target,
        cheapPct: drop,
        underTarget: underTarget,
        fits: canFit
      };
      if (canFit) fits.push(item);
      else waiting.push(item);
    });
    const rank = (a, b) => {
      const underA = a.underTarget ? 1 : 0;
      const underB = b.underTarget ? 1 : 0;
      if (underA !== underB) return underB - underA;
      if (a.cheapPct !== b.cheapPct) return b.cheapPct - a.cheapPct;
      if (a.market !== b.market) return a.market - b.market;
      const byName = a.name.localeCompare(b.name);
      if (byName) return byName;
      return a.id.localeCompare(b.id);
    };
    fits.sort(rank);
    waiting.sort(rank);
    unpriced.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { fits: fits, waiting: waiting, unpriced: unpriced };
  }

  return {
    KEY: KEY,
    cents: cents,
    moneyText: moneyText,
    pctText: pctText,
    parsePrice: parsePrice,
    cleanName: cleanName,
    monthKey: monthKey,
    dateKey: dateKey,
    monthLabel: monthLabel,
    read: read,
    write: write,
    setBudget: setBudget,
    recordPurchase: recordPurchase,
    undoPurchase: undoPurchase,
    spent: spent,
    remaining: remaining,
    fitsBudget: fitsBudget,
    quoteRecord: quoteRecord,
    selectFits: selectFits
  };
});
