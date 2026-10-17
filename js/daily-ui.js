/* Daily Drop screen. Classic script so it can see the hunt helpers.
   Puzzle rules live in js/daily-core.js. */
(function () {
  const D = window.BinderDaily;
  const KEY = "bh.daily.v1";
  if (!D) return;

  let cache = null;
  let dataPromise = null;
  let justFinished = false;
  let shownISO = "";
  let revealTimer = 0;

  function host() { return window.BHDailyHost || {}; }

  function blankState() {
    return { v: 1, current: 0, best: 0, lastPlayed: "", prompted: "", days: {} };
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!raw || typeof raw !== "object") return blankState();
      return {
        v: 1,
        current: Number.isFinite(raw.current) ? raw.current : 0,
        best: Number.isFinite(raw.best) ? raw.best : 0,
        lastPlayed: typeof raw.lastPlayed === "string" ? raw.lastPlayed : "",
        prompted: typeof raw.prompted === "string" ? raw.prompted : "",
        days: raw.days && typeof raw.days === "object" ? raw.days : {}
      };
    } catch (e) {
      return blankState();
    }
  }

  function saveState(state) {
    const days = state.days || {};
    const keys = Object.keys(days).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key)).sort();
    if (keys.length > 90) keys.slice(0, keys.length - 90).forEach(key => { delete days[key]; });
    state.days = days;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function todayISO() { return D.nyDateISO(new Date()); }

  function loadData() {
    if (!dataPromise) {
      dataPromise = fetch("data/daily.json", { cache: "no-cache" }).then(res => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }
    return dataPromise;
  }

  function parseGuess(raw) {
    const n = Number(String(raw || "").replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 1000000) return null;
    return Math.round(n * 100) / 100;
  }

  function startDay(drop) {
    const card = drop.card;
    return {
      id: card.id,
      name: card.name || "",
      set: card.set || "",
      setId: card.setId || "",
      num: card.num || "",
      rarity: card.rarity || "",
      image: card.image || "",
      printing: card.printing || "",
      price: D.usablePrice(card.price),
      n: drop.n,
      guesses: [],
      done: false,
      solved: false,
      counted: false
    };
  }

  function dayState(drop, iso) {
    const state = loadState();
    const saved = state.days[iso];
    if (saved && saved.id === drop.card.id && Array.isArray(saved.guesses)) return { state, day: saved };
    if (saved && saved.done && saved.id) return { state, day: saved };
    const day = startDay(drop);
    state.days[iso] = day;
    return { state, day };
  }

  function cardFor(day, drop) {
    if (!day || !day.id || day.id === drop.card.id) return drop.card;
    const fromPool = (cache.pool || []).find(card => card.id === day.id);
    if (fromPool) return fromPool;
    return {
      id: day.id,
      name: day.name || "Card",
      set: day.set || "",
      setId: day.setId || "",
      num: day.num || "",
      rarity: day.rarity || "",
      image: day.image || "",
      printing: day.printing || "",
      price: day.price,
      source: "tcgplayer",
      variant: "holofoil"
    };
  }

  function resultsFor(day) {
    const out = [];
    (day.guesses || []).forEach((guess, index) => {
      const prev = index ? day.guesses[index - 1] : null;
      const result = D.judgeGuess(guess, day.price, prev);
      if (result) out.push(result);
    });
    return out;
  }

  function paintArt(node, card) {
    if (!node) return;
    node.replaceChildren();
    const urls = [];
    if (card.image) urls.push(card.image + "/high.webp", card.image + "/low.webp");
    if (card.img) urls.push(card.img);
    if (card.thumb) urls.push(card.thumb);
    const giveUp = () => {
      if (typeof placeholder === "function") node.replaceChildren(placeholder(card));
    };
    const next = () => {
      const url = urls.shift();
      if (!url) { giveUp(); return; }
      const img = document.createElement("img");
      img.alt = (card.name || "Card") + (card.set ? ", " + card.set : "");
      img.decoding = "async";
      img.draggable = false;
      img.addEventListener("dragstart", event => event.preventDefault());
      img.onload = () => { if (node.isConnected) node.replaceChildren(img); };
      img.onerror = next;
      img.src = url;
    };
    next();
  }

  function sparkline(points) {
    if (!points || points.length < 2) return "";
    const vals = points.map(point => point.value).filter(value => value > 0);
    if (vals.length < 2) return "";
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) { min *= 0.9; max *= 1.1; }
    const w = 360, h = 112, padL = 8, padR = 8, padT = 12, padB = 22;
    const xOf = i => padL + (points.length === 1 ? 0 : i * (w - padL - padR) / (points.length - 1));
    const yOf = v => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
    const d = points.map((point, i) => (i ? "L" : "M") + xOf(i).toFixed(1) + "," + yOf(point.value).toFixed(1)).join(" ");
    const last = points.length - 1;
    const label = (point, index) => {
      const raw = point.label || "";
      const text = /^\d{4}/.test(raw) ? raw.slice(5).replace("-", "/") : raw.replace(" average", "").replace("-day avg", "d");
      const anchor = index === 0 ? "start" : index === last ? "end" : "middle";
      const x = index === 0 ? padL : index === last ? w - padR : xOf(index);
      return `<text x="${x}" y="${h - 4}" text-anchor="${anchor}" fill="#404241" font-size="11">${esc(text)}</text>`;
    };
    const marks = [0, Math.round(last / 2), last];
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Price history"><path d="${d}" fill="none" stroke="#2FA9D9" stroke-width="3" stroke-linejoin="round"/>${[...new Set(marks)].map(index => label(points[index], index)).join("")}</svg>`;
  }

  function seriesOf(card) {
    if (Array.isArray(card.history) && card.history.length >= 2) {
      return {
        points: card.history.map(point => ({ label: point.d, value: point.m })).filter(point => point.value > 0),
        note: "Cached sales for this printing. Not a live quote."
      };
    }
    if (Array.isArray(card.trend) && card.trend.length >= 2) {
      return {
        points: card.trend.map(point => ({ label: point.label, value: point.value })).filter(point => point.value > 0),
        note: "Cardmarket averages, converted to USD. Not a daily sales history."
      };
    }
    return { points: [], note: "" };
  }

  function toCard(entry) {
    const image = entry.image || "";
    const variant = entry.variant && entry.source === "tcgplayer"
      ? [{ key: entry.variant, label: entry.printing || entry.variant, market: entry.price }]
      : [];
    return {
      id: entry.id,
      name: entry.name || "",
      set: entry.set || "",
      setId: entry.setId || "",
      number: entry.num || entry.number || "",
      rarity: entry.rarity || "",
      image,
      img: image ? image + "/high.webp" : "",
      thumb: image ? image + "/low.webp" : "",
      variants: variant,
      price: entry.price,
      cm: entry.eur ? { avg: entry.eur } : null,
      types: []
    };
  }

  function sharePayload(day, results) {
    return {
      n: day.n,
      bands: results.map(result => result.band),
      solved: !!day.solved,
      guessesUsed: results.length
    };
  }

  function paint(root, data, iso) {
    const drop = D.pickDrop(data, iso);
    if (!drop) {
      root.innerHTML = `<div class="daily-wrap empty-state"><p>No priced card for today.</p>${typeof toad === "function" ? toad() : ""}</div>`;
      return;
    }
    shownISO = iso;
    const packed = dayState(drop, iso);
    const state = packed.state;
    const day = packed.day;
    const card = cardFor(day, drop);
    const results = resultsFor(day);
    const streak = D.visibleStreak(state, iso);
    const done = !!day.done;
    const animate = justFinished && done && typeof reduceMotion === "function" && !reduceMotion();
    justFinished = false;
    clearTimeout(revealTimer);
    const guessesLeft = Math.max(0, D.MAX_GUESSES - (day.guesses || []).length);
    const onWish = (host().wish || []).some(item => item && item.id === card.id);
    const owned = host().ownedIds ? host().ownedIds.has(card.id) : false;
    const mobileShare = typeof navigator.share === "function" && (matchMedia("(pointer: coarse)").matches || matchMedia("(max-width: 767px)").matches);
    const series = seriesOf(card);
    const grades = Array.isArray(card.grades) ? card.grades : [];
    const meta = [card.set, card.num ? "#" + card.num : "", card.rarity].filter(Boolean).join(" · ");
    const guessRows = results.map(result => `<li class="band-${esc(result.band)}"><b>${esc(priceText(result.guess, "USD"))}</b><span>${esc(D.feedbackLine(result))}</span></li>`).join("");
    const gradeHtml = grades.length
      ? `<div class="grade-grid">${grades.map(grade => `<div class="grade"><span>${esc(grade.company + " " + grade.grade)}</span><b>${esc(priceText(grade.market, "USD"))}</b></div>`).join("")}</div>`
      : `<p class="note">No graded sales for this printing</p>`;
    const chart = sparkline(series.points);
    root.innerHTML = `<div class="daily-wrap">
      <div class="daily-top">
        <div><p class="kicker">Daily Drop</p><h2 class="daily-title">#${esc(String(day.n || drop.n))}</h2></div>
        <div class="daily-streak"><span>Streak <b>${esc(String(streak.current))}</b></span><span>Best <b>${esc(String(streak.best))}</b></span></div>
      </div>
      <p class="daily-count" id="dailyCount">${esc(D.formatRemain(D.msUntilNextNyDay(new Date())))}</p>
      <div class="frame daily-frame" id="dailyArt"></div>
      <p class="daily-meta"><b>${esc(card.name || "Card")}</b><br><span class="fine">${esc(meta)}</span></p>
      <div class="ticket-scene">
        <div class="ticket${done && !animate ? " revealed" : ""}" id="priceTicket">
          <div class="ticket-face ticket-front" aria-hidden="true">${typeof toad === "function" ? toad() : ""}<span>Price sealed</span></div>
          <div class="ticket-face ticket-back" aria-hidden="true"><span class="fine">Raw · ${esc(card.printing || "market")}</span><span class="market-price">${esc(priceText(day.price, "USD"))}</span></div>
        </div>
      </div>
      ${guessRows ? `<ol class="guesses">${guessRows}</ol>` : ""}
      ${done ? "" : `<form class="daily-form" id="dailyForm"><label>Raw price in USD<input id="dailyGuess" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0.00"></label><button class="go" type="submit">Guess</button></form><p class="daily-left fine">${esc(guessesLeft === 1 ? "1 guess left" : guessesLeft + " guesses left")}</p>`}
      <section class="daily-reveal" id="dailyReveal"${done && !animate ? "" : " hidden"}>
        <p class="fine">Raw · ${esc(card.printing || "market")}</p>
        <p class="market-price" id="dailyAnswer">${esc(priceText(day.price, "USD"))}</p>
        ${card.eur ? `<p class="fine">Cardmarket ${esc(priceText(card.eur, "EUR"))}</p>` : ""}
        <p class="fine">${day.solved ? "You landed it." : "That's the raw price."} Same number for everyone.</p>
        ${gradeHtml}
        <div class="chart-wrap">${chart || `<p class="fine">Not enough price history</p>`}${series.note ? `<p class="fine">${esc(series.note)}</p>` : ""}</div>
        <div class="daily-actions">
          <button class="chip" type="button" id="dailyWish">${onWish ? "On wishlist" : "Save to wishlist"}</button>
          <button class="chip ownchip" type="button" id="dailyOwn" aria-pressed="${owned ? "true" : "false"}">${owned ? "Got it · undo" : "Got it"}</button>
          <button class="go" type="button" id="dailyMore">More like this</button>
        </div>
        <div class="daily-share">
          <button class="chip" type="button" id="dailyCopy">Copy result</button>
          ${mobileShare ? `<button class="chip" type="button" id="dailyNative">Share</button>` : ""}
        </div>
        <textarea class="daily-sharebox" id="dailyShareText" hidden readonly></textarea>
      </section>
    </div>`;
    paintArt(document.getElementById("dailyArt"), card);
    const form = document.getElementById("dailyForm");
    if (form) form.onsubmit = event => submitGuess(event, data, iso);
    const wish = document.getElementById("dailyWish");
    if (wish) wish.onclick = () => toggleWish(card);
    const own = document.getElementById("dailyOwn");
    if (own) own.onclick = () => toggleOwned(card);
    const more = document.getElementById("dailyMore");
    if (more) more.onclick = () => huntLike(card);
    const copy = document.getElementById("dailyCopy");
    const text = D.shareText(sharePayload(day, results));
    if (copy) copy.onclick = () => copyResult(text);
    const native = document.getElementById("dailyNative");
    if (native) native.onclick = () => nativeShare(text);
    const input = document.getElementById("dailyGuess");
    if (input && document.getElementById("viewDaily") && !document.getElementById("viewDaily").hidden) input.focus();
    const showAnswer = () => {
      const answer = document.getElementById("dailyAnswer");
      if (answer && answer.isConnected) answer.scrollIntoView({ block: "center", behavior: "auto" });
    };
    if (animate) {
      requestAnimationFrame(() => {
        const ticket = document.getElementById("priceTicket");
        if (ticket) ticket.classList.add("revealed");
      });
      revealTimer = setTimeout(() => {
        const reveal = document.getElementById("dailyReveal");
        if (reveal && reveal.isConnected) reveal.hidden = false;
        showAnswer();
      }, 720);
    } else if (done) {
      showAnswer();
    }
    paintDailyBadge();
  }

  function submitGuess(event, data, iso) {
    event.preventDefault();
    const input = document.getElementById("dailyGuess");
    const guess = parseGuess(input && input.value);
    if (guess == null) { announce("Enter a price above zero."); return; }
    const live = D.nyDateISO(new Date());
    if (live !== iso) { renderDaily(); return; }
    const drop = D.pickDrop(data, iso);
    if (!drop) return;
    const packed = dayState(drop, iso);
    const state = packed.state;
    const day = packed.day;
    if (day.done || (day.guesses || []).length >= D.MAX_GUESSES) return;
    const previous = day.guesses.length ? day.guesses[day.guesses.length - 1] : null;
    const result = D.judgeGuess(guess, day.price, previous);
    if (!result) return;
    day.guesses.push(result.guess);
    const finished = result.band === "hit" || day.guesses.length >= D.MAX_GUESSES;
    if (!day.counted) {
      day.counted = true;
      if (typeof countEvent === "function") countEvent("daily-play");
    }
    if (finished) {
      day.done = true;
      day.solved = result.band === "hit";
      const streak = D.applyStreak(state, iso);
      if (!streak.repeated) {
        state.current = streak.current;
        state.best = streak.best;
        state.lastPlayed = streak.lastPlayed;
      }
      justFinished = true;
      if (typeof logEvent === "function") logEvent("daily", day.id, { day: iso, n: day.n, g: day.guesses.length, ok: day.solved });
      if (typeof playTone === "function") playTone(day.solved ? 740 : 360);
    } else if (day.guesses.length === 1 && typeof logEvent === "function") {
      logEvent("daily", day.id, { day: iso, n: day.n, g: 1 });
      if (typeof playTone === "function") playTone(result.band === "warm" ? 540 : result.band === "cool" ? 420 : 300);
    } else if (typeof playTone === "function") {
      playTone(result.band === "warm" ? 540 : result.band === "cool" ? 420 : 300);
    }
    if (typeof haptic === "function") haptic(result.band === "hit" ? 12 : 6);
    state.days[iso] = day;
    saveState(state);
    announce(D.feedbackLine(result) + (finished ? " Revealed." : ""));
    const root = document.getElementById("dailyScroll");
    if (root) paint(root, data, iso);
  }

  function toggleWish(entry) {
    const card = toCard(entry);
    const saved = (host().wish || []).some(item => item && item.id === card.id);
    if (saved) removeFromWish(card.id);
    else addWish(card);
    renderDaily();
  }

  function toggleOwned(entry) {
    const card = toCard(entry);
    const owned = host().ownedIds && host().ownedIds.has(card.id);
    setOwned(card, !owned, "daily");
    renderDaily();
  }

  function huntLike(card) {
    const box = host();
    const species = box.speciesFor ? box.speciesFor(card.name) : "";
    box.filters = blankFilters();
    if (species) box.filters.names = [species];
    else if (card.setId) box.filters.set = card.setId;
    if (box.binderState && box.binderState.discoveryId) {
      box.binderState.discoveryId = "";
      saveBinders();
    }
    saveFilters();
    showTab("hunt");
    restart();
    announce(species ? "Hunting more like " + species + "." : "Hunting more from " + (card.set || "this set") + ".");
  }

  function copyResult(text) {
    const done = () => announce("Result copied.");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => showShareBox(text));
      return;
    }
    showShareBox(text);
  }

  function showShareBox(text) {
    const box = document.getElementById("dailyShareText");
    if (box) {
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
    }
    announce("Select the result to copy it.");
  }

  function nativeShare(text) {
    if (typeof navigator.share !== "function") { copyResult(text); return; }
    navigator.share({ text }).catch(error => {
      if (error && error.name === "AbortError") return;
      copyResult(text);
    });
  }

  function renderDaily() {
    const root = document.getElementById("dailyScroll");
    if (!root) return;
    const iso = todayISO();
    if (cache) { paint(root, cache, iso); return; }
    root.innerHTML = `<div class="daily-wrap"><p class="fine">Opening today's drop…</p></div>`;
    loadData().then(data => {
      cache = data;
      if (document.getElementById("dailyScroll")) paint(document.getElementById("dailyScroll"), data, todayISO());
    }).catch(() => {
      const node = document.getElementById("dailyScroll");
      if (node) node.innerHTML = `<div class="daily-wrap empty-state"><p>Today's drop didn't load.</p>${typeof toad === "function" ? toad() : ""}</div>`;
    });
  }

  function paintDailyBadge() {
    const iso = todayISO();
    const day = loadState().days[iso];
    const played = !!(day && day.done);
    document.querySelectorAll("[data-tab=daily]").forEach(btn => {
      const dot = btn.querySelector(".dailydot");
      if (!dot) return;
      const here = btn.getAttribute("aria-current") === "page";
      dot.hidden = played || here;
    });
  }

  function setShellQuiet(quiet) {
    const shell = document.getElementById("shell");
    if (!shell) return;
    if (quiet) shell.setAttribute("inert", "");
    else shell.removeAttribute("inert");
  }

  function dismissPrompt() {
    const prompt = document.getElementById("dropPrompt");
    if (prompt) prompt.hidden = true;
    setShellQuiet(false);
    if (typeof syncActs === "function") syncActs();
  }

  function maybePrompt() {
    const onboard = document.getElementById("onboard");
    if (onboard && !onboard.hidden) return;
    if (new URLSearchParams(location.search).get("card")) return;
    const prompt = document.getElementById("dropPrompt");
    if (!prompt || !prompt.hidden) return;
    const iso = todayISO();
    const state = loadState();
    const day = state.days[iso];
    if (day && day.done) return;
    if (state.prompted === iso) return;
    state.prompted = iso;
    saveState(state);
    setShellQuiet(true);
    prompt.hidden = false;
    const play = document.getElementById("dropPlay");
    if (play) play.focus();
    if (typeof syncActs === "function") syncActs();
  }

  window.renderDaily = renderDaily;
  window.paintDailyBadge = paintDailyBadge;

  const play = document.getElementById("dropPlay");
  const later = document.getElementById("dropLater");
  if (play) play.onclick = () => { dismissPrompt(); showTab("daily"); };
  if (later) later.onclick = () => { dismissPrompt(); announce("Today's drop is on the Daily tab."); };
  const next = document.getElementById("onboardNext");
  const skip = document.getElementById("onboardSkip");
  if (next && next.onclick) {
    const orig = next.onclick;
    next.onclick = () => {
      orig();
      const onboard = document.getElementById("onboard");
      if (onboard && onboard.hidden) maybePrompt();
    };
  }
  if (skip && skip.onclick) {
    const orig = skip.onclick;
    skip.onclick = () => { orig(); maybePrompt(); };
  }
  document.addEventListener("keydown", event => {
    const prompt = document.getElementById("dropPrompt");
    if (event.key === "Escape" && prompt && !prompt.hidden) {
      dismissPrompt();
      const state = loadState();
      state.prompted = todayISO();
      saveState(state);
    }
  });
  setInterval(() => {
    const el = document.getElementById("dailyCount");
    if (el) el.textContent = D.formatRemain(D.msUntilNextNyDay(new Date()));
    const iso = todayISO();
    if (shownISO && iso !== shownISO) {
      shownISO = iso;
      paintDailyBadge();
      const view = document.getElementById("viewDaily");
      if (view && !view.hidden) renderDaily();
    }
  }, 1000);
  paintDailyBadge();
  const onboard = document.getElementById("onboard");
  if (!onboard || onboard.hidden) maybePrompt();
})();
