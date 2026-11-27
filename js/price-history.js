/* Price history for one card, from data/price-history.json only.
   Loaded as a classic script (window.BinderPriceHistory) and as CommonJS.
   The file is a rolling view of raw near-mint prices the daily sync already
   stored. This module does not fetch Scrydex.

   A series is [yyyymmdd, cents, dayDelta, centDelta, ...]. A positive day
   delta was observed the whole way, so the price holds across it. A negative
   day delta is a gap with no saved print. Those gaps are not a flat price. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderPriceHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY = 86400000;
  const WINDOWS = {
    "7d": { days: 7, label: "7 day" },
    "30d": { days: 30, label: "30 day" },
    "90d": { days: 90, label: "90 day" }
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function ymdTime(value) {
    const n = typeof value === "number" ? value : NaN;
    if (!Number.isInteger(n)) return 0;
    const y = Math.floor(n / 10000);
    const m = Math.floor(n / 100) % 100;
    const d = n % 100;
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return 0;
    const t = Date.UTC(y, m - 1, d);
    const check = new Date(t);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return 0;
    return t;
  }

  function iso(t) {
    const date = new Date(t);
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return date.getUTCFullYear() + "-" + m + "-" + d;
  }

  function pretty(t) {
    if (!(t > 0)) return "";
    const date = new Date(t);
    return MONTHS[date.getUTCMonth()] + " " + date.getUTCDate() + ", " + date.getUTCFullYear();
  }

  function shortDate(t) {
    if (!(t > 0)) return "";
    const date = new Date(t);
    return MONTHS[date.getUTCMonth()] + " " + date.getUTCDate();
  }

  function goodPrice(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0.01;
  }

  function unpack(packed) {
    if (!Array.isArray(packed) || packed.length < 2 || packed.length % 2 !== 0) return [];
    const start = ymdTime(packed[0]);
    let cents = packed[1];
    if (!start || !Number.isInteger(cents) || cents < 1 || cents > 100000000) return [];
    const points = [{ t: start, value: cents / 100, label: iso(start), bridge: "start" }];
    let t = start;
    for (let i = 2; i < packed.length; i += 2) {
      const deltaDays = packed[i];
      const deltaCents = packed[i + 1];
      if (!Number.isInteger(deltaDays) || deltaDays === 0 || Math.abs(deltaDays) > 120) return [];
      if (!Number.isInteger(deltaCents)) return [];
      t += Math.abs(deltaDays) * DAY;
      cents += deltaCents;
      if (!Number.isInteger(cents) || cents < 1 || cents > 100000000) return [];
      if (!(t > points[points.length - 1].t)) return [];
      points.push({
        t,
        value: cents / 100,
        label: iso(t),
        bridge: deltaDays > 0 ? "flat" : "gap"
      });
    }
    return points.every(point => goodPrice(point.value)) ? points : [];
  }

  function priceOn(points, t) {
    if (!points || !points.length || !(t > 0)) return null;
    if (t < points[0].t || t > points[points.length - 1].t) return null;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point.t === t) return goodPrice(point.value) ? point.value : null;
      const next = points[i + 1];
      if (next && t > point.t && t < next.t) {
        if (next.bridge === "flat" && goodPrice(point.value)) return point.value;
        return null;
      }
    }
    return null;
  }

  function windowMove(points, days) {
    if (!points || points.length < 2 || !Number.isFinite(days) || days < 1) return null;
    const span = days;
    const last = points[points.length - 1];
    if (!last || !goodPrice(last.value) || !(last.t > 0)) return null;
    const target = last.t - span * DAY;
    const baseline = priceOn(points, target);
    if (!goodPrice(baseline)) return null;
    const delta = last.value - baseline;
    const pct = delta / baseline * 100;
    if (!Number.isFinite(delta) || !Number.isFinite(pct)) return null;
    const dir = Math.abs(pct) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
    const shown = dir === "flat" ? 0 : Math.round(Math.abs(pct) * 10) / 10;
    if (!Number.isFinite(shown) || (dir !== "flat" && !(shown > 0))) return null;
    return { baseline, latest: last.value, delta, pct, shown, dir, days: span };
  }

  function movesFor(points) {
    return {
      "7d": windowMove(points, 7),
      "30d": windowMove(points, 30),
      "90d": windowMove(points, 90)
    };
  }

  function clip(points, days) {
    if (!points || !points.length) return [];
    const last = points[points.length - 1];
    const start = last.t - days * DAY;
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point.t < start) continue;
      if (!out.length && point.t > start) {
        const carried = priceOn(points, start);
        if (goodPrice(carried)) {
          out.push({ t: start, value: carried, label: iso(start), bridge: "flat", carried: true });
        }
      }
      out.push(point);
    }
    return out.length ? out : points.slice();
  }

  function extent(points) {
    let low = Infinity;
    let high = -Infinity;
    (points || []).forEach(point => {
      if (!goodPrice(point && point.value)) return;
      if (point.value < low) low = point.value;
      if (point.value > high) high = point.value;
    });
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0.01 || high < 0.01) return { low: null, high: null };
    return { low, high };
  }

  function present(points, opts) {
    const options = opts || {};
    const clean = (Array.isArray(points) ? points : []).filter(point => point && point.t > 0 && goodPrice(point.value));
    const moves = movesFor(clean);
    const blank = {
      status: "none",
      tracking: false,
      points: [],
      drawn: [],
      moves,
      active: "",
      low: null,
      high: null,
      since: 0,
      summary: ""
    };
    if (!clean.length) return blank;
    let active = "";
    if (options.picked && WINDOWS[options.range]) active = options.range;
    else if (moves["90d"]) active = "90d";
    else if (moves["30d"]) active = "30d";
    else if (moves["7d"]) active = "7d";
    const drawn = active ? clip(clean, WINDOWS[active].days) : clean.slice();
    const stats = extent(drawn.length ? drawn : clean);
    const since = clean[0].t;
    const tracking = !moves["30d"];
    const status = !moves["7d"] ? "tracking" : "ready";
    const money = typeof options.money === "function" ? options.money : null;
    const summary = describe({
      tracking,
      since,
      drawn,
      low: stats.low,
      high: stats.high,
      moves
    }, money);
    return {
      status,
      tracking,
      points: clean,
      drawn,
      moves,
      active,
      low: stats.low,
      high: stats.high,
      since,
      summary
    };
  }

  function describe(model, money) {
    const bits = [];
    if (model.tracking && model.since) bits.push("Tracking since " + pretty(model.since));
    const drawn = model.drawn || [];
    if (money && drawn.length >= 2) {
      const from = money(drawn[0].value);
      const to = money(drawn[drawn.length - 1].value);
      const fromDay = pretty(drawn[0].t);
      const toDay = pretty(drawn[drawn.length - 1].t);
      if (from && to && fromDay && toDay) bits.push("from " + from + " on " + fromDay + " to " + to + " on " + toDay);
    } else if (money && drawn.length === 1) {
      const price = money(drawn[0].value);
      if (price) bits.push(price);
    }
    if (money && model.low && model.high && drawn.length >= 2) {
      const low = money(model.low);
      const high = money(model.high);
      if (low && high) bits.push("low " + low + ", high " + high);
    }
    ["7d", "30d", "90d"].forEach(id => {
      const move = model.moves && model.moves[id];
      if (!move) return;
      const word = move.dir === "down" ? "down" : move.dir === "up" ? "up" : "unchanged";
      const amount = move.dir === "flat" ? "0" : move.shown.toFixed(1);
      bits.push(WINDOWS[id].label + " " + word + " " + amount + " percent");
    });
    const text = bits.join(". ").replace(/\s+/g, " ").trim();
    if (/NaN|undefined|\$0(?:\.00)?\b/.test(text)) return "";
    return text;
  }

  return {
    WINDOWS,
    unpack,
    priceOn,
    windowMove,
    movesFor,
    clip,
    extent,
    present,
    pretty,
    shortDate,
    iso
  };
});
