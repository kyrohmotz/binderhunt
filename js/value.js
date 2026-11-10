/* Collection value from the cached Scrydex file only.
   Loaded as a classic script (window.BinderValue) and as CommonJS.
   It does not fetch Scrydex or TCGdex. Prices below one cent, zeroes,
   and non-finite numbers stay out of every total. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderValue = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const KEY = "bh.value.v1";
  const DAY = 86400000;
  const SPARK_CAP = 96;

  function positive(value) {
    const n = typeof value === "number" ? value : (value == null || value === "" ? NaN : Number(value));
    return Number.isFinite(n) && n > 0 ? n : null;
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

  function dayLabel(t) {
    const date = new Date(t);
    const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return date.getUTCFullYear() + "-" + mo + "-" + d;
  }

  function cents(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    const rounded = Math.round(n * 100) / 100;
    return rounded >= 0.01 ? rounded : null;
  }

  function cleanId(id) {
    const s = typeof id === "string" ? id.trim() : "";
    return s && s.length <= 80 ? s : "";
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

  function labelVariant(key) {
    return String(key || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  function seriesFor(rec) {
    if (!rec || rec.missing || !Array.isArray(rec.history)) return null;
    const byVariant = new Map();
    rec.history.forEach(row => {
      if (!row || typeof row !== "object") return;
      const price = positive(row.m);
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
    if (!last || !(last.value > 0) || !(last.t > 0)) return null;
    const target = last.t - days * DAY;
    let prev = null;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point && point.t <= target && point.value > 0) prev = point;
    }
    if (!prev || !(prev.t > 0) || !(prev.value > 0)) return null;
    const lag = (last.t - prev.t) / DAY;
    if (!(lag >= minLag && lag <= maxLag)) return null;
    const delta = last.value - prev.value;
    const pct = delta / prev.value * 100;
    if (!Number.isFinite(delta) || !Number.isFinite(pct)) return null;
    const money = cents(Math.abs(delta));
    const dir = !money ? "flat" : delta > 0 ? "up" : "down";
    return {
      baseline: prev.value,
      latest: last.value,
      delta: dir === "flat" ? 0 : (delta > 0 ? money : -money),
      pct: dir === "flat" ? 0 : Math.round(Math.abs(pct) * 10) / 10,
      dir,
      days: Math.round(lag)
    };
  }

  function quoteId(id, cards) {
    const rec = cards && Object.prototype.hasOwnProperty.call(cards, id) ? cards[id] : null;
    const name = rec && typeof rec.name === "string" ? rec.name.replace(/\s+/g, " ").trim() : "";
    const series = seriesFor(rec);
    if (!series) return { id, priced: false, name: name || id };
    return {
      id,
      priced: true,
      name: name || id,
      variant: series.variant,
      latest: series.latest.value,
      latestT: series.latest.t,
      points: series.points,
      move7: windowMove(series.points, 7, 7, 14),
      move30: windowMove(series.points, 30, 30, 45)
    };
  }

  function sumLatest(rows) {
    let total = 0;
    let n = 0;
    rows.forEach(row => {
      if (!row.priced || !(row.latest > 0) || !Number.isFinite(row.latest)) return;
      total += row.latest;
      n++;
    });
    if (!n) return { total: null, priced: 0, tiny: false };
    const rounded = cents(total);
    if (rounded == null) return { total: null, priced: n, tiny: true };
    return { total: rounded, priced: n, tiny: false };
  }

  function portfolioMove(rows, which) {
    let now = 0;
    let then = 0;
    let n = 0;
    const priced = rows.filter(row => row.priced).length;
    rows.forEach(row => {
      const move = row[which];
      if (!row.priced || !move) return;
      if (!(move.baseline > 0) || !(row.latest > 0)) return;
      now += row.latest;
      then += move.baseline;
      n++;
    });
    if (!n || !(then > 0)) return null;
    const delta = now - then;
    const pct = delta / then * 100;
    if (!Number.isFinite(delta) || !Number.isFinite(pct)) return null;
    const money = cents(Math.abs(delta));
    const dir = !money ? "flat" : delta > 0 ? "up" : "down";
    return {
      delta: dir === "flat" ? 0 : (delta > 0 ? money : -money),
      pct: dir === "flat" ? 0 : Math.round(Math.abs(pct) * 10) / 10,
      dir,
      n,
      priced
    };
  }

  function sample(points) {
    if (points.length <= SPARK_CAP) return points;
    const out = [];
    const last = points.length - 1;
    for (let i = 0; i < SPARK_CAP; i++) {
      const index = Math.round(i * last / (SPARK_CAP - 1));
      const point = points[index];
      if (!out.length || out[out.length - 1].t !== point.t) out.push(point);
    }
    if (out[out.length - 1].t !== points[last].t) out.push(points[last]);
    return out;
  }

  function sumWindow(priced, start, end) {
    const points = [];
    for (let day = start; day <= end && points.length < 140; day += DAY) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < priced.length; i++) {
        const row = priced[i];
        let value = null;
        const series = row.points;
        for (let p = 0; p < series.length; p++) {
          if (series[p].t <= day) value = series[p].value;
          else break;
        }
        if (value > 0) {
          sum += value;
          n++;
        }
      }
      const total = cents(sum);
      if (n && total) points.push({ t: day, label: dayLabel(day), value: total, n });
    }
    return sample(points);
  }

  function sparkline(rows) {
    const priced = rows.filter(row => row.priced && row.points && row.points.length);
    if (!priced.length) return { points: [], mode: "" };
    let sharedStart = 0;
    let sharedEnd = Infinity;
    let coveredStart = Infinity;
    let coveredEnd = 0;
    priced.forEach(row => {
      const first = row.points[0].t;
      const last = row.points[row.points.length - 1].t;
      if (first > sharedStart) sharedStart = first;
      if (last < sharedEnd) sharedEnd = last;
      if (first < coveredStart) coveredStart = first;
      if (last > coveredEnd) coveredEnd = last;
    });
    if (sharedEnd - sharedStart >= 7 * DAY) {
      return { points: sumWindow(priced, sharedStart, sharedEnd), mode: "shared" };
    }
    const firsts = priced.map(row => row.points[0].t).sort((a, b) => a - b);
    const need = Math.max(1, Math.ceil(priced.length * 0.8));
    let start = firsts[Math.min(need, firsts.length) - 1];
    if (coveredEnd - start > 120 * DAY) start = coveredEnd - 120 * DAY;
    if (!(coveredEnd - start >= 7 * DAY)) return { points: [], mode: "" };
    return { points: sumWindow(priced, start, coveredEnd), mode: "covered" };
  }

  function movers(rows, limit) {
    const cap = limit > 0 ? limit : 3;
    const pool = [];
    rows.forEach(row => {
      if (!row.priced) return;
      const move = row.move30 || row.move7;
      if (!move || move.dir === "flat" || !(Math.abs(move.delta) >= 0.01)) return;
      pool.push({
        id: row.id,
        name: row.name,
        bucket: row.bucket,
        variant: row.variant,
        latest: row.latest,
        delta: move.delta,
        pct: move.pct,
        dir: move.dir,
        window: row.move30 ? 30 : 7
      });
    });
    const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    const gainers = pool.filter(row => row.dir === "up").sort((a, b) => b.delta - a.delta || byName(a, b)).slice(0, cap);
    const decliners = pool.filter(row => row.dir === "down").sort((a, b) => a.delta - b.delta || byName(a, b)).slice(0, cap);
    return { gainers, decliners };
  }

  function partFrom(ids, rows) {
    const sum = sumLatest(rows);
    return {
      ids,
      rows,
      total: sum.total,
      priced: sum.priced,
      unpriced: rows.length - sum.priced,
      tiny: sum.tiny,
      move7: portfolioMove(rows, "move7"),
      move30: portfolioMove(rows, "move30"),
      key: rows.filter(row => row.priced).map(row => row.id).sort().join(",")
    };
  }

  function build(input) {
    const cards = input && input.cards && typeof input.cards === "object" ? input.cards : {};
    const ownedIds = uniqueIds(input && input.ownedIds);
    const wishIds = uniqueIds(input && input.wishIds);
    const ownedSet = new Set(ownedIds);
    const finishIds = wishIds.filter(id => !ownedSet.has(id));
    const heldBack = wishIds.length - finishIds.length;
    const ownedRows = ownedIds.map(id => Object.assign(quoteId(id, cards), { bucket: "owned" }));
    const wishRows = finishIds.map(id => Object.assign(quoteId(id, cards), { bucket: "wish" }));
    const owned = partFrom(ownedIds, ownedRows);
    owned.spark = sparkline(ownedRows);
    const wish = partFrom(finishIds, wishRows);
    wish.heldBack = heldBack;
    const seen = new Set();
    const pooled = [];
    ownedRows.concat(wishRows).forEach(row => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      pooled.push(row);
    });
    return { owned, wish, movers: movers(pooled, input && input.moverLimit) };
  }

  function storedMoney(value) {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.01) return undefined;
    return Math.round(value * 100) / 100;
  }

  function readSnapshot(storage) {
    if (!storage || typeof storage.getItem !== "function") return null;
    let raw = null;
    try { raw = JSON.parse(storage.getItem(KEY) || "null"); }
    catch (e) { return null; }
    if (!raw || raw.v !== 1 || typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at <= 0) return null;
    const ownedTotal = storedMoney(raw.ownedTotal);
    const wishTotal = storedMoney(raw.wishTotal);
    if (ownedTotal === undefined || wishTotal === undefined) return null;
    const ownedKey = typeof raw.ownedKey === "string" ? raw.ownedKey : "";
    const wishKey = typeof raw.wishKey === "string" ? raw.wishKey : "";
    if (ownedKey.length > 20000 || wishKey.length > 20000) return null;
    return { v: 1, at: raw.at, ownedTotal, wishTotal, ownedKey, wishKey };
  }

  function sideDelta(previousTotal, previousKey, nextTotal, nextKey) {
    if (previousTotal == null || nextTotal == null) return { kind: "unknown" };
    const delta = Math.round((nextTotal - previousTotal) * 100) / 100;
    const dir = Math.abs(delta) < 0.01 ? "flat" : delta > 0 ? "up" : "down";
    return { kind: "return", delta: dir === "flat" ? 0 : delta, dir, same: previousKey === nextKey };
  }

  function visitDelta(previous, portfolio) {
    if (!previous || !portfolio) return { kind: "first", at: null };
    return {
      kind: "return",
      at: previous.at,
      owned: sideDelta(previous.ownedTotal, previous.ownedKey, portfolio.owned.total, portfolio.owned.key),
      wish: sideDelta(previous.wishTotal, previous.wishKey, portfolio.wish.total, portfolio.wish.key)
    };
  }

  function snapshotFrom(portfolio, at) {
    return {
      v: 1,
      at,
      ownedTotal: portfolio.owned.total,
      wishTotal: portfolio.wish.total,
      ownedKey: portfolio.owned.key,
      wishKey: portfolio.wish.key
    };
  }

  function writeSnapshot(storage, portfolio, at) {
    if (!storage || typeof storage.setItem !== "function" || !portfolio) return false;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return false;
    try {
      storage.setItem(KEY, JSON.stringify(snapshotFrom(portfolio, at)));
      return true;
    } catch (e) {
      return false;
    }
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
    if (!text || /NaN|Infinity/.test(text) || /^[^0-9]*0(?:\.00)?$/.test(text)) return "";
    return text;
  }

  function moveLine(move, days) {
    const label = days + " days";
    if (!move || move.dir === "flat" || !(Math.abs(move.delta) >= 0.01)) {
      return move ? "Unchanged over " + label : "Not enough history for " + label;
    }
    const money = moneyText(move.delta);
    if (!money) return "Not enough history for " + label;
    const word = move.dir === "down" ? "Down" : "Up";
    const pct = move.pct >= 0.1 ? " (" + move.pct.toFixed(1) + "%)" : "";
    let line = word + " " + money + pct;
    if (move.priced && move.n < move.priced) line += " · " + move.n + " of " + move.priced + " priced cards";
    return line;
  }

  function visitLine(report, sideName) {
    if (!report || report.kind !== "return") return "We'll remember this total for your next visit.";
    const side = report[sideName];
    if (!side || side.kind === "unknown") return "Last visit had no priced total to compare.";
    if (side.dir === "flat" || !(Math.abs(side.delta) >= 0.01)) {
      return side.same === false
        ? "The cards changed since your last visit. The priced total is unchanged."
        : "Unchanged since your last visit.";
    }
    const money = moneyText(side.delta);
    if (!money) return "We'll remember this total for your next visit.";
    const word = side.dir === "down" ? "Down" : "Up";
    const tail = side.same === false ? ", including cards you added or removed" : "";
    return word + " " + money + " since your last visit" + tail + ".";
  }

  function unpricedLine(rows) {
    const missing = [];
    const seen = new Set();
    (rows || []).forEach(row => {
      if (!row || row.priced || seen.has(row.id)) return;
      seen.add(row.id);
      missing.push(row);
    });
    const n = missing.length;
    if (!n) return "";
    const head = n === 1 ? "1 card has no price yet" : n + " cards have no price yet";
    const names = [];
    missing.forEach(row => {
      const name = row.name || row.id;
      if (name && names.length < 4 && !names.includes(name)) names.push(name);
    });
    if (!names.length) return head + ".";
    return head + ": " + names.join(", ") + (n > names.length ? "…" : "") + ".";
  }

  function coverageLine(part, noun) {
    if (!part || !part.ids.length) return "";
    if (part.tiny) return "Priced, and still under one cent.";
    if (!part.priced) return part.ids.length === 1 ? "No price yet for this card." : "No price yet for these cards.";
    if (!part.unpriced) return part.priced === 1 ? "1 " + noun + " card priced." : part.priced + " " + noun + " cards priced.";
    return part.priced + " of " + part.ids.length + " " + noun + " cards have a price.";
  }

  function finishLine(wish) {
    if (!wish || !wish.ids.length) return "Swipe right on a card you still need. The cost to finish shows up here.";
    const left = wish.ids.length === 1 ? "1 card left" : wish.ids.length + " cards left";
    let line = "What it would cost to finish. " + left + ".";
    if (wish.heldBack === 1) line += " 1 wishlist card is already in your hands.";
    else if (wish.heldBack > 1) line += " " + wish.heldBack + " wishlist cards are already in your hands.";
    return line;
  }

  function sparkCaption(spark) {
    const points = spark && spark.points || [];
    if (points.length < 2) return "Not enough shared history for a chart yet.";
    const from = moneyText(points[0].value);
    const to = moneyText(points[points.length - 1].value);
    if (!from || !to) return "Not enough shared history for a chart yet.";
    const note = spark.mode === "shared"
      ? "Shared cached history for every priced card."
      : "Cached history. A step can be a card's history starting.";
    return from + " to " + to + ". " + note;
  }

  function sparkSvg(spark) {
    const points = spark && spark.points || [];
    if (points.length < 2) return "";
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
    const w = 320;
    const h = 84;
    const padX = 8;
    const padY = 10;
    const xOf = i => padX + i * (w - padX * 2) / (points.length - 1);
    const yOf = v => padY + (1 - (v - min) / (max - min)) * (h - padY * 2);
    const line = points.map((point, i) => (i ? "L" : "M") + xOf(i).toFixed(1) + "," + yOf(point.value).toFixed(1)).join(" ");
    const area = line + " L" + xOf(points.length - 1).toFixed(1) + "," + (h - padY) + " L" + xOf(0).toFixed(1) + "," + (h - padY) + " Z";
    const label = "Owned collection value, " + sparkCaption(spark);
    const esc = label.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    return `<svg class="value-spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc}"><path d="${area}" fill="#ABB28D" opacity="0.35"/><path d="${line}" fill="none" stroke="#2FA9D9" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function cardStub(row) {
    const id = row && row.id || "";
    const art = artFor(id);
    const parts = splitId(id);
    const stub = {
      id,
      name: row && row.name || id,
      number: parts.number,
      setId: parts.setId,
      img: art.img,
      thumb: art.thumb,
      image: art.image,
      backup: art.backup
    };
    if (row && row.priced && row.latest > 0 && row.variant) {
      stub.variants = [{ key: row.variant, label: labelVariant(row.variant), market: row.latest }];
    }
    return stub;
  }

  return {
    KEY,
    positive,
    seriesFor,
    windowMove,
    build,
    readSnapshot,
    visitDelta,
    snapshotFrom,
    writeSnapshot,
    moneyText,
    moveLine,
    visitLine,
    unpricedLine,
    coverageLine,
    finishLine,
    sparkCaption,
    sparkSvg,
    cardStub,
    artFor,
    uniqueIds
  };
});
