/* Pokédex screen. Loaded only after the Dex tab is opened.
   Reads the saved catalog and data/dex.json. No third-party requests. */
(function () {
  let rootEl = null;
  let model = null;
  let filter = "all";
  let query = "";
  let tablePromise = null;
  let cachedCards = null;
  let cachedSpecies = null;
  let paintToken = 0;
  let lastNote = "";
  let keysBound = false;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function ensureCss() {
    if (document.getElementById("dexCss")) return;
    const link = document.createElement("link");
    link.id = "dexCss";
    link.rel = "stylesheet";
    link.href = "css/dex.css";
    document.head.appendChild(link);
  }

  function loadTable() {
    const Dex = window.BinderDex;
    if (!tablePromise) {
      tablePromise = fetch("data/dex.json", { credentials: "omit" }).then(res => {
        if (!res.ok) throw new Error("dex");
        return res.json();
      }).then(data => Dex.loadTable(data)).catch(err => {
        tablePromise = null;
        throw err;
      });
    }
    return tablePromise;
  }

  function speciesList(table) {
    const cards = typeof scrydex !== "undefined" && scrydex ? scrydex.cards : null;
    if (cachedSpecies && cachedCards === cards) return cachedSpecies;
    cachedCards = cards;
    const built = window.BinderDex.buildSpecies(cards, table, window.BinderBrowse.pokemonSpecies, window.BinderBrowse.artFor);
    cachedSpecies = built.species;
    return cachedSpecies;
  }

  function currentModel(table) {
    const owned = typeof ownedIds !== "undefined" && ownedIds ? ownedIds : [];
    const saved = typeof wish !== "undefined" && Array.isArray(wish) ? wish : [];
    return window.BinderDex.collection(speciesList(table), owned, saved);
  }

  const MARK = {
    owned: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 6.2 4.7 8.9 10 3.2" fill="none" stroke="#1F1F1E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    wish: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path fill="#1F1F1E" d="M6 10.4 1.4 6.2C.3 5.1.5 3.2 1.9 2.4 3.1 1.7 4.5 2.1 6 3.5 7.5 2.1 8.9 1.7 10.1 2.4c1.4.8 1.6 2.7.5 3.8z"/></svg>'
  };

  function initials(name) {
    const parts = String(name || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }

  function safeArt(url) {
    return typeof url === "string" && /^https:\/\/(?:assets\.tcgdex\.net|images\.pokemontcg\.io)\//.test(url) ? url : "";
  }

  function summaryText() {
    if (!model || !model.overall) return "Reading the saved catalog.";
    const overall = model.overall;
    if (!overall.total) return "No Pokémon with a card in the saved catalog yet.";
    let line = "Caught " + overall.owned + " of " + overall.total + ".";
    if (overall.wish) line += " " + overall.wish + " wishlisted.";
    return line;
  }

  function columnsOf(cells) {
    if (cells.length < 2) return 1;
    const top = cells[0].getBoundingClientRect().top;
    let count = 1;
    for (; count < cells.length; count++) {
      if (Math.abs(cells[count].getBoundingClientRect().top - top) > 4) break;
    }
    return count || 1;
  }

  function onKey(event) {
    const cell = event.target && event.target.closest ? event.target.closest(".dex-cell") : null;
    if (!cell || !rootEl || !rootEl.contains(cell)) return;
    const grid = cell.parentElement;
    if (!grid || !grid.classList.contains("dex-grid")) return;
    const cells = [...grid.querySelectorAll(".dex-cell")];
    const index = cells.indexOf(cell);
    if (index < 0) return;
    const cols = columnsOf(cells);
    let next = index;
    if (event.key === "ArrowRight") next = Math.min(cells.length - 1, index + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "ArrowDown") next = Math.min(cells.length - 1, index + cols);
    else if (event.key === "ArrowUp") next = Math.max(0, index - cols);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = cells.length - 1;
    else return;
    if (next === index) return;
    event.preventDefault();
    cells[next].focus();
  }

  function noteMilestones() {
    const Dex = window.BinderDex;
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(Dex.KEY) || "null"); } catch (e) { raw = null; }
    const seen = Dex.readSeen(raw);
    const events = Dex.pendingMilestones(model.generations, seen);
    if (!events.length) return "";
    events.forEach(event => event.marks.forEach(mark => seen.add(event.gen + ":" + mark)));
    try { localStorage.setItem(Dex.KEY, JSON.stringify(Dex.payload(seen))); } catch (e) {}
    return Dex.celebrateCopy(events);
  }

  function render(table) {
    const Dex = window.BinderDex;
    const host = rootEl;
    model = currentModel(table);
    const visible = Dex.visibleSpecies(model, filter, query);
    const overall = model.overall;
    const finding = document.activeElement && document.activeElement.id === "dexFind";
    const caret = finding ? document.activeElement.selectionStart : null;
    const scroll = finding ? host.scrollTop : 0;
    const chips = model.generations.map(gen => `<span class="dex-genchip">${esc(Dex.countLabel(gen.id, gen.owned, gen.total))}</span>`).join("");
    const filters = [
      ["all", "All"],
      ["owned", "Owned"],
      ["missing", "Missing"],
      ["wish", "Wishlisted"]
    ].map(([id, label]) => {
      const on = filter === id;
      return `<button type="button" class="chip${on ? " on" : ""}" data-dex-filter="${id}" aria-pressed="${on ? "true" : "false"}">${label}</button>`;
    }).join("");
    const wishLine = overall.total
      ? `<p class="fine dex-lead">${esc(overall.wish + " wishlisted · " + overall.missing + " still to find. Only Pokémon with a card in the saved catalog are on this board.")}</p>`
      : "";
    let sections = "";
    model.generations.forEach(gen => {
      const rows = visible.filter(entry => entry.gen === gen.id);
      if (!rows.length) return;
      const label = Dex.countLabel(gen.id, gen.owned, gen.total);
      const cells = rows.map(entry => {
        const art = safeArt(entry.art);
        const letters = initials(entry.name);
        const label = art ? Dex.cellLabel(entry) : letters + " " + Dex.cellLabel(entry);
        const mark = MARK[entry.status] || "";
        const img = art
          ? `<img alt="" width="64" height="64" src="${esc(art)}" decoding="async" loading="lazy">`
          : "";
        return `<button type="button" class="dex-cell ${esc(entry.status)}" data-browse="${esc(entry.browseName)}" aria-label="${esc(label)}"><span class="dex-art${art ? "" : " fallback"}">${img}<span class="dex-initials">${esc(letters)}</span></span><span class="dex-name">${esc(entry.name)}</span><span class="dex-num">#${esc(String(entry.dex).padStart(3, "0"))}</span>${mark ? `<span class="dex-mark">${mark}</span>` : ""}</button>`;
      }).join("");
      sections += `<section class="dex-gen" aria-labelledby="dex-gen-${gen.id}"><div class="dex-head"><h3 id="dex-gen-${gen.id}">${esc(gen.name)}</h3><p class="dex-count">${esc(label)}</p></div><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${gen.total}" aria-valuenow="${gen.owned}" aria-label="${esc(gen.name + ", " + label)}"><span style="width:${gen.pct}%"></span></div><div class="dex-grid">${cells}</div></section>`;
    });
    const empty = !overall.total
      ? `<p class="empty-state dex-empty">No Pokémon in the saved catalog yet. ${(typeof toad === "function" ? toad() : "")}</p>`
      : (!visible.length ? `<p class="empty-state dex-empty">No Pokémon match. ${(typeof toad === "function" ? toad() : "")}</p>` : "");
    const showing = (query || filter !== "all") && overall.total
      ? `<p class="fine dex-showing" id="dexShowing">${esc(visible.length ? "Showing " + visible.length + " Pokémon" : "Nothing to show")}</p>`
      : "";
    const caughtLabel = "Caught " + overall.owned + " of " + overall.total;
    const bar = overall.total
      ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${overall.total}" aria-valuenow="${overall.owned}" aria-label="${esc(caughtLabel)}"><span style="width:${overall.pct}%"></span></div>`
      : "";
    host.innerHTML = `<div class="dex-wrap"><h2 class="dex-title" id="dexTitle">Pokédex</h2><p class="dex-caught">${esc(overall.total ? caughtLabel : "Caught 0 of 0")}</p>${wishLine}${bar}<ul class="dex-legend"><li><span class="dex-swatch owned" aria-hidden="true"></span> Owned, full color</li><li><span class="dex-swatch wish" aria-hidden="true"></span> Wishlisted, pastel outline</li><li><span class="dex-swatch missing" aria-hidden="true"></span> Missing, grey</li></ul><div class="dex-gens">${chips}</div><div class="dex-tools"><div class="dex-filters" role="group" aria-label="Pokédex filters">${filters}</div><label class="sr-only" for="dexFind">Search Pokémon</label><input class="search" id="dexFind" type="search" placeholder="e.g. Pikachu" enterkeyhint="search" autocomplete="off" value="${esc(query)}">${showing}</div><p class="sr-only">Arrow keys move between Pokémon in a generation. Enter opens that Pokémon's cards.</p>${sections}${empty}</div>`;
    host.querySelectorAll("[data-dex-filter]").forEach(btn => {
      btn.onclick = () => {
        if (typeof popBtn === "function") popBtn(btn);
        filter = btn.getAttribute("data-dex-filter") || "all";
        paint();
      };
    });
    host.querySelectorAll(".dex-cell").forEach(btn => {
      btn.onclick = () => {
        const name = btn.getAttribute("data-browse") || "";
        if (name && typeof openBrowse === "function") openBrowse("pokemon", name);
      };
    });
    host.querySelectorAll(".dex-art img").forEach(img => {
      const drop = () => {
        const art = img.closest(".dex-art");
        const cell = img.closest(".dex-cell");
        img.remove();
        if (art) art.classList.add("fallback");
        if (cell && art) {
          const letters = art.querySelector(".dex-initials");
          const name = cell.querySelector(".dex-name");
          const num = cell.querySelector(".dex-num");
          const state = cell.classList.contains("owned") ? "owned" : cell.classList.contains("wish") ? "wishlisted" : "missing";
          if (letters && name && num) cell.setAttribute("aria-label", letters.textContent + " " + name.textContent + " " + num.textContent + ", " + state);
        }
      };
      img.addEventListener("error", drop);
      if (img.complete && img.naturalWidth === 0) drop();
    });
    const find = document.getElementById("dexFind");
    if (find) {
      find.oninput = () => {
        query = find.value;
        paint();
      };
      if (finding) {
        find.focus();
        if (caret != null) find.setSelectionRange(caret, caret);
        host.scrollTop = scroll;
      }
    }
    const cheer = noteMilestones();
    if (cheer) {
      lastNote = cheer;
      if (typeof showConfetti === "function") showConfetti(cheer);
      else if (typeof announce === "function") announce(cheer);
    } else if (typeof announce === "function") {
      const text = query || filter !== "all"
        ? (visible.length ? "Showing " + visible.length + " Pokémon." : "No Pokémon match.")
        : "Pokédex. Caught " + overall.owned + " of " + overall.total + ".";
      if (text !== lastNote) {
        lastNote = text;
        announce(text);
      }
    }
    if (typeof paintSide === "function") paintSide();
  }

  function paint() {
    const token = ++paintToken;
    const host = rootEl;
    if (!host) return;
    ensureCss();
    if (!window.BinderDex || !window.BinderBrowse) {
      model = null;
      host.innerHTML = `<p class="empty-state">The Pokédex didn't load. Try the Dex tab again in a moment.</p>`;
      return;
    }
    if (typeof scrydex === "undefined" || !scrydex.ready) {
      model = null;
      host.innerHTML = `<p class="dex-wait" role="status">Reading the saved catalog…</p>`;
      if (typeof paintSide === "function") paintSide();
      return;
    }
    loadTable().then(table => {
      if (token !== paintToken || rootEl !== host) return;
      render(table);
    }).catch(() => {
      if (token !== paintToken || rootEl !== host) return;
      model = null;
      host.innerHTML = `<p class="empty-state">The Pokédex list didn't load. Try the Dex tab again in a moment.</p>`;
    });
  }

  function open(host) {
    ensureCss();
    rootEl = host;
    if (host && !keysBound) {
      host.addEventListener("keydown", onKey);
      keysBound = true;
    }
    paint();
  }

  window.BinderDexUI = { open: open, refresh: paint, summaryText: summaryText };
})();
