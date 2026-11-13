/* Buy plan screen. Loaded only after the shelf is opened.
   The budget sheet writes bh.budget.v1. Owned cards go through setOwned. */
(function () {
  let rootEl = null;
  let hooks = null;
  let paintToken = 0;
  let editingId = "";
  let editingValue = "";
  let sawRoll = false;
  let pendingFocus = "";
  const ownedBefore = new Map();

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function cssId(value) {
    const id = String(value || "");
    if (window.CSS && CSS.escape) return CSS.escape(id);
    return id.replace(/[^a-z0-9_-]/gi, "");
  }

  function B() { return window.BinderBudget; }

  function storage() {
    return hooks && hooks.storage ? hooks.storage() : window.localStorage;
  }

  function now() {
    const clock = hooks && hooks.now ? hooks.now() : new Date();
    return clock instanceof Date && !Number.isNaN(clock.getTime()) ? clock : new Date();
  }

  function wishList() {
    const list = hooks && hooks.wish ? hooks.wish() : [];
    return Array.isArray(list) ? list : [];
  }

  function cards() {
    return hooks && hooks.cards ? hooks.cards() : {};
  }

  function targets() {
    try { return hooks && hooks.targets ? hooks.targets() : {}; }
    catch (e) { return {}; }
  }

  function owned(id) {
    try { return !!(hooks && hooks.owned && hooks.owned(id)); }
    catch (e) { return false; }
  }

  function focusPending() {
    if (!pendingFocus || !rootEl) return;
    const sels = pendingFocus.split("||");
    pendingFocus = "";
    for (let i = 0; i < sels.length; i++) {
      const el = rootEl.querySelector(sels[i].trim());
      if (el && el.focus) { el.focus(); return; }
    }
  }

  function ring(pct, label) {
    const c = 2 * Math.PI * 15.5;
    const shown = Math.max(0, Math.min(100, pct));
    const dash = (shown / 100) * c;
    return `<svg class="ring" viewBox="0 0 42 42" aria-hidden="true"><circle class="ring-track" cx="21" cy="21" r="15.5"></circle><circle class="ring-val" cx="21" cy="21" r="15.5" stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"></circle><text x="21" y="22" text-anchor="middle" dominant-baseline="central">${esc(label)}</text></svg>`;
  }

  function metaLine(card) {
    if (!card) return "";
    const set = typeof card.set === "string" ? card.set.replace(/\s+/g, " ").trim() : "";
    const number = card.number == null ? "" : String(card.number).replace(/\s+/g, " ").trim();
    const bits = [];
    if (set && set !== "undefined" && set !== "NaN") bits.push(set);
    if (number && number !== "undefined" && number !== "NaN") bits.push("#" + number);
    return bits.join(" · ");
  }

  function rowsFor(state) {
    const bought = new Set((state && state.purchases || []).map(row => row.id));
    const table = targets() || {};
    const cache = cards() || {};
    return wishList().map(card => {
      const id = card && typeof card.id === "string" ? card.id : "";
      const quote = id && Object.prototype.hasOwnProperty.call(cache, id) ? B().quoteRecord(cache[id]) : null;
      const target = id && table[id] && table[id].price != null ? table[id].price : null;
      return {
        id: id,
        name: card && card.name,
        market: quote ? quote.market : null,
        target: target,
        cheapPct: quote ? quote.cheapPct : 0,
        owned: owned(id),
        purchased: bought.has(id)
      };
    });
  }

  function meter(state) {
    const left = B().remaining(state);
    const used = B().spent(state);
    const amountText = B().moneyText(state.amount);
    const month = B().monthLabel(state.month) || "This month";
    if (left == null || used == null || !amountText) return "";
    const over = left < 0;
    const overText = over ? B().moneyText(Math.abs(left)) : "";
    const leftText = left > 0 ? B().moneyText(left) : "";
    const spentText = used >= 0.01 ? B().moneyText(used) : "";
    const spentPct = state.amount > 0 ? Math.max(0, Math.min(100, Math.round(used / state.amount * 100))) : 0;
    const leftPct = left > 0 && state.amount > 0 ? Math.max(0, Math.min(100, Math.round(left / state.amount * 100))) : 0;
    let ringPct = leftPct > 0 ? leftPct : (left > 0 ? 1 : 0);
    let ringWord = leftPct >= 1 ? leftPct + "%" : "Left";
    let headline = "";
    let detail = "";
    let spoken = "";
    if (over && overText) {
      ringPct = 100;
      ringWord = "Past";
      headline = "Past by " + overText;
      detail = "A little past " + month + ". That's okay. Next month starts fresh.";
      spoken = "A little past " + month + " by " + overText + ". The monthly budget is " + amountText + ".";
    } else if (left === 0) {
      ringPct = 0;
      ringWord = "Done";
      headline = month + " is used up";
      detail = "The number you picked is " + amountText + ". Next month starts fresh.";
      spoken = month + " is used up. The monthly budget is " + amountText + ".";
    } else if (!spentText && leftText) {
      ringPct = 100;
      ringWord = "All";
      headline = leftText + " left";
      detail = "All of " + amountText + " is still here for " + month + ".";
      spoken = leftText + " left of " + amountText + " for " + month + ".";
    } else if (leftText) {
      headline = leftText + " left";
      detail = spentText ? "Paid " + spentText + " of " + amountText + " in " + month + "." : amountText + " for " + month + ".";
      spoken = leftText + " left of " + amountText + " for " + month + ".";
    }
    if (!headline || !spoken) return "";
    const barPct = over ? 100 : spentPct;
    const roll = sawRoll ? `<p class="fine">It's a new month. Your number stayed, and the buys start over.</p>` : "";
    const undo = state.purchases.length
      ? `<button class="plan-undo" id="planUndo" type="button">Undo last buy</button>`
      : "";
    return `<section class="plan-head${over ? " over" : ""}" aria-labelledby="planMeterLabel">
      <div class="plan-meter">
        ${ring(ringPct, ringWord)}
        <div class="plan-meter-copy">
          <p class="eyebrow" id="planMeterLabel">${esc(month)}</p>
          <p class="plan-left">${esc(headline)}</p>
          <p class="fine">${esc(detail)}</p>
        </div>
      </div>
      <div class="plan-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${barPct}" aria-valuetext="${esc(spoken)}" aria-labelledby="planMeterLabel"><span style="width:${barPct}%"></span></div>
      ${roll}
      <div class="plan-tools">
        <button class="plan-change" id="planChange" type="button" aria-haspopup="dialog" aria-controls="budgetSheet">Change budget</button>
        ${undo}
      </div>
    </section>`;
  }

  function fitPill(item) {
    if (item.fits) return `<span class="plan-fit">Fits</span>`;
    return `<span class="plan-fit later">Next month</span>`;
  }

  function priceBlock(item) {
    const money = B().moneyText(item.market);
    if (!money) return `<p class="plan-price missing">No price yet</p>`;
    return `<p class="plan-price">${esc(money)}</p>${fitPill(item)}`;
  }

  function extraLines(item) {
    const lines = [];
    const goal = item.target != null ? B().moneyText(item.target) : "";
    if (goal) lines.push("Target " + goal);
    const drop = B().pctText(item.cheapPct);
    if (drop) lines.push("Down " + drop + " versus recent history");
    return lines.filter(line => line && !/NaN|undefined|\$0(?:\.00)?\b/.test(line));
  }

  function cardMarkup(item, card, mode) {
    const name = B().cleanName(item.name) || "Card";
    const meta = metaLine(card);
    const extras = extraLines(item);
    const editing = editingId === item.id;
    const paid = editing ? editingValue : "";
    let action = "";
    if (item.market != null && !editing) {
      action = `<button class="plan-buy" type="button" data-plan-buy="${esc(item.id)}" aria-label="${esc("I bought it, " + name)}">I bought it</button>`;
    } else if (editing) {
      const market = B().moneyText(item.market);
      const stateNow = B().read(storage(), now());
      const leftNow = stateNow ? B().remaining(stateNow) : null;
      const paidNow = B().parsePrice(paid);
      const hint = paidNow != null && leftNow != null && paidNow > leftNow
        ? "That's a little more than what's left. Saving it is okay."
        : (market
          ? "Prefilled with the cached market " + market + ". Change it if you paid something else."
          : "Enter the price you paid.");
      action = `<form class="plan-pay" data-plan-form="${esc(item.id)}">
        <label for="planPaid">Price paid<input id="planPaid" name="paid" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" spellcheck="false" maxlength="10" value="${esc(paid)}" aria-describedby="planPayHint"></label>
        <button class="plan-save" type="submit" aria-label="${esc("Save purchase of " + name)}">Save purchase</button>
        <button class="plan-later" type="button" data-plan-cancel="${esc(item.id)}" aria-label="${esc("Cancel purchase of " + name)}">Cancel</button>
        <p class="fine" id="planPayHint">${esc(hint)}</p>
        <p class="plan-error" id="planPayError" hidden></p>
      </form>`;
    }
    const openLabel = "Open " + name;
    return `<li><article class="plan-card ${mode}" data-plan-card="${esc(item.id)}">
      <button class="plan-open" type="button" data-plan-open="${esc(item.id)}" aria-label="${esc(openLabel)}"><span class="plan-art" data-plan-art="${esc(item.id)}"></span></button>
      <div class="plan-body">
        <div class="plan-top">${priceBlock(item)}</div>
        <p class="plan-name">${esc(name)}</p>
        ${meta ? `<p class="plan-meta fine">${esc(meta)}</p>` : ""}
        ${extras.map(line => `<p class="fine">${esc(line)}</p>`).join("")}
        ${action}
      </div>
    </article></li>`;
  }

  function boughtMarkup(state, byId) {
    if (!state || !state.purchases.length) return "";
    const items = state.purchases.slice().reverse().map(row => {
      const paid = B().moneyText(row.price);
      if (!paid) return "";
      const card = byId.get(row.id) || { id: row.id, name: row.id };
      const name = B().cleanName(card.name) || "Card";
      return `<li><article class="plan-card" data-plan-bought="${esc(row.id)}">
        <button class="plan-open" type="button" data-plan-open="${esc(row.id)}" aria-label="${esc("Open " + name)}"><span class="plan-art" data-plan-art="${esc(row.id)}"></span></button>
        <div class="plan-body">
          <p class="plan-price">${esc(paid)}</p>
          <p class="plan-name">${esc(name)}</p>
          <p class="fine">Paid this month</p>
          <button class="plan-undo" type="button" data-plan-undo="${esc(row.id)}" aria-label="${esc("Undo purchase of " + name)}">Undo</button>
        </div>
      </article></li>`;
    }).filter(Boolean);
    if (!items.length) return "";
    return `<section class="plan-section" aria-labelledby="planBoughtTitle"><h3 class="plan-h" id="planBoughtTitle">Bought this month</h3><ul class="plan-list">${items.join("")}</ul></section>`;
  }

  function section(id, title, items, byId, mode) {
    if (!items.length) return "";
    const body = items.map(item => cardMarkup(item, byId.get(item.id), mode)).join("");
    return `<section class="plan-section" aria-labelledby="${id}"><h3 class="plan-h" id="${id}">${esc(title)}</h3><ul class="plan-list">${body}</ul></section>`;
  }

  function emptyDeck() {
    return `<section class="plan-empty"><h3>The deck is the start</h3><p>Swipe right on a card you want. It lands on your wishlist, and the ones that fit this month show up here, one card at a time.</p><button class="plan-save" id="planHunt" type="button">Open the deck</button></section>`;
  }

  function invite() {
    return `<section class="plan-head invite"><p class="kicker">This month</p><h2 class="plan-title" id="planTitle">Pick a number</h2><p>Choose a monthly budget you can stick with. Wishlist cards that fit what's left show up here, one card at a time.</p><button class="plan-save" id="planSet" type="button" aria-haspopup="dialog" aria-controls="budgetSheet">Set a monthly budget</button></section>`;
  }

  function markup(state, priced) {
    const title = `<div class="booktools"><button class="chip" id="planBack" type="button">All binders</button></div>`;
    if (!state) {
      const wish = wishList();
      const empty = wish.length ? "" : emptyDeck();
      return `<div class="plan-wrap">${title}${invite()}${empty}</div>`;
    }
    const byId = new Map();
    wishList().forEach(card => { if (card && card.id && !byId.has(card.id)) byId.set(card.id, card); });
    const head = `<p class="kicker">Buy plan</p><h2 class="plan-title" id="planTitle">One card at a time</h2>`;
    if (!priced) {
      return `<div class="plan-wrap">${title}${head}${meter(state)}<p class="plan-wait" role="status">Checking cached prices…</p></div>`;
    }
    const picked = B().selectFits(rowsFor(state), B().remaining(state));
    const bought = boughtMarkup(state, byId);
    const fits = section("planFitsTitle", "Fits this month", picked.fits, byId, "fits");
    const waiting = section("planWaitTitle", "When there's room", picked.waiting, byId, "over-card");
    const unpriced = section("planGapTitle", "No price yet", picked.unpriced, byId, "");
    const nothingLeft = !picked.fits.length && !picked.waiting.length && !picked.unpriced.length;
    let note = "";
    if (!wishList().length && !state.purchases.length) note = emptyDeck();
    else if (!wishList().length) note = `<p class="fine">The wishlist is clear. The deck has more whenever you want another card.</p><button class="plan-save" id="planHunt" type="button">Open the deck</button>`;
    else if (!picked.fits.length && picked.waiting.length) note = `<p class="fine">Nothing else fits what's left. These can wait for next month, or you can still write down a buy.</p>`;
    else if (nothingLeft) note = `<p class="fine">Everything saved is already in your hands. The deck has the next one.</p><button class="plan-save" id="planHunt" type="button">Open the deck</button>`;
    return `<div class="plan-wrap">${title}${head}${meter(state)}${bought}${note}${fits}${waiting}${unpriced}</div>`;
  }

  function paintArt(host, card) {
    if (!host) return;
    if (hooks && hooks.paintArt && card) {
      hooks.paintArt(host, card);
      const img = host.querySelector("img");
      if (img) img.alt = "";
      return;
    }
    host.innerHTML = `<span class="plan-art" aria-hidden="true"></span>`;
  }

  function showPayError(text) {
    const err = document.getElementById("planPayError");
    if (!err) return;
    err.hidden = false;
    err.textContent = text;
    const input = document.getElementById("planPaid");
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
    if (hooks && hooks.announce) hooks.announce(text);
  }

  function speakBuy(name, state) {
    const left = B().remaining(state);
    const who = B().cleanName(name) || "Card";
    if (left == null) return who + " is saved.";
    if (left < 0) {
      const over = B().moneyText(Math.abs(left));
      return over ? who + " is saved. A little past this month by " + over + "." : who + " is saved.";
    }
    if (left === 0) return who + " is saved. This month's number is used up.";
    const money = B().moneyText(left);
    return money ? who + " is saved. " + money + " left this month." : who + " is saved.";
  }

  function undo(id) {
    const result = B().undoPurchase(storage(), id || "", now());
    if (!result) {
      if (hooks && hooks.announce) hooks.announce("Nothing to undo.");
      return;
    }
    const before = ownedBefore.get(result.removed.id);
    editingId = "";
    pendingFocus = "#planChange, #planSet, #planBack";
    const shouldRelease = before !== true;
    const released = shouldRelease && hooks && hooks.own ? hooks.own(byCard(result.removed.id), false) : false;
    if (!released) paint();
    const name = B().cleanName((byCard(result.removed.id) || {}).name) || "Card";
    if (hooks && hooks.announce) hooks.announce(name + " is back on the plan.");
  }

  function byCard(id) {
    return wishList().find(card => card && card.id === id) || { id: id, name: "" };
  }

  function buy(id, raw) {
    const price = B().parsePrice(raw);
    if (price == null || !B().moneyText(price)) {
      showPayError("Enter the price you paid, above one cent.");
      return;
    }
    const card = byCard(id);
    const wasOwned = owned(id);
    const result = B().recordPurchase(storage(), { id: id, price: price }, now());
    if (!result) {
      showPayError("That buy didn't save. Try the price again.");
      return;
    }
    ownedBefore.set(id, wasOwned);
    editingId = "";
    editingValue = "";
    pendingFocus = "#planUndo";
    if (!wasOwned && hooks && hooks.own) hooks.own(card, true);
    else paint();
    const line = speakBuy(card.name, result.state);
    if (hooks && hooks.announce) hooks.announce(line);
  }

  function bind() {
    if (!rootEl) return;
    const back = document.getElementById("planBack");
    if (back) back.onclick = () => { if (hooks && hooks.onBack) hooks.onBack(); };
    const setBtn = document.getElementById("planSet");
    if (setBtn) setBtn.onclick = () => openSheet(false);
    const change = document.getElementById("planChange");
    if (change) change.onclick = () => openSheet(true);
    const hunt = document.getElementById("planHunt");
    if (hunt) hunt.onclick = () => { if (hooks && hooks.goHunt) hooks.goHunt(); };
    const last = document.getElementById("planUndo");
    if (last) last.onclick = () => undo("");
    const byId = new Map();
    wishList().forEach(card => { if (card && card.id) byId.set(card.id, card); });
    rootEl.querySelectorAll("[data-plan-art]").forEach(host => {
      const card = byId.get(host.getAttribute("data-plan-art")) || { id: host.getAttribute("data-plan-art"), name: "" };
      paintArt(host, card);
    });
    rootEl.querySelectorAll("[data-plan-open]").forEach(btn => {
      btn.onclick = () => {
        const card = byId.get(btn.getAttribute("data-plan-open"));
        if (card && hooks && hooks.open) hooks.open(card);
      };
    });
    rootEl.querySelectorAll("[data-plan-buy]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-plan-buy");
        const row = rowsFor(B().read(storage(), now())).find(item => item.id === id);
        const market = row ? B().cents(row.market) : null;
        editingId = id;
        editingValue = market != null ? market.toFixed(2) : "";
        pendingFocus = "#planPaid";
        if (hooks && hooks.pop) hooks.pop(btn);
        paint();
      };
    });
    rootEl.querySelectorAll("[data-plan-undo]").forEach(btn => {
      btn.onclick = () => undo(btn.getAttribute("data-plan-undo"));
    });
    rootEl.querySelectorAll("[data-plan-form]").forEach(form => {
      const id = form.getAttribute("data-plan-form");
      form.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        editingId = "";
        pendingFocus = '[data-plan-buy="' + cssId(id) + '"]';
        paint();
      });
      form.onsubmit = event => {
        event.preventDefault();
        const input = document.getElementById("planPaid");
        buy(id, input ? input.value : "");
      };
      const input = form.querySelector("input");
      if (input) input.addEventListener("input", () => {
        editingValue = input.value;
        const hint = document.getElementById("planPayHint");
        if (!hint) return;
        const state = B().read(storage(), now());
        const left = state ? B().remaining(state) : null;
        const paid = B().parsePrice(input.value);
        const row = rowsFor(state).find(item => item.id === id);
        const market = row ? B().moneyText(row.market) : "";
        if (paid != null && left != null && paid > left) hint.textContent = "That's a little more than what's left. Saving it is okay.";
        else if (market) hint.textContent = "Prefilled with the cached market " + market + ". Change it if you paid something else.";
        else hint.textContent = "Enter the price you paid.";
      });
    });
    const cancel = rootEl.querySelector("[data-plan-cancel]");
    if (cancel) cancel.onclick = () => {
      const id = cancel.getAttribute("data-plan-cancel");
      editingId = "";
      pendingFocus = '[data-plan-buy="' + cssId(id) + '"]';
      paint();
    };
    focusPending();
  }

  function sheetCopy(editing) {
    const hint = editing
      ? "Change the number for this month. Buys you already wrote down stay put."
      : "A number you can stick with, in US dollars. It rolls over on the first of the month, and it stays in this browser.";
    const label = editing ? "Update budget" : "Save budget";
    return `<form id="budgetForm">
      <label class="field" for="budgetAmount">Monthly budget<input id="budgetAmount" name="amount" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" spellcheck="false" maxlength="12" aria-describedby="budgetHint"></label>
      <p class="fine" id="budgetHint">${esc(hint)}</p>
      <p class="plan-error" id="budgetError" hidden></p>
      <div class="plan-actions">
        <button class="plan-skip" id="budgetCancel" type="button">Not now</button>
        <button class="plan-save" id="budgetSave" type="submit">${esc(label)}</button>
      </div>
    </form>`;
  }

  function showBudgetError(text) {
    const err = document.getElementById("budgetError");
    if (!err) return;
    err.hidden = false;
    err.textContent = text;
    const input = document.getElementById("budgetAmount");
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
    if (hooks && hooks.announce) hooks.announce(text);
  }

  function amountError(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw || /nan|infinity|undefined|null/i.test(raw)) return "Enter a monthly number above one cent.";
    if (B().parsePrice(raw)) return "";
    const cleaned = raw.replace(/[$,\s]/g, "");
    const asNumber = Number(cleaned);
    if (/^\d+(\.\d+)?$/.test(cleaned) && Number.isFinite(asNumber) && asNumber >= 1000000) return "That number is a bit big. Try a smaller monthly budget.";
    if (/^\d+(\.\d+)?$/.test(cleaned) && Number.isFinite(asNumber) && asNumber < 0.01) return "Enter a monthly number above one cent.";
    return "Use a dollar amount like 50 or 50.00.";
  }

  function openSheet(editing) {
    const body = document.getElementById("budgetBody");
    const done = document.getElementById("budgetDone");
    if (!body) return;
    const state = B().read(storage(), now());
    body.innerHTML = sheetCopy(!!(editing && state));
    const input = document.getElementById("budgetAmount");
    if (input && editing && state) input.value = state.amount.toFixed(2);
    const close = () => { if (hooks && hooks.closeSheet) hooks.closeSheet(); };
    const cancel = document.getElementById("budgetCancel");
    if (cancel) cancel.onclick = close;
    if (done) done.onclick = close;
    const form = document.getElementById("budgetForm");
    if (form) form.onsubmit = event => {
      event.preventDefault();
      const field = document.getElementById("budgetAmount");
      const problem = amountError(field ? field.value : "");
      if (problem) { showBudgetError(problem); return; }
      const amount = B().parsePrice(field ? field.value : "");
      const saved = B().setBudget(storage(), amount, now());
      const shown = saved ? B().moneyText(saved.amount) : "";
      if (!saved || !shown) { showBudgetError("The budget didn't save. Try that number again."); return; }
      if (hooks && hooks.pop) hooks.pop(document.getElementById("budgetSave"));
      if (hooks && hooks.closeSheet) hooks.closeSheet();
      pendingFocus = "#planChange";
      paint();
      const month = B().monthLabel(saved.month) || "this month";
      if (hooks && hooks.announce) hooks.announce("Monthly budget set to " + shown + " for " + month + ".");
    };
    if (hooks && hooks.openSheet) hooks.openSheet();
    if (input) input.focus();
  }

  function paint() {
    if (!rootEl || !B()) return;
    if (editingId) {
      const field = document.getElementById("planPaid");
      if (field) editingValue = field.value;
      if (!pendingFocus && document.activeElement === field) pendingFocus = "#planPaid";
    }
    const token = ++paintToken;
    const state = B().read(storage(), now());
    if (state && state.rolled) sawRoll = true;
    const ready = !!(hooks && hooks.ready && hooks.ready());
    if (state && !ready) {
      rootEl.innerHTML = markup(state, false);
      bind();
      const pending = hooks && hooks.load ? hooks.load() : null;
      if (pending && pending.then) pending.then(() => { if (token === paintToken) paint(); });
      return;
    }
    rootEl.innerHTML = markup(state, true);
    bind();
    if (state && hooks && hooks.ensureTargets && !window.BinderTargets) {
      const pending = hooks.ensureTargets();
      if (pending && pending.then) pending.then(() => { if (token === paintToken && !editingId) paint(); });
    }
  }

  function open(el, nextHooks) {
    rootEl = el;
    hooks = nextHooks || hooks;
    paint();
  }

  window.BinderBudgetUI = { open: open, refresh: paint };
})();
