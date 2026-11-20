/* Rip a pack screen. Loaded only after the Rip tab is opened.
   Wishlist saves go through addWish, the same path as a right swipe. */
(function () {
  const R = window.BinderRips;
  if (!R) return;

  let hostEl = null;
  let seedText = "";
  let pool = [];
  let dailyData = null;
  let filesPromise = null;
  let catalog = null;
  let screen = "picker";
  let query = "";
  let pack = null;
  let bonus = false;
  let index = 0;
  let faceUp = false;
  let logged = false;
  let opening = false;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function motionOff() {
    if (typeof reduceMotion === "function") return !!reduceMotion();
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  function dayKey() {
    if (window.BinderDaily && typeof BinderDaily.nyDateISO === "function") return BinderDaily.nyDateISO(new Date());
    return "";
  }

  function storage() {
    try { return window.localStorage; }
    catch (e) { return null; }
  }

  function readLog() {
    return R.loadLog(storage());
  }

  function writeLog(state) {
    R.saveLog(storage(), state);
  }

  function wished(id) {
    if (typeof wish === "undefined" || !Array.isArray(wish)) return false;
    return wish.some(card => card && card.id === id);
  }

  function announceTo(text) {
    if (typeof announce === "function") announce(text);
  }

  function namesFromMeta() {
    const names = {};
    if (typeof meta !== "undefined" && meta && Array.isArray(meta.sets)) {
      meta.sets.forEach(set => {
        if (set && set.id && set.name) names[set.id] = set.name;
      });
    }
    return names;
  }

  function extrasFromCache() {
    const extras = [];
    if (typeof cardCache !== "undefined" && cardCache && typeof cardCache.forEach === "function") {
      cardCache.forEach(card => { if (card && card.id) extras.push(card); });
    }
    return extras;
  }

  function rebuild() {
    const cards = typeof scrydex !== "undefined" && scrydex && scrydex.cards ? scrydex.cards : {};
    catalog = R.buildCatalog({
      cards,
      seedText,
      pool,
      extras: extrasFromCache(),
      names: namesFromMeta()
    });
    if (pack && catalog) {
      pack.cards.forEach(card => {
        const fresh = catalog.byId.get(card.id);
        if (!fresh) return;
        card.price = fresh.price;
        card.priceLabel = fresh.priceLabel || R.priceLabel(fresh.price);
        if (!card.name && fresh.name) card.name = fresh.name;
      });
      pack.value = R.packValue(pack.cards);
      pack.best = R.bestCard(pack.cards);
    }
  }

  function loadFiles() {
    if (filesPromise) return filesPromise;
    filesPromise = Promise.all([
      fetch("data/scrydex-seed.txt", { cache: "no-cache" }).then(res => res.ok ? res.text() : "").catch(() => ""),
      fetch("data/daily.json", { cache: "no-cache" }).then(res => res.ok ? res.json() : null).catch(() => null)
    ]).then(pair => {
      seedText = pair[0] || "";
      dailyData = pair[1];
      pool = dailyData && Array.isArray(dailyData.pool) ? dailyData.pool : [];
      rebuild();
    }).catch(() => {
      filesPromise = null;
    });
    return filesPromise;
  }

  function preferSet() {
    if (!dailyData || !window.BinderDaily || typeof BinderDaily.pickDrop !== "function") return "";
    const drop = BinderDaily.pickDrop(dailyData, dayKey());
    return drop && drop.card && drop.card.setId ? drop.card.setId : "";
  }

  function setsMatching() {
    const sets = R.listSets(catalog);
    const q = query.trim().toLowerCase();
    if (!q) return sets;
    return sets.filter(set => set.name.toLowerCase().indexOf(q) !== -1 || set.id.toLowerCase().indexOf(q) !== -1 || set.era.toLowerCase().indexOf(q) !== -1);
  }

  function inPack() {
    return screen !== "picker";
  }

  function contextLabel() {
    return "Rip";
  }

  function sideText() {
    const log = readLog();
    const best = log.best;
    if (!best) return "No best pull yet. Tear a pack and the biggest hit lands here.";
    const price = R.priceLabel(best.price);
    return (best.name || "A card") + " · " + price;
  }

  function focusId(id) {
    const node = document.getElementById(id);
    if (node && typeof node.focus === "function") node.focus();
  }

  function bindArt(img, card) {
    const urls = [];
    if (card.thumb) urls.push(card.thumb);
    if (card.img && urls.indexOf(card.img) === -1) urls.push(card.img);
    if (card.backup && urls.indexOf(card.backup) === -1) urls.push(card.backup);
    let step = 0;
    const fail = () => {
      step += 1;
      if (urls[step]) {
        img.src = urls[step];
        return;
      }
      const ph = document.createElement("span");
      ph.className = "rip-ph";
      ph.textContent = card.name || "Card";
      img.replaceWith(ph);
    };
    img.addEventListener("error", fail);
    if (!urls.length) fail();
    else img.src = urls[0];
  }

  function paintArts(root) {
    root.querySelectorAll("img[data-rip-art]").forEach(img => {
      const id = img.getAttribute("data-rip-art");
      const card = (pack && pack.cards.find(item => item.id === id)) || (catalog && catalog.byId.get(id));
      if (card) bindArt(img, card);
    });
  }

  function toWish(card) {
    return {
      id: card.id,
      name: card.name || "",
      set: card.setName || "",
      setId: card.setId || "",
      number: card.number || "",
      rarity: card.rarity || "",
      img: card.img || "",
      thumb: card.thumb || "",
      image: card.image || "",
      price: card.price,
      variants: card.price ? [{ key: "market", label: "Near Mint", market: card.price }] : [],
      source: "cache",
      holo: card.bucket === "holo" || card.bucket === "ultra"
    };
  }

  function saveCard(card, button) {
    if (!card || typeof addWish !== "function") return;
    if (wished(card.id)) {
      if (typeof removeFromWish === "function") removeFromWish(card.id);
      announceTo("Removed " + (card.name || "card") + " from your wishlist.");
    } else {
      addWish(toWish(card));
      announceTo("Saved " + (card.name || "card") + " to your wishlist.");
    }
    if (button) {
      const on = wished(card.id);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.textContent = on ? "Saved" : "Save";
      button.setAttribute("aria-label", (on ? "Saved " : "Save ") + (card.name || "card") + (on ? " on the wishlist" : " to wishlist"));
    }
  }

  function logPack() {
    if (logged || !pack) return;
    logged = true;
    const state = R.recordRip(readLog(), pack, { at: Date.now(), day: dayKey(), bonus });
    writeLog(state);
    if (typeof paintContext === "function") paintContext();
  }

  function openPack() {
    if (opening || !pack) return;
    opening = true;
    screen = "reveal";
    index = 0;
    faceUp = motionOff();
    logPack();
    const count = pack.cards.length;
    announceTo("Pack open. " + count + (count === 1 ? " card." : " cards.") + " Rarest last.");
    render();
    focusId("ripAdvance");
  }

  function showFace() {
    const card = pack && pack.cards[index];
    if (!card) return;
    faceUp = true;
    const last = index === pack.cards.length - 1;
    const price = R.priceLabel(card.price);
    const cardEl = document.getElementById("ripCard");
    if (cardEl) cardEl.classList.remove("is-down");
    const front = cardEl && cardEl.querySelector(".rip-front");
    if (front && !front.querySelector("img, .rip-ph")) {
      front.innerHTML = `<img alt="" data-rip-art="${esc(card.id)}" width="200" height="280" decoding="async">`;
      paintArts(front);
    }
    const meta = document.getElementById("ripMeta");
    if (meta) meta.innerHTML = `${esc(card.name || "Card")}${card.hit ? ` <span class="rip-hit">Hit</span>` : ""}`;
    const rarity = document.getElementById("ripRarity");
    if (rarity) rarity.textContent = card.rarity || "";
    const priceEl = document.getElementById("ripPrice");
    if (priceEl) priceEl.textContent = price;
    const live = document.getElementById("ripLive");
    if (live) live.textContent = (card.name || "Card") + ", " + (card.rarity || "") + ", " + price + ".";
    const button = document.getElementById("ripAdvance");
    const action = button && button.querySelector(".rip-action");
    if (action) action.textContent = last ? "See the pack" : "Next card";
    announceTo((card.name || "Card") + ", " + (card.rarity || "unknown rarity") + ", " + price + ".");
  }

  function advance() {
    if (screen !== "reveal" || !pack) return;
    const card = pack.cards[index];
    if (!card) return;
    if (!faceUp) {
      showFace();
      focusId("ripAdvance");
      return;
    }
    if (index < pack.cards.length - 1) {
      index += 1;
      faceUp = motionOff();
      render();
      focusId("ripAdvance");
      return;
    }
    screen = "summary";
    const value = pack.value ? pack.value.label : "No price yet";
    const best = pack.best;
    announceTo("Pack value " + value + (best ? ". Best hit " + (best.name || "card") + ", " + R.priceLabel(best.price) + "." : "."));
    render();
    focusId("ripSummaryTitle");
  }

  function chooseSet(setId, asBonus) {
    const set = (catalog && catalog.sets || []).find(item => item.id === setId);
    if (!set) return;
    const seed = asBonus ? "bonus:" + dayKey() + ":" + set.id : set.id + ":" + Date.now();
    const dealt = R.buildPack(set.cards, { setId: set.id, setName: set.name, seed });
    if (!dealt || !dealt.cards.length) {
      announceTo(set.name + " doesn't have enough saved cards to rip.");
      return;
    }
    pack = dealt;
    bonus = !!asBonus;
    logged = false;
    opening = false;
    screen = "sealed";
    index = 0;
    faceUp = false;
    announceTo(set.name + " is sealed. Drag across the top, or tear it open.");
    render();
    focusId("ripOpen");
  }

  function back() {
    if (screen === "picker") return false;
    if (screen === "reveal") logPack();
    screen = "picker";
    pack = null;
    bonus = false;
    opening = false;
    render();
    focusId("ripFind");
    return true;
  }

  function onTearKey(event) {
    const strip = event.currentTarget;
    const current = Number(strip.getAttribute("aria-valuenow") || "0");
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      setTear(strip, Math.min(100, current + 20));
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      setTear(strip, Math.max(0, current - 20));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPack();
    }
  }

  function setTear(strip, value) {
    const next = Math.max(0, Math.min(100, value));
    strip.style.setProperty("--tear", String(next / 100));
    strip.setAttribute("aria-valuenow", String(Math.round(next)));
    strip.setAttribute("aria-valuetext", next >= 100 ? "Torn open" : Math.round(next) + " percent torn");
    if (next >= 100) openPack();
  }

  function bindTear(strip) {
    if (!strip) return;
    let startX = 0;
    let pointer = null;
    let width = 1;
    const move = event => {
      if (pointer == null || event.pointerId !== pointer) return;
      const dx = Math.abs(event.clientX - startX);
      setTear(strip, dx / width * 100);
    };
    const up = event => {
      if (pointer == null || event.pointerId !== pointer) return;
      pointer = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const now = Number(strip.getAttribute("aria-valuenow") || "0");
      if (now < 100) setTear(strip, 0);
    };
    strip.addEventListener("pointerdown", event => {
      if (event.button) return;
      pointer = event.pointerId;
      startX = event.clientX;
      width = Math.max(80, strip.clientWidth * 0.72);
      try { strip.setPointerCapture(event.pointerId); } catch (e) {}
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    strip.addEventListener("keydown", onTearKey);
  }

  function renderPicker(sets) {
    const log = readLog();
    const best = log.best;
    const bestLine = best
      ? `<p class="rip-stat"><span class="eyebrow">Best pull</span><b>${esc(best.name || "Card")}</b><span class="rip-money">${esc(R.priceLabel(best.price))}</span><span class="fine">${esc([best.setName || best.setId, best.rarity].filter(Boolean).join(" · "))}</span></p>`
      : `<p class="rip-stat"><span class="eyebrow">Best pull</span><b>None yet</b><span class="fine">Your biggest hit will land here.</span></p>`;
    const today = dayKey();
    const ready = R.bonusReady(log, today);
    const bonusId = ready ? R.bonusSetId(sets, today, preferSet()) : "";
    const bonusSet = bonusId ? sets.find(set => set.id === bonusId) : null;
    const bonusHtml = bonusSet
      ? `<button class="rip-bonus" type="button" id="ripBonus">Today's bonus pack<small>${esc(bonusSet.name)} · one free rip for this Daily Drop day</small></button>`
      : (today && !ready ? `<p class="fine">Today's bonus pack is open. The next one lands with tomorrow's Daily Drop.</p>` : "");
    const recent = log.rips.slice(-3).reverse();
    const logHtml = recent.length
      ? `<section aria-labelledby="ripLogTitle"><h3 class="rip-title" id="ripLogTitle" style="font-size:18px">Recent rips</h3><ul class="rip-log">${recent.map(entry => `<li><b>${esc(entry.setName || entry.setId)}</b><span>${esc(entry.total == null ? "No price yet" : R.priceLabel(entry.total))}</span></li>`).join("")}</ul></section>`
      : "";
    const groups = new Map();
    sets.forEach(set => {
      if (!groups.has(set.era)) groups.set(set.era, []);
      groups.get(set.era).push(set);
    });
    const eras = [];
    groups.forEach((list, era) => {
      eras.push(`<h2 class="era-h">${esc(era)} <span class="fine">${list.length}</span></h2><div class="set-grid">${list.map(set => {
        return `<button class="set-tile" type="button" data-rip-set="${esc(set.id)}"><b>${esc(set.name)}</b><span class="fine">${esc(set.count + " saved cards")}</span></button>`;
      }).join("")}</div>`);
    });
    const empty = sets.length ? "" : `<p class="empty-state">No set has enough saved cards to rip yet. ${typeof toad === "function" ? toad() : ""}</p>`;
    const prices = typeof scrydex !== "undefined" && scrydex && scrydex.ready ? "" : `<p class="fine" role="status">Reading saved prices… Cards without one will say No price yet.</p>`;
    return `<div class="rip-wrap" data-screen="picker"><p class="eyebrow">Rip a pack</p><h2 class="rip-title" id="ripTitle">Tear one open</h2><p class="fine rip-note">${esc(R.DISCLAIMER)} Packs are dealt from cards already saved in this browser.</p>${prices}${bestLine}${bonusHtml}<label class="sr-only" for="ripFind">Search sets</label><input class="search" id="ripFind" type="search" placeholder="Search sets" enterkeyhint="search" autocomplete="off" value="${esc(query)}">${eras.join("")}${empty}${logHtml}</div>`;
  }

  function renderSealed() {
    const era = pack.era === "WOTC" ? "era-vintage" : (pack.era === "EX" || pack.era === "Diamond & Pearl" || pack.era === "HeartGold & SoulSilver" ? "era-mid" : "era-modern");
    return `<div class="rip-wrap" data-screen="sealed"><p class="eyebrow">${bonus ? "Bonus pack" : "Sealed pack"}</p><h2 class="rip-title" id="ripPackTitle">${esc(pack.setName || "Pack")}</h2><p class="fine rip-note">${esc(R.DISCLAIMER)} Drag across the top edge. ${pack.cards.length} cards, rarest last.</p>
      <div class="rip-pack ${era}">
        <div class="rip-tear" id="ripTear" role="slider" tabindex="0" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Sealed" aria-label="Tear across the top of the pack" style="--tear:0"><span class="rip-tear-fill" aria-hidden="true"></span><span class="rip-tear-label">Tear here</span></div>
        <p class="rip-pack-kicker">Sealed</p>
        <p class="rip-pack-name">${esc(pack.setName || pack.setId)}</p>
        <p class="rip-pack-sub fine">${esc(pack.cards.length + " cards")}</p>
      </div>
      <div class="rip-actions"><button class="rip-open" type="button" id="ripOpen">Tear it open</button><button class="rip-back" type="button" id="ripBack">Back</button></div></div>`;
  }

  function renderReveal() {
    const card = pack.cards[index];
    const last = index === pack.cards.length - 1;
    const down = !faceUp;
    const action = down ? "Reveal this card" : (last ? "See the pack" : "Next card");
    const price = down ? "" : R.priceLabel(card.price);
    const live = down ? "Face down." : (card.name || "Card") + ", " + (card.rarity || "") + ", " + price + ".";
    const art = down ? "" : `<img alt="" data-rip-art="${esc(card.id)}" width="200" height="280" decoding="async">`;
    return `<div class="rip-wrap" data-screen="reveal"><p class="rip-step fine" id="ripStep">Card ${index + 1} of ${pack.cards.length}. Rarest last.</p>
      <div class="rip-stage">
        <button class="rip-next rip-cardbtn" type="button" id="ripAdvance" aria-describedby="ripStep">
          <span class="rip-card${down ? " is-down" : ""}" id="ripCard" aria-hidden="true">
            <span class="rip-face rip-front">${art}</span>
            <span class="rip-face rip-backface"><b>BinderHunt</b><span class="fine">Face down</span></span>
          </span>
          <span class="rip-action">${esc(action)}</span>
        </button>
        <p class="rip-meta" id="ripMeta">${down ? "" : esc(card.name || "Card")}${!down && card.hit ? ` <span class="rip-hit">Hit</span>` : ""}</p>
        <p class="fine" id="ripRarity">${down ? "" : esc(card.rarity || "")}</p>
        <p class="rip-price" id="ripPrice">${esc(price)}</p>
      </div>
      <p class="sr-only" aria-live="polite" id="ripLive">${esc(live)}</p>
      <div class="rip-actions"><button class="rip-back" type="button" id="ripBack">Back</button></div></div>`;
  }

  function renderSummary() {
    const value = pack.value || { label: "No price yet", priced: 0 };
    const missing = pack.cards.length - (value.priced || 0);
    const best = pack.best;
    const bestHtml = best ? `<section class="rip-stat" aria-labelledby="ripHitTitle"><span class="eyebrow" id="ripHitTitle">Best hit</span><b>${esc(best.name || "Card")}</b><span class="rip-money">${esc(R.priceLabel(best.price))}</span><span class="fine">${esc([best.rarity, best.setName].filter(Boolean).join(" · "))}</span></section>` : "";
    const rows = pack.cards.map(card => {
      const on = wished(card.id);
      return `<li class="rip-row"><img alt="" data-rip-art="${esc(card.id)}" width="46" height="64" decoding="async" loading="lazy"><span class="rip-copy"><b>${esc(card.name || "Card")}</b><span class="fine">${esc(card.rarity || "")}</span><span class="rip-money">${esc(R.priceLabel(card.price))}</span></span><button class="rip-save" type="button" data-save="${esc(card.id)}" aria-pressed="${on ? "true" : "false"}" aria-label="${esc((on ? "Saved " : "Save ") + (card.name || "card") + (on ? " on the wishlist" : " to wishlist"))}">${on ? "Saved" : "Save"}</button></li>`;
    }).join("");
    const gap = missing ? `<p class="fine">${missing === 1 ? "1 card has no price yet." : missing + " cards have no price yet."}</p>` : "";
    return `<div class="rip-wrap" data-screen="summary"><p class="eyebrow">${esc(pack.setName || "Pack")}</p><h2 class="rip-title" id="ripSummaryTitle" tabindex="-1">Pack value</h2><p class="rip-price rip-total">${esc(value.label || "No price yet")}</p>${gap}<p class="fine rip-note">${esc(R.DISCLAIMER)}</p>${bestHtml}<ul class="rip-rows">${rows}</ul><div class="rip-actions"><button class="rip-open" type="button" id="ripAgain">Rip another</button><button class="rip-back" type="button" id="ripBack">Back to sets</button></div></div>`;
  }

  function render() {
    if (!hostEl) return;
    const finding = document.activeElement && document.activeElement.id === "ripFind";
    const caret = finding ? document.activeElement.selectionStart : null;
    if (!catalog) {
      hostEl.innerHTML = `<div class="rip-wrap" data-screen="loading"><p class="rip-wait" role="status">Shuffling a pack…</p></div>`;
      return;
    }
    let html = "";
    if (screen === "sealed" && pack) html = renderSealed();
    else if (screen === "reveal" && pack) html = renderReveal();
    else if (screen === "summary" && pack) html = renderSummary();
    else {
      screen = "picker";
      html = renderPicker(setsMatching());
    }
    hostEl.innerHTML = html;
    paintArts(hostEl);
    const find = document.getElementById("ripFind");
    if (find) {
      find.oninput = () => {
        query = find.value;
        render();
      };
      if (finding) {
        find.focus();
        if (caret != null) find.setSelectionRange(caret, caret);
      }
    }
    hostEl.querySelectorAll("[data-rip-set]").forEach(btn => {
      btn.onclick = () => chooseSet(btn.dataset.ripSet, false);
    });
    const bonusBtn = document.getElementById("ripBonus");
    if (bonusBtn) bonusBtn.onclick = () => {
      const sets = R.listSets(catalog);
      const id = R.bonusSetId(sets, dayKey(), preferSet());
      chooseSet(id, true);
    };
    const openBtn = document.getElementById("ripOpen");
    if (openBtn) openBtn.onclick = () => openPack();
    const advanceBtn = document.getElementById("ripAdvance");
    if (advanceBtn) advanceBtn.onclick = () => advance();
    const backBtn = document.getElementById("ripBack");
    if (backBtn) backBtn.onclick = () => back();
    const again = document.getElementById("ripAgain");
    if (again) again.onclick = () => back();
    hostEl.querySelectorAll("[data-save]").forEach(btn => {
      btn.onclick = () => {
        const card = pack && pack.cards.find(item => item.id === btn.dataset.save);
        saveCard(card, btn);
      };
    });
    bindTear(document.getElementById("ripTear"));
    const view = document.getElementById("viewRips");
    if (view && !view.dataset.ripKeys) {
      view.dataset.ripKeys = "1";
      view.addEventListener("keydown", event => {
        if (event.key !== " " && event.key !== "Enter") return;
        const tag = event.target && event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
        if (event.target && event.target.id === "ripTear") return;
        const button = document.getElementById("ripAdvance") || document.getElementById("ripOpen");
        if (!button) return;
        event.preventDefault();
        button.click();
      });
    }
  }

  function open(host) {
    hostEl = host;
    const pending = window.__bhRipSet;
    window.__bhRipSet = "";
    if (!catalog) {
      host.innerHTML = `<div class="rip-wrap" data-screen="loading"><p class="rip-wait" role="status">Shuffling a pack…</p></div>`;
    }
    loadFiles().then(() => {
      rebuild();
      if (pending) chooseSet(pending, false);
      else render();
      if (typeof paintContext === "function") paintContext();
    });
  }

  function syncLoggedPrices() {
    if (!logged || !pack || !pack.value) return;
    const state = readLog();
    const last = state.rips[state.rips.length - 1];
    if (!last || last.setId !== pack.setId) return;
    const byId = new Map(pack.cards.map(card => [card.id, card]));
    last.cards.forEach(card => {
      const fresh = byId.get(card.id);
      if (!fresh) return;
      card.price = fresh.price || null;
    });
    last.total = pack.value.total;
    last.priced = pack.value.priced || 0;
    if (pack.best) {
      last.best = {
        id: pack.best.id,
        name: pack.best.name,
        rarity: pack.best.rarity,
        bucket: pack.best.bucket,
        price: pack.best.price,
        setId: pack.best.setId,
        setName: pack.best.setName
      };
      const next = pack.best.price;
      const prev = state.best && state.best.price;
      if (typeof next === "number" && next >= 0.01 && (typeof prev !== "number" || next > prev)) {
        state.best = Object.assign({ at: last.at || Date.now() }, last.best);
      }
    }
    writeLog(state);
  }

  function refresh() {
    if (!hostEl || (!seedText && !pool.length)) return;
    rebuild();
    syncLoggedPrices();
    if (screen === "picker" || screen === "summary" || (screen === "reveal" && faceUp)) render();
  }

  window.BinderRipsUI = {
    open,
    refresh,
    back,
    inPack,
    contextLabel,
    sideText
  };
})();
