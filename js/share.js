/* BinderHunt share card.
   A binder (or the wishlist) becomes a pastel image plus a link the person
   posts themselves. There is no account and no server: the link is this
   site under /binderhunt/ with the name and a few cards in the query.
   Opening it paints a read-only showcase from that query alone. It does
   not write wishlist or binder storage, and it does not call Scrydex.
   Open X only fills a composer. BinderHunt never posts.

   Query (readable, client-only):
     share=binder|wish
     name, color (RRGGBB), n (cards in the collection), got (owned)
     pocket, repeated, up to 6:
       id~name~set~number~owned~art
     art is d: or p: plus a path on assets.tcgdex.net or images.pokemontcg.io.
   The existing ?card= deep link is left alone. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BinderShare = api;
  if (typeof document !== "undefined") api.install();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CANONICAL = "https://kyrohmotz.github.io/binderhunt/";
  const MAX_POCKETS = 6;
  const MAX_COUNT = 999;
  const ART_HOSTS = {
    d: "https://assets.tcgdex.net/",
    p: "https://images.pokemontcg.io/"
  };
  const INK = "#1F1F1E";
  const PAPER = "#F8F7EF";
  const PAPER2 = "#F1F1E4";
  const INK2 = "#404241";
  const SAGE = "#ABB28D";

  function clipText(value, max) {
    return String(value == null ? "" : value)
      .replace(/~/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function cleanCardId(id) {
    const s = String(id == null ? "" : id).trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s) ? s : "";
  }

  function normalizeColor(value, fallback) {
    const raw = String(value == null ? "" : value).trim().replace(/^#/, "");
    return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : fallback;
  }

function whole(value, fallback, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, Math.floor(n));
}

  function safeArtPath(path) {
    if (!path || path.length > 180) return "";
    if (path.includes("..") || path.includes("\\") || path.includes("?") || path.includes("#") || path.startsWith("/")) return "";
    return /^[A-Za-z0-9._/-]+$/.test(path) ? path : "";
  }

  function packArt(url) {
    if (typeof url !== "string") return "";
    const keys = Object.keys(ART_HOSTS);
    for (let i = 0; i < keys.length; i++) {
      const prefix = ART_HOSTS[keys[i]];
      if (url.startsWith(prefix)) {
        const path = safeArtPath(url.slice(prefix.length));
        return path ? keys[i] + ":" + path : "";
      }
    }
    return "";
  }

  function unpackArt(packed) {
    const text = String(packed || "");
    const split = text.indexOf(":");
    if (split < 1) return "";
    const code = text.slice(0, split);
    const prefix = ART_HOSTS[code];
    if (!prefix) return "";
    const path = safeArtPath(text.slice(split + 1));
    return path ? prefix + path : "";
  }

  function preferArt(card) {
    if (!card) return "";
    if (packArt(card.thumb)) return card.thumb;
    if (packArt(card.img)) return card.img;
    if (typeof card.image === "string" && packArt(card.image + "/low.webp")) return card.image + "/low.webp";
    return "";
  }

  function owns(ownedIds, id) {
    if (!ownedIds || !id) return false;
    if (typeof ownedIds.has === "function") return ownedIds.has(id) === true;
    return Array.isArray(ownedIds) && ownedIds.indexOf(id) !== -1;
  }

  function buildPayload(source) {
    const src = source || {};
    const kind = src.kind === "wish" ? "wish" : "binder";
    const name = clipText(src.name, 40) || (kind === "wish" ? "Wishlist" : "Binder");
    const color = normalizeColor(src.color, kind === "wish" ? "E4E7DA" : "E9D5C0");
    const all = (Array.isArray(src.cards) ? src.cards : []).filter(card => card && cleanCardId(card.id));
    const got = all.reduce((n, card) => n + (owns(src.ownedIds, card.id) ? 1 : 0), 0);
    const cards = all.slice(0, MAX_POCKETS).map(card => ({
      id: cleanCardId(card.id),
      name: clipText(card.name, 48),
      set: clipText(card.set, 48),
      number: clipText(card.number, 12),
      owned: owns(src.ownedIds, card.id),
      art: unpackArt(packArt(preferArt(card)))
    }));
    return { kind, name, color, count: all.length, got, cards };
  }

  function encodePocket(card) {
    return [
      card.id,
      card.name,
      card.set,
      card.number,
      card.owned ? "1" : "0",
      packArt(card.art)
    ].join("~");
  }

  function decodePocket(value) {
    const parts = String(value || "").split("~");
    if (parts.length < 5) return null;
    const id = cleanCardId(parts[0]);
    if (!id) return null;
    return {
      id,
      name: clipText(parts[1], 48),
      set: clipText(parts[2], 48),
      number: clipText(parts[3], 12),
      owned: parts[4] === "1",
      art: unpackArt(parts.slice(5).join("~"))
    };
  }

  function encodeParams(payload) {
    const params = new URLSearchParams();
    params.set("share", payload.kind);
    params.set("name", payload.name);
    params.set("color", payload.color);
    params.set("n", String(payload.count));
    params.set("got", String(payload.got));
    (payload.cards || []).forEach(card => params.append("pocket", encodePocket(card)));
    return params;
  }

  function binderhuntBase(href) {
    let url;
    try { url = new URL(href || CANONICAL, CANONICAL); }
    catch (e) { url = new URL(CANONICAL); }
    let path = url.pathname || "/";
    if (/\/index\.html$/i.test(path)) path = path.replace(/index\.html$/i, "");
    if (!path.endsWith("/")) path += "/";
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url;
  }

  function queryString(params) {
    const parts = [];
    params.forEach((value, key) => {
      const encoded = encodeURIComponent(value).replace(/%7E/gi, "~").replace(/%3A/gi, ":");
      parts.push(encodeURIComponent(key) + "=" + encoded);
    });
    return parts.join("&");
  }

  function shareUrl(payload, base) {
    const url = binderhuntBase(base || CANONICAL);
    const query = queryString(encodeParams(payload));
    return url.toString().replace(/\/$/, "/") + (query ? "?" + query : "");
  }

  function readQuery(input) {
    try {
      let search = String(input == null ? "" : input);
      if (!search) return null;
      if (search.indexOf("://") !== -1) search = new URL(search).search;
      if (search.charAt(0) === "?") search = search.slice(1);
      const params = new URLSearchParams(search);
      const kind = params.get("share");
      if (kind !== "binder" && kind !== "wish") return null;
      const name = clipText(params.get("name"), 40);
      if (kind === "binder" && !name) return null;
      const cards = [];
      params.getAll("pocket").forEach(value => {
        if (cards.length >= MAX_POCKETS) return;
        const card = decodePocket(value);
        if (card) cards.push(card);
      });
      const count = Math.max(cards.length, whole(params.get("n"), cards.length, MAX_COUNT));
      let got = whole(params.get("got"), cards.reduce((n, card) => n + (card.owned ? 1 : 0), 0), MAX_COUNT);
      if (got > count) got = count;
      return {
        kind,
        name: name || "Wishlist",
        color: normalizeColor(params.get("color"), kind === "wish" ? "E4E7DA" : "E9D5C0"),
        count,
        got,
        cards
      };
    } catch (e) {
      return null;
    }
  }

  function countLine(payload) {
    const n = payload && Number.isFinite(payload.count) ? payload.count : 0;
    const got = payload && Number.isFinite(payload.got) ? payload.got : 0;
    const shown = payload && payload.cards ? payload.cards.length : 0;
    if (!n) return "No cards yet";
    let line = n === 1 ? "1 card" : n + " cards";
    if (got > 0) line += " · " + got + " owned";
    if (shown > 0 && shown < n) line += " · showing " + shown;
    return line;
  }

  function shareCaption(payload) {
    const name = payload && payload.name ? payload.name : "Binder";
    const n = payload && Number.isFinite(payload.count) ? payload.count : 0;
    const cards = n === 1 ? "1 card" : n + " cards";
    if (payload && payload.kind === "wish") {
      return n ? "My BinderHunt wishlist — " + cards + "." : "My BinderHunt wishlist.";
    }
    return n ? "My " + name + " binder on BinderHunt — " + cards + "." : "My " + name + " binder on BinderHunt.";
  }

  function intentUrl(payload, pageUrl) {
    const params = new URLSearchParams();
    params.set("text", shareCaption(payload) + " " + pageUrl);
    return "https://x.com/intent/post?" + params.toString();
  }

  function fileSlug(name) {
    const slug = String(name || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return slug || "binder";
  }

  function cardAlt(card) {
    const bits = [card.name || "Card"];
    if (card.set) bits.push(card.set);
    if (card.number) bits.push("#" + card.number);
    if (card.owned) bits.push("owned");
    return bits.join(", ");
  }

  let installed = false;
  let returnFocus = null;
  let current = null;

  function say(text) {
    const status = document.getElementById("shareStatus");
    if (status) status.textContent = text;
    if (typeof announce === "function") announce(text);
  }

  function setBackgroundInert(on) {
    const shell = document.getElementById("shell");
    const profile = document.getElementById("profile");
    if (on) {
      if (shell) shell.inert = true;
      if (profile) profile.inert = true;
      return;
    }
    if (profile) profile.inert = false;
    if (typeof syncInert === "function") syncInert();
    else if (shell) shell.inert = false;
  }

  function focusables(sheet) {
    return [...sheet.querySelectorAll("button, a[href], input, select, textarea")].filter(el => {
      if (el.disabled || el.hidden || el.tabIndex < 0) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function isOpen() {
    const sheet = document.getElementById("shareSheet");
    return !!(sheet && !sheet.hidden);
  }

  function onKey(event) {
    if (!isOpen()) return;
    const sheet = document.getElementById("shareSheet");
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeShare();
      return;
    }
    if (event.key === "Tab") {
      const items = focusables(sheet);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = items.indexOf(document.activeElement) !== -1;
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      event.stopPropagation();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "f" || event.key === "F" || event.key === "z" || event.key === "Z") {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function nameFallback(card) {
    const span = document.createElement("span");
    span.className = "share-fallback";
    span.textContent = card.name || "Card";
    return span;
  }

  function fillPoster(root, payload) {
    root.replaceChildren();
    const band = document.createElement("div");
    band.className = "share-band";
    band.style.backgroundColor = "#" + payload.color;
    const kicker = document.createElement("p");
    kicker.className = "share-kicker";
    kicker.textContent = payload.kind === "wish" ? "Wishlist" : "Binder";
    const title = document.createElement("p");
    title.className = "share-title";
    title.textContent = payload.name;
    const line = document.createElement("p");
    line.className = "share-count";
    line.textContent = countLine(payload);
    band.append(kicker, title, line);
    root.append(band);
    if (!payload.cards.length) {
      const empty = document.createElement("p");
      empty.className = "share-empty";
      empty.textContent = payload.kind === "wish" ? "Nothing saved yet." : "No cards in this binder yet.";
      root.append(empty);
    } else {
      const grid = document.createElement("div");
      grid.className = "share-grid";
      grid.dataset.n = payload.cards.length <= 2 ? String(payload.cards.length) : "3";
      payload.cards.forEach(card => {
        const pocket = document.createElement("figure");
        pocket.className = "share-pocket";
        if (card.art) {
          const img = document.createElement("img");
          img.alt = cardAlt(card);
          img.decoding = "async";
          img.draggable = false;
          img.addEventListener("error", () => { if (img.parentNode) img.replaceWith(nameFallback(card)); });
          img.src = card.art;
          pocket.append(img);
        } else pocket.append(nameFallback(card));
        if (card.owned) {
          const mark = document.createElement("span");
          mark.className = "share-got";
          mark.title = "Owned";
          mark.setAttribute("aria-hidden", "true");
          pocket.append(mark);
        }
        grid.append(pocket);
      });
      root.append(grid);
    }
    const foot = document.createElement("p");
    foot.className = "share-brand";
    foot.textContent = "BinderHunt";
    root.append(foot);
  }

  function ensureSheet() {
    let sheet = document.getElementById("shareSheet");
    if (sheet) return sheet;
    sheet = document.createElement("div");
    sheet.id = "shareSheet";
    sheet.className = "sheet share-sheet";
    sheet.hidden = true;
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "backdrop";
    backdrop.tabIndex = -1;
    backdrop.setAttribute("aria-label", "Close share");
    backdrop.addEventListener("click", closeShare);
    const panel = document.createElement("div");
    panel.className = "share-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "shareTitle");
    panel.setAttribute("aria-describedby", "shareNote");
    const top = document.createElement("div");
    top.className = "share-top";
    const heading = document.createElement("h2");
    heading.id = "shareTitle";
    heading.textContent = "Share";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "chip";
    close.id = "shareClose";
    close.textContent = "Close";
    close.addEventListener("click", closeShare);
    top.append(heading, close);
    const poster = document.createElement("div");
    poster.id = "sharePoster";
    poster.className = "share-poster";
    const note = document.createElement("p");
    note.id = "shareNote";
    note.className = "fine share-note";
    const actions = document.createElement("div");
    actions.className = "share-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "chip";
    copy.id = "shareCopy";
    copy.textContent = "Copy link";
    copy.addEventListener("click", onCopy);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "share-save";
    save.id = "shareSave";
    save.textContent = "Save image";
    save.addEventListener("click", onSave);
    const openX = document.createElement("button");
    openX.type = "button";
    openX.className = "chip";
    openX.id = "shareX";
    openX.textContent = "Open X";
    openX.setAttribute("aria-label", "Open X with this text and link ready to post. BinderHunt does not post for you.");
    openX.addEventListener("click", onX);
    actions.append(copy, save, openX);
    const linkLabel = document.createElement("label");
    linkLabel.className = "share-link-label";
    linkLabel.append(document.createTextNode("Share link"));
    const link = document.createElement("input");
    link.id = "shareLink";
    link.className = "share-link";
    link.type = "text";
    link.readOnly = true;
    linkLabel.append(link);
    const status = document.createElement("p");
    status.id = "shareStatus";
    status.className = "share-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    panel.append(top, poster, note, actions, linkLabel, status);
    sheet.append(backdrop, panel);
    document.body.append(sheet);
    return sheet;
  }

  function pageBase() {
    try { return binderhuntBase(location.href).toString(); }
    catch (e) { return CANONICAL; }
  }

  function present(payload, opts) {
    if (!payload || (payload.kind !== "binder" && payload.kind !== "wish")) return;
    if (typeof document === "undefined") return;
    const received = !!(opts && opts.received);
    const sheet = ensureSheet();
    const url = shareUrl(payload, pageBase());
    current = { payload, received, url };
    returnFocus = opts && opts.returnFocus && opts.returnFocus.focus ? opts.returnFocus : document.activeElement;
    document.getElementById("shareTitle").textContent = received
      ? (payload.kind === "wish" ? "Shared wishlist" : "Shared binder")
      : (payload.kind === "wish" ? "Share wishlist" : "Share binder");
    document.getElementById("shareNote").textContent = received
      ? "A read-only look. Nothing is added to your wishlist or binders."
      : "Save the image, copy the link, and post them yourself. BinderHunt never posts for you.";
    document.getElementById("shareX").hidden = received;
    document.getElementById("shareLink").value = url;
    document.getElementById("shareStatus").textContent = "";
    fillPoster(document.getElementById("sharePoster"), payload);
    sheet.hidden = false;
    setBackgroundInert(true);
    const panel = sheet.querySelector(".share-panel");
    if (panel) panel.scrollTop = 0;
    const close = document.getElementById("shareClose");
    if (close) close.focus();
  }

  function closeShare() {
    const sheet = document.getElementById("shareSheet");
    if (!sheet || sheet.hidden) return;
    const received = current && current.received;
    sheet.hidden = true;
    setBackgroundInert(false);
    if (received) stripShareQuery();
    current = null;
    const back = returnFocus;
    returnFocus = null;
    if (back && typeof back.focus === "function" && document.contains(back)) back.focus();
  }

  function stripShareQuery() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has("share")) return;
      ["share", "name", "color", "n", "got", "pocket"].forEach(key => url.searchParams.delete(key));
      const search = url.searchParams.toString();
      history.replaceState(null, "", url.pathname + (search ? "?" + search : "") + url.hash);
    } catch (e) {}
  }

  async function onCopy() {
    if (!current) return;
    const url = current.url;
    const input = document.getElementById("shareLink");
    if (input) {
      input.value = url;
      input.focus();
      input.select();
    }
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch (e) {}
    if (!ok) {
      try { ok = document.execCommand("copy"); } catch (e) {}
    }
    say(ok ? "Link copied." : "Link ready. Select it if the clipboard was blocked.");
    const close = document.getElementById("shareClose");
    if (close) close.focus();
  }

  /* Some TCGdex low.webp files send Access-Control-Allow-Origin twice.
     The picture still shows in an img, and the canvas fetch is rejected.
     The high.webp beside it has a single header, so the PNG tries that first. */
  function artCandidates(url) {
    const out = [];
    const push = value => {
      const full = unpackArt(packArt(value));
      if (full && !out.includes(full)) out.push(full);
    };
    if (typeof url === "string" && /\/low\.webp$/.test(url)) push(url.replace(/\/low\.webp$/, "/high.webp"));
    push(url);
    return out;
  }

  async function loadCorsImage(url) {
    const candidates = artCandidates(url);
    for (let i = 0; i < candidates.length; i++) {
      try {
        const response = await fetch(candidates[i], { mode: "cors", credentials: "omit" });
        if (!response.ok) continue;
        const blob = await response.blob();
        if (!blob.size) continue;
        const bitmap = await createImageBitmap(blob);
        if (bitmap.width > 0 && bitmap.height > 0) return bitmap;
      } catch (e) {}
    }
    return null;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    words.forEach(word => {
      const next = line ? line + " " + word : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    });
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  function drawCover(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const ir = iw / ih;
    const box = w / h;
    let sx = 0, sy = 0, sw = iw, sh = ih;
    if (ir > box) {
      sw = sh * box;
      sx = (iw - sw) / 2;
    } else {
      sh = sw / box;
      sy = (ih - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  async function readyFonts() {
    if (!document.fonts || !document.fonts.load) return;
    try {
      await Promise.all([
        document.fonts.load("800 64px Sniglet"),
        document.fonts.load("800 28px Nunito"),
        document.fonts.load("italic 700 22px Lato")
      ]);
      await document.fonts.ready;
    } catch (e) {}
  }

  function paintPoster(ctx, payload, images) {
    const W = 1200;
    const H = 1500;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    ctx.lineJoin = "round";
    ctx.textBaseline = "top";
    roundRect(ctx, 36, 36, W - 72, H - 72, 40);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 8;
    ctx.stroke();

    const bandX = 72;
    const bandY = 72;
    const bandW = W - 144;
    let titleSize = 56;
    ctx.font = "800 " + titleSize + "px Sniglet, Nunito, sans-serif";
    let titleLines = wrapText(ctx, payload.name, bandW - 72).slice(0, 2);
    while (titleSize > 34 && titleLines.some(line => ctx.measureText(line).width > bandW - 72)) {
      titleSize -= 4;
      ctx.font = "800 " + titleSize + "px Sniglet, Nunito, sans-serif";
      titleLines = wrapText(ctx, payload.name, bandW - 72).slice(0, 2);
    }
    const titleStep = titleSize + 8;
    const bandH = 36 + 28 + 18 + Math.max(1, titleLines.length) * titleStep + 18 + 40 + 28;
    roundRect(ctx, bandX, bandY, bandW, bandH, 28);
    ctx.fillStyle = "#" + payload.color;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.font = "italic 700 22px Lato, Nunito, sans-serif";
    ctx.fillText(payload.kind === "wish" ? "WISHLIST" : "BINDER", bandX + 32, bandY + 28);
    ctx.font = "800 " + titleSize + "px Sniglet, Nunito, sans-serif";
    titleLines.forEach((line, i) => ctx.fillText(line, bandX + 32, bandY + 64 + i * titleStep));
    ctx.font = "800 28px Nunito, sans-serif";
    ctx.fillText(countLine(payload), bandX + 32, bandY + 64 + titleLines.length * titleStep + 8);

    const cards = payload.cards || [];
    const footerTop = H - 168;
    const gridTop = bandY + bandH + 36;
    if (!cards.length) {
      ctx.fillStyle = INK2;
      ctx.font = "700 32px Nunito, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(payload.kind === "wish" ? "Nothing saved yet." : "No cards in this binder yet.", W / 2, gridTop + 80);
    } else {
      const cols = cards.length === 1 ? 1 : cards.length === 2 ? 2 : 3;
      const rows = Math.ceil(cards.length / cols);
      const gap = 20;
      const gridW = W - 144;
      const gridH = Math.max(80, footerTop - 24 - gridTop);
      let cardW = (gridW - gap * (cols - 1)) / cols;
      let cardH = cardW * 88 / 63;
      const maxH = (gridH - gap * (rows - 1)) / rows;
      if (cardH > maxH) {
        cardH = maxH;
        cardW = cardH * 63 / 88;
      }
      const rowW = cols * cardW + (cols - 1) * gap;
      const startX = 72 + (gridW - rowW) / 2;
      cards.forEach((card, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * (cardW + gap);
        const y = gridTop + row * (cardH + gap);
        ctx.save();
        roundRect(ctx, x, y, cardW, cardH, 16);
        ctx.clip();
        const img = images[i];
        if (img) drawCover(ctx, img, x, y, cardW, cardH);
        else {
          ctx.fillStyle = PAPER2;
          ctx.fillRect(x, y, cardW, cardH);
          ctx.fillStyle = INK;
          ctx.font = "700 26px Nunito, sans-serif";
          ctx.textAlign = "center";
          const lines = wrapText(ctx, card.name || "Card", cardW - 28);
          const block = lines.length * 32;
          lines.forEach((line, li) => ctx.fillText(line, x + cardW / 2, y + (cardH - block) / 2 + li * 32));
        }
        ctx.restore();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 5;
        roundRect(ctx, x, y, cardW, cardH, 16);
        ctx.stroke();
        if (card.owned) {
          const bx = x + cardW - 26;
          const by = y + 26;
          ctx.beginPath();
          ctx.arc(bx, by, 16, 0, Math.PI * 2);
          ctx.fillStyle = SAGE;
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = INK;
          ctx.stroke();
          ctx.beginPath();
          ctx.lineWidth = 3;
          ctx.moveTo(bx - 7, by);
          ctx.lineTo(bx - 2, by + 6);
          ctx.lineTo(bx + 8, by - 6);
          ctx.stroke();
        }
      });
    }

    ctx.textAlign = "center";
    ctx.fillStyle = INK;
    ctx.font = "800 40px Sniglet, Nunito, sans-serif";
    ctx.fillText("BinderHunt", W / 2, H - 140);
    ctx.fillStyle = INK2;
    ctx.font = "700 22px Nunito, sans-serif";
    ctx.fillText("No packs. Just the cards you're hunting.", W / 2, H - 88);
  }

  async function renderPng(payload) {
    await readyFonts();
    const images = await Promise.all((payload.cards || []).map(card => loadCorsImage(card.art)));
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1500;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    paintPoster(ctx, payload, images);
    return await new Promise(resolve => {
      if (!canvas.toBlob) { resolve(null); return; }
      canvas.toBlob(blob => resolve(blob), "image/png");
    });
  }

  async function onSave() {
    if (!current) return;
    const btn = document.getElementById("shareSave");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving…";
    }
    try {
      const blob = await renderPng(current.payload);
      if (!blob) throw new Error("empty");
      const a = document.createElement("a");
      const href = URL.createObjectURL(blob);
      a.href = href;
      a.download = "binderhunt-" + fileSlug(current.payload.name) + ".png";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2500);
      say("Image saved.");
    } catch (e) {
      say("Couldn't make the image.");
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save image";
    }
  }

  function onX() {
    if (!current || current.received) return;
    const href = intentUrl(current.payload, current.url);
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
    else say("Pop-up blocked. Copy the link and open X yourself.");
  }

  function openCollection(source) {
    const payload = buildPayload(source || {});
    present(payload, { received: false, returnFocus: typeof document !== "undefined" ? document.activeElement : null });
  }

  function install() {
    if (installed || typeof document === "undefined") return;
    installed = true;
    document.addEventListener("keydown", onKey, true);
    if (document.body) ensureSheet();
    else document.addEventListener("DOMContentLoaded", () => ensureSheet(), { once: true });
  }

  return {
    CANONICAL,
    MAX_POCKETS,
    packArt,
    unpackArt,
    artCandidates,
    buildPayload,
    shareUrl,
    readQuery,
    countLine,
    shareCaption,
    intentUrl,
    fileSlug,
    present,
    openCollection,
    install
  };
});
