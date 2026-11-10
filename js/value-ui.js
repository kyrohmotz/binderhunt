/* Collection value screen. Loaded only after the Value tab is opened. */
(function () {
  let rootEl = null;
  let baseline;
  let lastAnnounce = "";
  let paintToken = 0;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function ensureCss() {
    if (document.getElementById("valueCss")) return;
    const link = document.createElement("link");
    link.id = "valueCss";
    link.rel = "stylesheet";
    link.href = "css/value.css";
    document.head.appendChild(link);
  }

  function portfolio() {
    const V = window.BinderValue;
    const owned = typeof ownedIds !== "undefined" && ownedIds ? [...ownedIds] : [];
    const saved = typeof wish !== "undefined" && Array.isArray(wish) ? wish : [];
    const cards = typeof scrydex !== "undefined" && scrydex && scrydex.cards ? scrydex.cards : {};
    return V.build({ cards, ownedIds: owned, wishIds: saved.map(card => card && card.id).filter(Boolean) });
  }

  function priceHtml(part) {
    if (part.tiny) return `<p class="market-price">Under one cent</p>`;
    const text = window.BinderValue.moneyText(part.total);
    if (!text) return `<p class="market-price value-missing">No price yet</p>`;
    return `<p class="market-price">${esc(text)}</p>`;
  }

  function moveHtml(part) {
    const V = window.BinderValue;
    return `<ul class="value-moves">
      <li><span>7 days</span><b class="${part.move7 && part.move7.dir === "down" ? "down" : ""}">${esc(V.moveLine(part.move7, 7))}</b></li>
      <li><span>30 days</span><b class="${part.move30 && part.move30.dir === "down" ? "down" : ""}">${esc(V.moveLine(part.move30, 30))}</b></li>
    </ul>`;
  }

  function rowButton(item) {
    const V = window.BinderValue;
    const stub = V.cardStub(item);
    const money = V.moneyText(item.delta);
    const pct = item.pct >= 0.1 ? item.pct.toFixed(1) + "%" : "";
    const word = item.dir === "down" ? "Down" : "Up";
    const where = item.bucket === "wish" ? "Wishlist" : "Owned";
    const windowLabel = item.window === 7 ? "7 days" : "30 days";
    const thumb = stub.thumb
      ? `<img alt="" width="36" height="50" src="${esc(stub.thumb)}" decoding="async" loading="lazy">`
      : `<span class="value-art" aria-hidden="true"></span>`;
    return `<button type="button" class="value-row ${item.dir}" data-value-card="${esc(item.id)}">
      ${thumb}
      <span class="value-copy"><b>${esc(item.name)}</b><span class="fine">${esc(where)} · ${esc(windowLabel)}</span></span>
      <span class="value-delta ${item.dir}">${esc(word)} ${esc(money)}${pct ? `<small>${esc(pct)}</small>` : ""}</span>
      <span class="sr-only">Open card</span>
    </button>`;
  }

  function moverBlock(title, items, empty) {
    const body = items.length ? items.map(rowButton).join("") : `<p class="fine">${esc(empty)}</p>`;
    return `<section class="value-card"><h3 class="value-h">${esc(title)}</h3>${body}</section>`;
  }

  function markup(data, report) {
    const V = window.BinderValue;
    const owned = data.owned;
    const wish = data.wish;
    const missing = V.unpricedLine(owned.rows.concat(wish.rows));
    let ownedCard = "";
    if (!owned.ids.length) {
      ownedCard = `<section class="value-card value-empty"><h3 class="value-h">Nothing in your hands yet</h3><p>Swipe through Hunt, then tap Got it! on a card you own. The total lands here.</p><button class="go" type="button" id="valueHunt">Start swiping</button></section>`;
    } else {
      ownedCard = `<section class="value-card value-owned" aria-labelledby="valueOwnedLabel"><p class="eyebrow" id="valueOwnedLabel">Owned</p>${priceHtml(owned)}<p class="fine">${esc(V.coverageLine(owned, "owned"))}</p>${owned.total ? moveHtml(owned) : ""}<p class="fine">${esc(V.visitLine(report, "owned"))}</p></section>`;
    }
    let wishCard = "";
    if (!owned.ids.length && !wish.ids.length) {
      wishCard = "";
    } else if (!wish.ids.length) {
      wishCard = `<section class="value-card value-wish" aria-labelledby="valueWishLabel"><p class="eyebrow" id="valueWishLabel">Wishlist</p><p class="fine">${esc(V.finishLine(wish))}</p></section>`;
    } else {
      wishCard = `<section class="value-card value-wish" aria-labelledby="valueWishLabel"><p class="eyebrow" id="valueWishLabel">Wishlist</p>${priceHtml(wish)}<p class="fine">${esc(V.finishLine(wish))}</p><p class="fine">${esc(V.coverageLine(wish, "wishlist"))}</p>${wish.total ? moveHtml(wish) : ""}<p class="fine">${esc(V.visitLine(report, "wish"))}</p></section>`;
    }
    const sparkNote = V.sparkCaption(owned.spark);
    const spark = owned.ids.length ? `<section class="value-card" aria-label="Owned value over time"><h3 class="value-h">Over time</h3><div class="chart-wrap">${V.sparkSvg(owned.spark) || ""}<p class="fine">${esc(sparkNote)}</p></div></section>` : "";
    const gap = missing ? `<p class="value-gap" role="status">${esc(missing)}</p>` : "";
    const gainers = moverBlock("Biggest gainers", data.movers.gainers, "No gainers in the cached history yet.");
    const decliners = moverBlock("Biggest decliners", data.movers.decliners, "No decliners in the cached history yet.");
    const movers = (owned.ids.length || wish.ids.length) ? gainers + decliners : "";
    const bothEmpty = !owned.ids.length && !wish.ids.length;
    const intro = bothEmpty
      ? `<p class="fine">A right swipe saves a card, and Got it! marks one you own. Both totals show up here.</p>`
      : `<p class="fine">Raw near-mint prices, in US dollars, from the cached history. Estimates, not financial advice.</p>`;
    return `<div class="value-wrap"><p class="kicker">Your cards</p><h2 class="value-title">Collection value</h2>${intro}<div class="value-pair">${ownedCard}${wishCard}</div>${gap}${spark}${movers}</div>`;
  }

  function summary(data) {
    const V = window.BinderValue;
    const owned = V.moneyText(data.owned.total);
    const wish = V.moneyText(data.wish.total);
    const missing = V.unpricedLine(data.owned.rows.concat(data.wish.rows));
    if (!data.owned.ids.length && !data.wish.ids.length) return "Collection value. Nothing owned yet. Start swiping, then tap Got it.";
    const bits = ["Collection value."];
    if (owned) bits.push("Owned " + owned + ".");
    else if (data.owned.ids.length) bits.push("Owned cards have no price yet.");
    else bits.push("Nothing owned yet.");
    if (wish) bits.push("Wishlist " + wish + ".");
    if (missing) bits.push(missing);
    return bits.join(" ");
  }

  function bind(data) {
    if (!rootEl) return;
    const hunt = document.getElementById("valueHunt");
    if (hunt) hunt.onclick = () => { if (typeof showTab === "function") showTab("hunt"); };
    const byId = new Map();
    data.owned.rows.concat(data.wish.rows).forEach(row => { if (!byId.has(row.id)) byId.set(row.id, row); });
    rootEl.querySelectorAll("[data-value-card]").forEach(btn => {
      btn.onclick = () => {
        const row = byId.get(btn.getAttribute("data-value-card"));
        if (!row || typeof openProfile !== "function") return;
        openProfile(window.BinderValue.cardStub(row));
      };
    });
    rootEl.querySelectorAll("img").forEach(img => {
      img.addEventListener("error", () => {
        const span = document.createElement("span");
        span.className = "value-art";
        span.setAttribute("aria-hidden", "true");
        img.replaceWith(span);
      });
    });
  }

  function render() {
    if (!rootEl || !window.BinderValue) return;
    ensureCss();
    const token = ++paintToken;
    if (typeof scrydex === "undefined" || !scrydex || !scrydex.ready) {
      rootEl.innerHTML = `<p class="value-wait" role="status">Adding up cached prices…</p>`;
      if (typeof loadScrydex === "function") {
        const pending = loadScrydex();
        if (pending && typeof pending.then === "function") {
          pending.then(() => { if (token === paintToken && tab === "value") render(); });
        }
      }
      return;
    }
    const data = portfolio();
    if (baseline === undefined) baseline = window.BinderValue.readSnapshot(window.localStorage);
    const report = window.BinderValue.visitDelta(baseline, data);
    window.BinderValue.writeSnapshot(window.localStorage, data, Date.now());
    rootEl.innerHTML = markup(data, report);
    bind(data);
    const spoken = summary(data);
    if (spoken && spoken !== lastAnnounce && typeof announce === "function") {
      lastAnnounce = spoken;
      announce(spoken);
    }
  }

  function open(el) {
    rootEl = el;
    render();
  }

  window.BinderValueUI = { open, refresh: render };
})();
