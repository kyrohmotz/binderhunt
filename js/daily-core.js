/* BinderHunt Daily Drop rules.
   Loaded as a classic script in the browser (window.BinderDaily) and as
   CommonJS by scripts/test_daily.mjs. No network, no DOM, no Scrydex. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BinderDaily = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SHARE_URL = "https://kyrohmotz.github.io/binderhunt/";
  const TZ = "America/New_York";
  const MAX_GUESSES = 3;
  /* Closeness is relative to the raw price.
     Hit: within 5%, or within $0.50 (so a cheap card is still fair).
     Warm: within 20%. Cool: within 45%. Anything farther is cold.
     A hit ends the round. Share squares use three glyphs: hit green,
     warm/cool yellow, cold or unused white. */
  const HIT_REL = 0.05;
  const HIT_ABS = 0.5;
  const WARM_REL = 0.2;
  const COOL_REL = 0.45;

  function pad(n) { return String(n).padStart(2, "0"); }

  function parseISO(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatUTC(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }

  function addDays(iso, delta) {
    const t = parseISO(iso);
    if (t == null || !Number.isFinite(delta)) return "";
    return formatUTC(t + delta * 86400000);
  }

  function daysBetween(a, b) {
    const ta = parseISO(a);
    const tb = parseISO(b);
    if (ta == null || tb == null) return 0;
    return Math.round((tb - ta) / 86400000);
  }

  function nyDateISO(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return "";
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = fmt.formatToParts(value);
    const bag = {};
    parts.forEach(part => { bag[part.type] = part.value; });
    if (!bag.year || !bag.month || !bag.day) return "";
    return bag.year + "-" + bag.month + "-" + bag.day;
  }

  function msUntilNextNyDay(now) {
    const value = now instanceof Date ? now : new Date(now);
    const start = value.getTime();
    if (!Number.isFinite(start)) return 0;
    const today = nyDateISO(value);
    if (!today) return 0;
    let lo = start;
    let hi = start + 36 * 3600000;
    while (nyDateISO(new Date(hi)) === today) hi += 6 * 3600000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (nyDateISO(new Date(mid)) === today) lo = mid;
      else hi = mid;
    }
    return Math.max(0, hi - start);
  }

  function formatRemain(ms) {
    const s = Math.max(0, Math.ceil(Number(ms) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (s <= 0) return "Next drop is in";
    if (h > 0) return "Next drop in " + h + "h " + m + "m";
    if (m > 0) return "Next drop in " + m + "m " + sec + "s";
    return "Next drop in " + sec + "s";
  }

  function usablePrice(value) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : 0;
  }

  function mix(seed) {
    let h = 2166136261;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function dropNumber(epoch, iso) {
    return daysBetween(epoch, iso) + 1;
  }

  function pickDrop(data, iso) {
    const pool = data && Array.isArray(data.pool) ? data.pool : [];
    const days = data && Array.isArray(data.days) ? data.days : [];
    const epoch = data && typeof data.epoch === "string" ? data.epoch : iso;
    const n = dropNumber(epoch, iso);
    const byId = new Map();
    pool.forEach(card => { if (card && card.id) byId.set(card.id, card); });
    if (n >= 1 && n <= days.length) {
      const card = byId.get(days[n - 1]);
      if (card && usablePrice(card.price)) return { card, n, date: iso, scheduled: true };
    }
    const priced = pool.filter(card => card && card.id && usablePrice(card.price));
    if (!priced.length || !iso) return null;
    const idx = mix(iso) % priced.length;
    const display = n >= 1 ? n : 1;
    return { card: priced[idx], n: display, date: iso, scheduled: false };
  }

  function judgeGuess(guess, actual, previous) {
    const g = Math.round(Number(guess) * 100) / 100;
    const a = Math.round(Number(actual) * 100) / 100;
    if (!Number.isFinite(g) || !Number.isFinite(a) || g <= 0 || a <= 0) return null;
    const diff = Math.abs(g - a);
    const rel = diff / a;
    let band = "cold";
    if (rel <= HIT_REL + 1e-9 || diff <= HIT_ABS) band = "hit";
    else if (rel <= WARM_REL + 1e-9) band = "warm";
    else if (rel <= COOL_REL + 1e-9) band = "cool";
    let direction = "spot";
    if (g < a - 0.001) direction = "higher";
    else if (g > a + 0.001) direction = "lower";
    let trend = "";
    const prev = previous == null ? null : Math.round(Number(previous) * 100) / 100;
    if (prev != null && Number.isFinite(prev) && prev > 0) {
      const prevDiff = Math.abs(prev - a);
      if (diff + 0.02 < prevDiff) trend = "warmer";
      else if (diff > prevDiff + 0.02) trend = "colder";
      else trend = "same";
    }
    return { band, direction, trend, rel, diff, guess: g, actual: a };
  }

  function feedbackLine(result) {
    if (!result) return "";
    const dir = result.direction === "higher" ? "Higher" : result.direction === "lower" ? "Lower" : "Dead on";
    const band = { hit: "On it", warm: "Warm", cool: "Cool", cold: "Cold" }[result.band] || "";
    const trend = result.trend === "warmer" ? "Warmer" : result.trend === "colder" ? "Colder" : "";
    return [dir, trend, band].filter(Boolean).join(" · ");
  }

  function applyStreak(prev, date) {
    const current = prev && Number.isFinite(prev.current) ? prev.current : 0;
    const best = prev && Number.isFinite(prev.best) ? prev.best : 0;
    const last = prev && typeof prev.lastPlayed === "string" ? prev.lastPlayed : "";
    if (!parseISO(date)) return { current, best, lastPlayed: last, repeated: false };
    if (last === date) return { current, best, lastPlayed: last, repeated: true };
    const next = last && last === addDays(date, -1) ? current + 1 : 1;
    return { current: next, best: Math.max(best, next), lastPlayed: date, repeated: false };
  }

  function visibleStreak(prev, date) {
    const best = prev && Number.isFinite(prev.best) ? prev.best : 0;
    const last = prev && typeof prev.lastPlayed === "string" ? prev.lastPlayed : "";
    const current = prev && Number.isFinite(prev.current) ? prev.current : 0;
    if (last && (last === date || last === addDays(date, -1))) return { current, best: Math.max(best, current) };
    return { current: 0, best };
  }

  function shareGlyph(band) {
    if (band === "hit") return "🟩";
    if (band === "warm" || band === "cool") return "🟨";
    return "⬜";
  }

  function shareText(play) {
    const n = play && Number.isFinite(play.n) ? play.n : 0;
    const bands = play && Array.isArray(play.bands) ? play.bands : [];
    const solved = !!(play && play.solved);
    const used = play && Number.isFinite(play.guessesUsed) ? play.guessesUsed : bands.length;
    const squares = [0, 1, 2].map(i => shareGlyph(bands[i])).join("");
    const score = solved ? String(used) : "X";
    return "🐸 BinderHunt Daily #" + n + " " + squares + " " + score + "/3\n" + SHARE_URL;
  }

  return {
    SHARE_URL, TZ, MAX_GUESSES,
    HIT_REL, HIT_ABS, WARM_REL, COOL_REL,
    addDays, daysBetween, nyDateISO, msUntilNextNyDay, formatRemain,
    usablePrice, mix, dropNumber, pickDrop,
    judgeGuess, feedbackLine, applyStreak, visibleStreak, shareText
  };
});
