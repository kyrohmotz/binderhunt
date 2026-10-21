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
     A hit ends the round. Share squares: hit green, warm/cool yellow,
     cold white, unused black. */
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

  function roundMoney(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100) / 100;
  }

  function usablePrice(value) {
    const n = roundMoney(value);
    return n >= 1 ? n : 0;
  }

  function usableFx(rate) {
    const n = Number(rate);
    return n > 0.2 && n < 5 ? n : 0;
  }

  /* The profile's default USD price is the cheapest TCGplayer market.
     Mid/low-only printings and Cardmarket averages do not count. */
  function profileUsd(variants) {
    const priced = (Array.isArray(variants) ? variants : []).filter(variant => variant && roundMoney(variant.market));
    if (!priced.length) return null;
    priced.sort((a, b) => roundMoney(a.market) - roundMoney(b.market) || String(a.key || "").localeCompare(String(b.key || "")));
    const variant = priced[0];
    return {
      price: roundMoney(variant.market),
      variant: variant.key || "",
      printing: variant.label || "",
      alts: priced.length
    };
  }

  /* The profile's Cardmarket line is the first printing average, else cm.avg.
     Trend and the 30/7/1-day averages are not the price. */
  function cardmarketQuote(card) {
    const printings = card && Array.isArray(card.printings) ? card.printings : [];
    const printing = printings.find(row => row && roundMoney(row.avg));
    const avg = printing ? printing.avg : card && card.cm && card.cm.avg;
    const eur = roundMoney(avg);
    if (!eur) return null;
    return { eur, label: "Cardmarket average" };
  }

  function convertEur(eur, fx) {
    const amount = roundMoney(eur);
    const rate = usableFx(fx);
    if (!amount || !rate) return 0;
    return Math.round(amount * rate * 100) / 100;
  }

  function fallbackQuote(entry) {
    if (!entry || entry.source === "cardmarket" || entry.variant === "cardmarket") return null;
    const price = usablePrice(entry.price);
    if (!price) return null;
    return {
      price,
      variant: entry.variant || "",
      printing: entry.printing || "",
      alts: Number(entry.alts) || 1,
      eur: roundMoney(entry.eur),
      live: false
    };
  }

  function lockQuote(day, quote) {
    if (!day || day.locked) return day || null;
    const price = quote && usablePrice(quote.price);
    if (!price) return day;
    day.price = price;
    day.variant = quote.variant || day.variant || "";
    day.printing = quote.printing || day.printing || "";
    if (roundMoney(quote.eur)) day.eur = roundMoney(quote.eur);
    if (Number(quote.alts) > 0) day.alts = Number(quote.alts);
    day.live = !!quote.live;
    day.locked = true;
    return day;
  }

  function showPrinting(quote) {
    if (!quote || !(quote.printing || quote.variant)) return false;
    const key = String(quote.variant || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!key || key === "normal") return Number(quote.alts) > 1;
    return true;
  }

  const SPECIES_SKIP = {
    dark: 1, light: 1, shining: 1, shiny: 1, team: 1, rocket: 1, rockets: 1,
    radiant: 1, amazing: 1, galarian: 1, alolan: 1, hisuian: 1, paldean: 1,
    the: 1, an: 1, ex: 1, gx: 1, v: 1, vmax: 1, vstar: 1,
    break: 1, legend: 1, star: 1, prism: 1, lv: 1, lvx: 1
  };

  function speciesName(name) {
    const words = String(name || "").match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const kept = [];
    words.forEach(word => {
      let display = word.replace(/['’]s$/i, "");
      let token = display.toLowerCase();
      const dash = token.lastIndexOf("-");
      if (dash > 0 && SPECIES_SKIP[token.slice(dash + 1)]) {
        display = display.slice(0, display.lastIndexOf("-"));
        token = token.slice(0, dash);
      }
      if (SPECIES_SKIP[token] || token.length <= 1) return;
      kept.push(display);
    });
    return kept.length ? kept[kept.length - 1] : "";
  }

  function wishFields(card) {
    const image = card && card.image || "";
    return {
      id: card && card.id || "",
      name: card && card.name || "",
      set: card && card.set || "",
      setId: card && card.setId || "",
      number: card && (card.number || card.num) || "",
      rarity: card && card.rarity || "",
      img: card && card.img || (image ? image + "/high.webp" : ""),
      thumb: card && card.thumb || (image ? image + "/low.webp" : ""),
      types: card && Array.isArray(card.types) ? card.types.slice() : [],
      variants: card && Array.isArray(card.variants) ? card.variants : []
    };
  }

  function sanitizeGuess(raw) {
    let text = String(raw ?? "").replace(/[^0-9.,$]/g, "");
    const dollar = text.charAt(0) === "$" || text.includes("$");
    text = text.replace(/\$/g, "");
    const dot = text.indexOf(".");
    if (dot >= 0) text = text.slice(0, dot + 1) + text.slice(dot + 1).replace(/\./g, "");
    return (dollar ? "$" : "") + text;
  }

  /* Keep a letters-only attempt in the field. Sanitizing it first would
     leave an empty box, and an empty box is "above zero," not "not a price." */
  function readGuess(raw) {
    const original = String(raw ?? "");
    const disallowed = /[^0-9.,$\s]/.test(original);
    if (disallowed && !/\d/.test(original)) {
      return { text: original, message: "That isn't a price. Use digits, like 12.50." };
    }
    return {
      text: sanitizeGuess(original),
      message: disallowed ? "That isn't a price. Use digits, like 12.50." : ""
    };
  }

  function parseGuess(raw) {
    const original = String(raw ?? "").trim();
    if (!original) return { ok: false, reason: "low", value: 0, message: "Enter a price above zero." };
    if (/[^0-9.,$\s]/.test(original) || !/\d/.test(original)) {
      return { ok: false, reason: "invalid", value: 0, message: "That isn't a price. Use digits, like 12.50." };
    }
    let text = original.replace(/[$\s]/g, "");
    if (!text || !/\d/.test(text)) {
      return { ok: false, reason: "invalid", value: 0, message: "That isn't a price. Use digits, like 12.50." };
    }
    const commas = text.match(/,/g);
    const european = commas && commas.length === 1 && /,\d{2}$/.test(text) && !/,\d{3}$/.test(text) && text.indexOf(".") < 0;
    if (european) {
      text = text.replace(",", ".");
    } else if (commas) {
      if (!/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text)) {
        return { ok: false, reason: "comma", value: 0, message: "Use 12,50 for cents, or 1,250 for thousands." };
      }
      text = text.replace(/,/g, "");
    }
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) {
      return { ok: false, reason: "invalid", value: 0, message: "That isn't a price. Use digits, like 12.50." };
    }
    const n = Math.round(Number(text) * 100) / 100;
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "low", value: 0, message: "Enter a price above zero." };
    if (n > 1000000) return { ok: false, reason: "high", value: 0, message: "That guess is too high." };
    return { ok: true, reason: "", value: n, message: "" };
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
    if (result.band === "hit") return result.direction === "spot" ? "Dead on!" : "Nailed it";
    const dir = result.direction === "higher" ? "Higher" : result.direction === "lower" ? "Lower" : "";
    const band = { warm: "Warm", cool: "Cool", cold: "Cold" }[result.band] || "";
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
    if (!band) return "▪️";
    if (band === "hit") return "🟩";
    if (band === "warm" || band === "cool") return "🟨";
    return "⬜";
  }

  /* The next two New York dates are still unplayed. Today and earlier have started. */
  function quoteWindow(today, iso) {
    const delta = daysBetween(today, iso);
    if (!delta || !parseISO(today) || !parseISO(iso)) return false;
    return delta >= 1 && delta <= 2;
  }

  function quoteFields(row) {
    const price = usablePrice(row && row.price);
    if (!row || !row.id || !price) return null;
    if (row.source === "cardmarket" || row.variant === "cardmarket") return null;
    const out = {
      id: String(row.id),
      price,
      variant: row.variant || "",
      printing: row.printing || "",
      alts: Number(row.alts) > 0 ? Number(row.alts) : 1,
      source: "tcgplayer"
    };
    const eur = roundMoney(row.eur);
    if (eur) out.eur = eur;
    if (row.at) out.at = String(row.at);
    return out;
  }

  function sameQuote(left, right) {
    if (!left || !right) return false;
    return left.id === right.id
      && left.price === right.price
      && left.variant === right.variant
      && left.printing === right.printing
      && left.alts === right.alts
      && (left.eur || 0) === (right.eur || 0)
      && (left.source || "tcgplayer") === (right.source || "tcgplayer");
  }

  /* Copy every stored quote through. Only the next two days may change,
     and a past or already-started date is left as the same object. */
  function mergeQuotes(existing, today, incoming) {
    const out = {};
    const prior = existing && typeof existing === "object" ? existing : {};
    Object.keys(prior).forEach(iso => { out[iso] = prior[iso]; });
    const rows = incoming && typeof incoming === "object" ? incoming : {};
    Object.keys(rows).forEach(iso => {
      if (!quoteWindow(today, iso)) return;
      const built = quoteFields(rows[iso]);
      if (!built) return;
      if (sameQuote(out[iso], built)) return;
      out[iso] = built;
    });
    return out;
  }

  function snapshotQuote(data, iso) {
    const snap = data && data.quotes && data.quotes[iso];
    const built = quoteFields(snap);
    if (!built) return null;
    const drop = pickDrop(data, iso);
    if (!drop || !drop.card || built.id !== drop.card.id) return null;
    return {
      price: built.price,
      variant: built.variant,
      printing: built.printing,
      alts: built.alts,
      eur: built.eur || 0,
      live: false,
      snapshot: true,
      locked: false,
      id: built.id
    };
  }

  /* A started day keeps the price it already locked. Otherwise the shared
     snapshot wins. Null means the caller should load TCGdex and lock that. */
  function quoteForPlay(data, iso, day) {
    const started = day && (day.locked || (Array.isArray(day.guesses) && day.guesses.length));
    const price = started ? usablePrice(day.price) || roundMoney(day.price) : 0;
    if (started && price) {
      return {
        price,
        variant: day.variant || "",
        printing: day.printing || "",
        alts: Number(day.alts) > 0 ? Number(day.alts) : 1,
        eur: roundMoney(day.eur),
        live: !!day.live,
        snapshot: false,
        locked: true,
        id: day.id || ""
      };
    }
    return snapshotQuote(data, iso);
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
    roundMoney, usablePrice, usableFx, profileUsd, cardmarketQuote, convertEur,
    fallbackQuote, lockQuote, showPrinting, speciesName, wishFields,
    sanitizeGuess, readGuess, parseGuess, mix, dropNumber, pickDrop,
    quoteWindow, mergeQuotes, snapshotQuote, quoteForPlay,
    judgeGuess, feedbackLine, applyStreak, visibleStreak, shareText, shareGlyph
  };
});
