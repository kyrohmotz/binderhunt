/* Import sheet. Loaded after the shelf or Settings asks for it.
   Nothing is written until Add is pressed. Undo removes only the last import. */
(function () {
  const SHOW_MATCHED = 48;
  const SHOW_MISSED = 40;

  function api() { return window.BinderImport; }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  const state = {
    hooks: null,
    root: null,
    text: "",
    fileName: "",
    destination: "owned",
    picks: {},
    report: null,
    index: null,
    error: "",
    notice: "",
    busy: false,
    ready: false,
    timer: 0
  };

  function ownedIds() {
    try { return state.hooks && state.hooks.ownedIds ? state.hooks.ownedIds() : []; }
    catch (e) { return []; }
  }

  function wishIds() {
    try { return state.hooks && state.hooks.wishIds ? state.hooks.wishIds() : []; }
    catch (e) { return []; }
  }

  function currentPlan() {
    const lib = api();
    if (!lib || !state.report) return { destination: state.destination, add: [], duplicate: [], unresolved: 0 };
    return lib.plan(state.report, {
      destination: state.destination,
      ownedIds: ownedIds(),
      wishIds: wishIds(),
      picks: state.picks
    });
  }

  function summaryText() {
    const lib = api();
    if (state.busy) return "Reading the card catalog.";
    if (state.error) return state.error;
    if (!state.report) return state.notice || "";
    const counts = lib.summarize(state.report);
    const planned = currentPlan();
    const bits = [];
    bits.push(planned.add.length === 1 ? "1 new card" : planned.add.length + " new cards");
    if (counts.ambiguous) bits.push(counts.ambiguous === 1 ? "1 needs a pick" : counts.ambiguous + " need a pick");
    const missed = counts.unmatched + counts.skipped;
    if (missed) bits.push(missed === 1 ? "1 not matched" : missed + " not matched");
    const saved = planned.duplicate.filter(row => row.because === "saved").length;
    const repeated = planned.duplicate.length - saved;
    if (saved) bits.push(saved === 1 ? "1 already saved" : saved + " already saved");
    if (repeated) bits.push(repeated === 1 ? "1 repeated in this file" : repeated + " repeated in this file");
    if (planned.unresolved) bits.push(planned.unresolved === 1 ? "1 pick still open" : planned.unresolved + " picks still open");
    if (state.notice) bits.push(state.notice);
    const clean = bits.map(bit => String(bit).replace(/\.+$/, "").trim()).filter(Boolean);
    return clean.join(". ") + ".";
  }

  function thumb(card) {
    const src = card && (card.thumb || card.img);
    if (!src) return "";
    return `<img alt="" width="63" height="88" decoding="async" loading="lazy" src="${esc(src)}">`;
  }

  function metaLine(card, row) {
    const bits = [];
    if (card && card.setName) bits.push(card.setName);
    if (card && card.number) bits.push("#" + card.number);
    if (row && row.condition) bits.push(row.condition);
    if (row && row.quantity > 1) bits.push("×" + row.quantity);
    return bits.join(" · ");
  }

  function rowLabel(row) {
    const bits = [];
    if (row.name) bits.push(row.name);
    if (row.set) bits.push(row.set);
    if (row.number) bits.push("#" + row.number);
    return bits.join(" · ") || "Row " + row.line;
  }

  function paintResults() {
    const host = document.getElementById("importResults");
    const live = document.getElementById("importLive");
    const confirm = document.getElementById("importConfirm");
    const undo = document.getElementById("importUndo");
    if (!host) return;
    const text = summaryText();
    if (live) live.textContent = text;
    const lib = api();
    const record = lib && state.hooks ? lib.readUndo(state.hooks.storage()) : null;
    if (undo) {
      undo.hidden = !record;
      undo.textContent = record ? "Undo last import (" + record.ids.length + ")" : "Undo last import";
    }
    if (!state.report) {
      host.innerHTML = state.error ? `<p class="warn">${esc(state.error)}</p>` : "";
      if (confirm) {
        confirm.disabled = true;
        confirm.textContent = "Add cards";
      }
      return;
    }
    const planned = currentPlan();
    const adding = new Set(planned.add.map(card => card.id));
    const seen = new Set();
    const will = [];
    const have = [];
    const ambiguous = [];
    const missed = [];
    state.report.rows.forEach(item => {
      if (!item || !item.row) return;
      if (item.status === "unmatched" || item.status === "skipped") { missed.push(item); return; }
      if (item.status === "ambiguous") { ambiguous.push(item); return; }
      if (item.status !== "matched" || !item.card) return;
      const first = !seen.has(item.card.id);
      seen.add(item.card.id);
      if (first && adding.has(item.card.id)) will.push(item);
      else have.push(item);
    });
    const html = [];
    html.push(`<section class="import-block"><h3>Matched <span class="fine">${will.length + have.length}</span></h3>`);
    if (!will.length && !have.length) html.push(`<p class="fine">No rows matched a card yet.</p>`);
    else {
      html.push(`<ul class="import-grid">`);
      will.slice(0, SHOW_MATCHED).forEach(item => {
        const via = item.via === "name" ? "Matched by name and set" : "Matched by set and number";
        html.push(`<li class="import-card">${thumb(item.card)}<b>${esc(item.card.name)}</b><span class="fine">${esc(metaLine(item.card, item.row))}</span><span class="fine">${esc(via)}</span></li>`);
      });
      have.slice(0, Math.max(0, SHOW_MATCHED - Math.min(will.length, SHOW_MATCHED))).forEach(item => {
        const note = planned.duplicate.find(row => row.card && row.card.id === item.card.id && row.because === "saved")
          ? "Already in " + (state.destination === "wish" ? "the wishlist" : "Owned")
          : "Same card is earlier in this file";
        html.push(`<li class="import-card have">${thumb(item.card)}<b>${esc(item.card.name)}</b><span class="fine">${esc(metaLine(item.card, item.row))}</span><span class="fine">${esc(note)}</span></li>`);
      });
      html.push(`</ul>`);
      const hidden = will.length + have.length - Math.min(will.length, SHOW_MATCHED) - Math.min(have.length, Math.max(0, SHOW_MATCHED - Math.min(will.length, SHOW_MATCHED)));
      if (hidden > 0) html.push(`<p class="fine">${hidden} more matched cards are included when you add them.</p>`);
    }
    html.push(`</section>`);
    if (ambiguous.length) {
      html.push(`<section class="import-block"><h3>Needs a pick <span class="fine">${ambiguous.length}</span></h3>`);
      ambiguous.forEach(item => {
        const line = item.row.line;
        const pick = state.picks[line];
        html.push(`<fieldset class="import-choice"><legend>Row ${esc(String(line))}: ${esc(rowLabel(item.row))}</legend><p class="fine">${esc(item.reason)}</p><div class="import-picks">`);
        (item.choices || []).forEach(card => {
          const checked = pick === card.id ? " checked" : "";
          html.push(`<label><input type="radio" name="importPick-${esc(String(line))}" value="${esc(card.id)}"${checked}>${thumb(card)}<span class="import-pick-copy"><b>${esc(card.name)}</b><span class="fine">${esc(metaLine(card, null))}</span></span></label>`);
        });
        const skip = pick === "skip" ? " checked" : "";
        html.push(`<label><input type="radio" name="importPick-${esc(String(line))}" value="skip"${skip}><span>Leave this row out</span></label>`);
        html.push(`</div></fieldset>`);
      });
      html.push(`</section>`);
    }
    if (missed.length) {
      html.push(`<section class="import-block"><h3>Not matched <span class="fine">${missed.length}</span></h3><ul class="import-miss">`);
      missed.slice(0, SHOW_MISSED).forEach(item => {
        html.push(`<li><b>Row ${esc(String(item.row.line))}: ${esc(rowLabel(item.row))}</b><span class="fine">${esc(item.reason)}</span></li>`);
      });
      html.push(`</ul>`);
      if (missed.length > SHOW_MISSED) html.push(`<p class="fine">${missed.length - SHOW_MISSED} more rows were not matched.</p>`);
      html.push(`</section>`);
    }
    host.innerHTML = html.join("");
    host.querySelectorAll("img").forEach(img => {
      img.addEventListener("error", () => { img.hidden = true; });
    });
    if (confirm) {
      const dest = state.destination === "wish" ? "the wishlist" : "Owned";
      confirm.disabled = !planned.add.length;
      confirm.textContent = planned.add.length ? "Add " + planned.add.length + (planned.add.length === 1 ? " card to " : " cards to ") + dest : "Nothing new to add";
    }
  }

  function applyText(text, notice) {
    state.text = String(text || "");
    state.notice = notice || "";
    state.picks = {};
    const lib = api();
    if (!lib) {
      state.error = "Import didn't load.";
      state.report = null;
      paintResults();
      return;
    }
    if (!state.index) {
      state.error = "";
      state.report = null;
      state.notice = state.busy ? "Reading the card catalog." : "The card catalog is not ready yet.";
      paintResults();
      return;
    }
    if (!normText(state.text)) {
      state.error = "";
      state.report = null;
      state.notice = "";
      paintResults();
      return;
    }
    const parsed = lib.parseCsv(state.text);
    if (!parsed.ok) {
      state.error = parsed.error;
      state.report = null;
      paintResults();
      return;
    }
    state.error = "";
    if (!parsed.rows.length) {
      state.report = null;
      state.notice = "That file has a header and no cards.";
      paintResults();
      return;
    }
    if (parsed.truncated) state.notice = "Only the first " + lib.MAX_ROWS + " rows were read.";
    state.report = lib.matchRows(parsed.rows, state.index);
    paintResults();
  }

  function normText(value) {
    return String(value || "").replace(/^\uFEFF/, "").trim();
  }

  function scheduleText(text) {
    state.text = text;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => applyText(state.text, state.fileName ? "Loaded " + state.fileName + "." : ""), 180);
  }

  function bindForm() {
    const file = document.getElementById("importFile");
    const paste = document.getElementById("importPaste");
    const results = document.getElementById("importResults");
    const owned = document.getElementById("importOwned");
    const wish = document.getElementById("importWish");
    const confirm = document.getElementById("importConfirm");
    const undo = document.getElementById("importUndo");
    if (file) file.addEventListener("change", () => {
      const picked = file.files && file.files[0];
      if (!picked) return;
      state.fileName = picked.name || "collection.csv";
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        state.text = text;
        if (paste && text.length <= 200000) paste.value = text;
        else if (paste) paste.value = "";
        applyText(text, "Loaded " + state.fileName + ".");
      };
      reader.onerror = () => {
        state.error = "That file could not be read.";
        state.report = null;
        paintResults();
      };
      reader.readAsText(picked);
    });
    if (paste) paste.addEventListener("input", () => {
      state.fileName = "";
      scheduleText(paste.value);
    });
    if (owned) owned.addEventListener("change", () => {
      if (!owned.checked) return;
      state.destination = "owned";
      paintResults();
    });
    if (wish) wish.addEventListener("change", () => {
      if (!wish.checked) return;
      state.destination = "wish";
      paintResults();
    });
    if (results) results.addEventListener("change", event => {
      const input = event.target;
      if (!input || input.type !== "radio" || !input.name || input.name.indexOf("importPick-") !== 0) return;
      const line = Number(input.name.slice("importPick-".length));
      if (!Number.isFinite(line)) return;
      const name = input.name;
      const value = input.value;
      state.picks[line] = value;
      paintResults();
      const again = [...document.querySelectorAll("#importResults input")].find(el => el.name === name && el.value === value);
      if (again) again.focus();
    });
    if (confirm) confirm.addEventListener("click", onConfirm);
    if (undo) undo.addEventListener("click", onUndo);
  }

  function onConfirm() {
    const lib = api();
    const button = document.getElementById("importConfirm");
    if (!lib || !state.hooks || !state.report) return;
    const planned = currentPlan();
    if (!planned.add.length) {
      paintResults();
      return;
    }
    const result = lib.commit(state.hooks.storage(), planned);
    if (!result.ok) {
      state.error = result.error || "Nothing was saved.";
      paintResults();
      return;
    }
    if (state.hooks.afterWrite) state.hooks.afterWrite(result);
    const dest = result.destination === "wish" ? "the wishlist" : "Owned";
    const count = result.added.length;
    state.notice = "Added " + count + (count === 1 ? " card to " : " cards to ") + dest + ". Undo removes only this import.";
    state.picks = {};
    paintResults();
    const undo = document.getElementById("importUndo");
    if (undo && !undo.hidden) undo.focus();
    else if (button) button.focus();
  }

  function onUndo() {
    const lib = api();
    if (!lib || !state.hooks) return;
    const result = lib.undo(state.hooks.storage());
    if (!result.ok) {
      state.error = result.error || "Nothing to undo.";
      paintResults();
      return;
    }
    try {
      if (state.hooks.afterWrite) state.hooks.afterWrite(Object.assign({ undo: true }, result));
    } catch (e) {
      state.error = "Undo saved, but the page did not refresh. " + (e && e.message ? e.message : "");
    }
    const count = (result.removed || []).length;
    state.notice = count ? "Removed " + count + (count === 1 ? " card from the last import." : " cards from the last import.") : "The last import was already gone.";
    state.error = "";
    paintResults();
    const undo = document.getElementById("importUndo");
    if (undo && !undo.hidden) undo.focus();
    else {
      const file = document.getElementById("importFile");
      if (file) file.focus();
    }
  }

  function shell() {
    return `<div class="import-scroll" id="importScroll"><div class="import-form">
      <p class="fine">Paste a Collectr, TCGplayer, or other CSV. Matching uses the card list already saved in BinderHunt. Nothing is written until you add the cards.</p>
      <label class="import-file">CSV file<input id="importFile" type="file" accept=".csv,text/csv,text/plain"></label>
      <label class="import-file" for="importPaste">Or paste CSV<textarea id="importPaste" class="import-paste" spellcheck="false"></textarea></label>
      <p id="importLive" class="fine import-live" role="status" aria-live="polite"></p>
    </div>
    <div id="importResults"></div></div>
    <div class="import-actions">
      <div role="radiogroup" aria-labelledby="importDestLabel">
        <p id="importDestLabel" class="fine">Add matched cards to</p>
        <div class="import-dest">
          <label><input id="importOwned" type="radio" name="importDest" value="owned" checked> Owned</label>
          <label><input id="importWish" type="radio" name="importDest" value="wish"> Wishlist</label>
        </div>
      </div>
      <button type="button" class="import-go" id="importConfirm" disabled>Add cards</button>
      <button type="button" class="import-undo" id="importUndo" hidden>Undo last import</button>
    </div>`;
  }

  let indexJob = null;
  function loadIndex() {
    const lib = api();
    if (state.index) return Promise.resolve(state.index);
    if (indexJob) return indexJob;
    if (!lib || !state.hooks || !state.hooks.pools) return Promise.resolve(null);
    state.busy = true;
    paintResults();
    indexJob = state.hooks.pools().then(pools => {
      const names = {};
      const poolCards = lib.cardsFromPools(pools);
      poolCards.forEach(card => { if (card.setId && card.setName) names[card.setId] = card.setName; });
      const extra = state.hooks.setNames ? state.hooks.setNames() : {};
      Object.keys(extra || {}).forEach(id => { if (extra[id] && !names[id]) names[id] = extra[id]; });
      const cache = state.hooks.cards ? state.hooks.cards() : {};
      state.index = lib.indexCatalog(lib.mergeCards([poolCards, lib.cardsFromCache(cache, names)]));
      state.ready = true;
      state.busy = false;
      if (state.text) applyText(state.text, state.notice);
      else paintResults();
    }).catch(() => {
      state.busy = false;
      state.ready = false;
      state.index = null;
      state.error = "The saved card list didn't load. Try again in a moment.";
      paintResults();
    });
    indexJob.catch(() => { indexJob = null; });
    return indexJob;
  }

  function open(root, hooks) {
    state.hooks = hooks || {};
    state.root = root;
    state.text = "";
    state.fileName = "";
    state.destination = "owned";
    state.picks = {};
    state.report = null;
    state.error = "";
    state.notice = "";
    if (!root) return;
    root.innerHTML = shell();
    bindForm();
    if (!state.index) loadIndex();
    else paintResults();
    const file = document.getElementById("importFile");
    if (file) file.focus();
  }

  window.BinderImportUI = { open };
})();
