/* Market movers screen. Loaded only after the shelf row is opened.
   Prices come from the cached file already in memory. No network price calls. */
(function () {
  let rootEl = null;
  let hooks = null;
  let token = 0;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function ensureCss() {
    if (document.getElementById("moversCss")) return;
    const link = document.createElement("link");
    link.id = "moversCss";
    link.rel = "stylesheet";
    link.href = "css/movers.css";
    document.head.appendChild(link);
  }

  function shell(status, busy) {
    return `<div class="movers-wrap"><div class="booktools"><button class="chip" id="backMovers" type="button">All binders</button></div><h2 class="movers-title" id="moversTitle">Market movers</h2><p class="movers-lead" id="moversStatus" role="status"${busy ? ' aria-busy="true"' : ""}>${esc(status)}</p></div>`;
  }

  function focusAfter(focusId, hadInside) {
    if (!rootEl) return;
    if (focusId) {
      const kept = document.getElementById(focusId);
      if (kept) { kept.focus(); return; }
    }
    const active = document.activeElement;
    if (active && active !== document.body && !rootEl.contains(active)) return;
    if (hadInside) return;
    const back = document.getElementById("backMovers");
    if (back) back.focus();
  }

  function bindBack() {
    const back = document.getElementById("backMovers");
    if (back && hooks) back.onclick = () => hooks.onBack();
  }

  function badges(row) {
    const bits = [];
    if (row.owned) bits.push(`<span class="mover-badge owned">Owned</span>`);
    if (row.wish) bits.push(`<span class="mover-badge wish">Wishlist</span>`);
    return bits.length ? `<span class="mover-badges">${bits.join("")}</span>` : "";
  }

  function rowButton(row) {
    const M = window.BinderMovers;
    const art = M.artFor(row.id);
    const dollars = M.moneyText(row.delta);
    const now = M.moneyText(row.latest);
    const pct = M.pctText(row.pct);
    if (!dollars || !now || !pct) return "";
    const word = row.dir === "down" ? "Down" : "Up";
    const setLabel = hooks && typeof hooks.setName === "function" ? hooks.setName(row.setId) : "";
    const meta = [setLabel, row.number ? "#" + row.number : "", "over " + row.spanDays + " days"].filter(Boolean).join(" · ");
    const spark = M.sparkSvg(row.points, row.dir, "");
    const thumb = art.thumb || art.img || art.backup;
    const img = thumb
      ? `<img alt="" width="56" height="78" src="${esc(thumb)}" decoding="async">`
      : "";
    const chart = spark ? spark.replace("<svg ", "<svg aria-hidden=\"true\" ") : "";
    return `<li><button type="button" class="mover-row ${row.dir}" data-mover="${esc(row.id)}"><span class="mover-art" data-backup="${esc(art.backup || "")}">${img}</span><span class="mover-copy"><span class="mover-name">${esc(row.name)}</span>${badges(row)}<span class="fine">${esc(meta)}</span>${chart}</span><span class="mover-change ${row.dir}"><b>${esc(word)} ${esc(dollars)}</b><span class="pct">${esc(pct)}</span><span class="fine">Now ${esc(now)}</span></span><span class="sr-only">Open profile</span></button></li>`;
  }

  function column(title, rows, empty) {
    const body = rows.length
      ? `<ul class="movers-list">${rows.map(rowButton).join("")}</ul>`
      : `<p class="movers-empty fine">${esc(empty)}</p>`;
    return `<section class="movers-col" aria-labelledby="${title === "Risers" ? "moversRisers" : "moversFallers"}"><h3 class="movers-h" id="${title === "Risers" ? "moversRisers" : "moversFallers"}">${esc(title)}</h3>${body}</section>`;
  }

  function markup(model) {
    const days = model.days;
    const count = model.risers.length + model.fallers.length;
    const status = count
      ? (model.risers.length + " risers and " + model.fallers.length + " fallers over " + model.label + ". Each window ends on that card's latest cached price.")
      : ("No cards moved at least $1 over " + model.label + " in the cached history. Prices under $1 stay off this list.");
    const checked7 = days === 7 ? "true" : "false";
    const checked30 = days === 30 ? "true" : "false";
    const swipe = count
      ? `<button class="movers-swipe" id="swipeMovers" type="button">Swipe the movers</button>`
      : "";
    return `<div class="movers-wrap" data-movers-ready="1"><div class="booktools"><button class="chip" id="backMovers" type="button">All binders</button></div><h2 class="movers-title" id="moversTitle">Market movers</h2><p class="movers-lead" id="moversStatus" role="status">${esc(status)}</p><div class="movers-tools"><div class="movers-windows" role="radiogroup" aria-label="Price window"><button type="button" role="radio" id="movers7" data-window="7" aria-checked="${checked7}">7 days</button><button type="button" role="radio" id="movers30" data-window="30" aria-checked="${checked30}">30 days</button></div>${swipe}</div><p class="fine">Raw near-mint US dollars from the saved price file. A card needs a price of at least $1 on both ends, and a move of at least $1. Not a live quote.</p><div class="movers-board">${column("Risers", model.risers, "No risers cleared a $1 move in this window.")}${column("Fallers", model.fallers, "No fallers cleared a $1 move in this window.")}</div></div>`;
  }

  function stubFor(row) {
    const card = window.BinderMovers.deckCard(row, hooks && hooks.setName);
    return card;
  }

  function bind(model) {
    if (!rootEl || !hooks) return;
    bindBack();
    const byId = new Map();
    model.risers.concat(model.fallers).forEach(row => byId.set(row.id, row));
    const pick = days => {
      window.BinderMovers.writeDays(hooks.storage, days);
      renderNow(days === 30 ? "movers30" : "movers7");
    };
    rootEl.querySelectorAll("[data-window]").forEach(btn => {
      btn.onclick = () => pick(btn.getAttribute("data-window") === "30" ? 30 : 7);
    });
    const group = rootEl.querySelector(".movers-windows");
    if (group) group.onkeydown = event => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      pick(model.days === 30 ? 7 : 30);
    };
    const swipe = document.getElementById("swipeMovers");
    if (swipe) swipe.onclick = () => {
      const cards = window.BinderMovers.deckCards(model, hooks.setName);
      if (hooks.onSwipe) hooks.onSwipe(cards);
    };
    rootEl.querySelectorAll("[data-mover]").forEach(btn => {
      btn.onclick = () => {
        const row = byId.get(btn.getAttribute("data-mover"));
        const stub = row && stubFor(row);
        if (stub && hooks.onOpen) hooks.onOpen(stub);
      };
    });
    rootEl.querySelectorAll(".mover-art img").forEach(img => {
      img.addEventListener("error", () => {
        const art = img.closest(".mover-art");
        const backup = art && art.dataset ? art.dataset.backup : "";
        if (img.dataset.step !== "backup" && backup) {
          img.dataset.step = "backup";
          img.src = backup;
          return;
        }
        img.remove();
      });
    });
  }

  function renderNow(focusId) {
    if (!rootEl || !hooks || !window.BinderMovers) return;
    const M = window.BinderMovers;
    const days = M.readDays(hooks.storage);
    const top = rootEl.scrollTop;
    const active = document.activeElement;
    const hadInside = !!(active && rootEl.contains(active));
    const keep = focusId || (hadInside && active.id) || "";
    const model = M.list(hooks.cards(), {
      days,
      wishIds: hooks.wishIds ? hooks.wishIds() : [],
      ownedIds: hooks.ownedIds ? hooks.ownedIds() : []
    });
    rootEl.innerHTML = markup(model);
    bind(model);
    rootEl.scrollTop = top;
    focusAfter(keep, hadInside && !keep);
  }

  function paint() {
    if (!rootEl || !hooks || !window.BinderMovers) return;
    ensureCss();
    const my = ++token;
    if (!hooks.ready || !hooks.ready()) {
      rootEl.innerHTML = shell("Reading cached prices…", true);
      bindBack();
      focusAfter("");
      const pending = hooks.load && hooks.load();
      if (pending && typeof pending.then === "function") {
        pending.then(() => { if (my === token) paint(); });
      }
      return;
    }
    const cached = window.BinderMovers.list && rootEl.querySelector("[data-movers-ready]");
    if (!cached) {
      rootEl.innerHTML = shell("Reading cached prices…", true);
      bindBack();
      focusAfter("");
    }
    const run = () => {
      if (my !== token) return;
      renderNow(cached ? "" : "");
    };
    if (!cached && window.requestIdleCallback) requestIdleCallback(run, { timeout: 400 });
    else if (!cached) setTimeout(run, 16);
    else renderNow("");
  }

  function open(el, bridge) {
    rootEl = el;
    hooks = bridge;
    paint();
  }

  window.BinderMoversUI = { open, refresh: paint };
})();
