/* Card inspect.
   A tapped card lifts out of its pocket to the middle of the screen. Drag to
   spin it in 3D (it keeps spinning when flicked, then settles face up or
   face down), scroll or pinch to zoom, flip to read the back. Esc, a tap
   outside or a swipe down puts it away.
   Per-frame work is transforms only: the sheen is a large gradient layer
   that slides under a clip, so nothing repaints while the card moves. */
(function () {
  const RAD = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let root, stage, lift, zoomEl, cardEl, frontEl, backEl, shadowEl, sheenEl, glareEl, titleEl;
  let state = null;
  let bound = false;

  function q(id) { return document.getElementById(id); }

  function setup() {
    if (bound) return !!root;
    root = q("showcase");
    stage = q("showcaseStage");
    lift = q("inspectLift");
    zoomEl = q("inspectZoom");
    cardEl = q("showcaseCard");
    frontEl = q("inspectFront");
    backEl = q("inspectBack");
    shadowEl = q("inspectShadow");
    titleEl = q("inspectTitle");
    if (!root || !stage || !lift || !zoomEl || !cardEl || !frontEl || !backEl) return false;
    bound = true;
    bind();
    return true;
  }

  /* ---------- painting ---------- */

  function paint() {
    const s = state;
    if (!s) return;
    cardEl.style.transform = "rotateX(" + s.rx.toFixed(2) + "deg) rotateY(" + s.ry.toFixed(2) + "deg)";
    zoomEl.style.transform = "scale(" + s.scale.toFixed(3) + ")";
    const ny = Math.sin(s.ry * RAD);
    const nx = Math.sin(s.rx * RAD);
    const facing = Math.cos(s.ry * RAD) * Math.cos(s.rx * RAD);
    const tilt = clamp(Math.hypot(nx, ny) * 1.7, 0, 1);
    if (sheenEl) {
      /* The rainbow band slides opposite the tilt, the way foil catches
         a fixed light as the card turns. */
      sheenEl.style.transform = "translate3d(" + (-33.3 - ny * 22).toFixed(2) + "%," + (-33.3 + nx * 22).toFixed(2) + "%,0)";
      sheenEl.style.opacity = (s.holo ? 0.18 + 0.72 * tilt : 0.05 + 0.25 * tilt).toFixed(3);
    }
    if (glareEl) {
      glareEl.style.transform = "translate3d(" + (-33.3 - ny * 30).toFixed(2) + "%," + (-33.3 + nx * 30).toFixed(2) + "%,0)";
      glareEl.style.opacity = (0.15 + 0.55 * tilt).toFixed(3);
    }
    if (shadowEl) {
      const spread = Math.abs(Math.cos(s.ry * RAD));
      shadowEl.style.transform = "translate3d(" + (-ny * 26).toFixed(1) + "px," + (18 + nx * 14).toFixed(1) + "px,0) scale(" + (Math.max(0.12, spread) * s.scale).toFixed(3) + "," + s.scale.toFixed(3) + ")";
      shadowEl.style.opacity = (0.55 + 0.25 * Math.abs(facing)).toFixed(3);
    }
  }

  /* ---------- motion loop ---------- */

  let raf = 0, last = 0;
  function kick() {
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
  }
  function step(now) {
    raf = 0;
    const s = state;
    if (!s || s.closing) return;
    const dt = Math.min(0.034, Math.max(0.001, (now - last) / 1000));
    last = now;
    let moving = false;
    if (!s.dragging) {
      if (s.mode === "spin") {
        /* Free spin with friction. */
        s.ry += s.vy * dt;
        s.rx += s.vx * dt;
        const f = Math.exp(-2.4 * dt);
        s.vy *= f;
        s.vx *= f;
        s.rx = clamp(s.rx, -62, 62);
        if (Math.abs(s.vy) < 70 && Math.abs(s.vx) < 70) s.mode = "settle";
        moving = true;
      }
      if (s.mode === "settle") {
        /* Come to rest on whichever face is nearer, flat to the viewer. */
        const toY = s.settleY != null ? s.settleY : Math.round(s.ry / 180) * 180;
        const k = 70, c = 2 * Math.sqrt(k) * 0.82;
        s.vy += (k * (toY - s.ry) - c * s.vy) * dt;
        s.vx += (k * (0 - s.rx) - c * s.vx) * dt;
        s.ry += s.vy * dt;
        s.rx += s.vx * dt;
        if (Math.abs(toY - s.ry) < 0.05 && Math.abs(s.rx) < 0.05 && Math.abs(s.vy) < 0.5 && Math.abs(s.vx) < 0.5) {
          s.ry = toY; s.rx = 0; s.vy = 0; s.vx = 0; s.mode = "rest"; s.settleY = null;
          /* Keep the angle small so it never drifts into huge numbers. */
          s.ry = ((s.ry % 360) + 360) % 360;
        } else moving = true;
      }
    }
    if (Math.abs(s.scaleTo - s.scale) > 0.001) {
      s.scale += (s.scaleTo - s.scale) * (1 - Math.exp(-18 * dt));
      moving = true;
    } else s.scale = s.scaleTo;
    paint();
    syncFace();
    if (moving || s.dragging) raf = requestAnimationFrame(step);
  }

  function syncFace() {
    const s = state;
    if (!s) return;
    const showingBack = Math.cos(s.ry * RAD) < 0;
    if (showingBack !== s.showingBack) {
      s.showingBack = showingBack;
      frontEl.setAttribute("aria-hidden", showingBack ? "true" : "false");
      backEl.setAttribute("aria-hidden", showingBack ? "false" : "true");
      const flip = q("showcaseFlip");
      if (flip) flip.setAttribute("aria-pressed", showingBack ? "true" : "false");
    }
  }

  /* ---------- open / close ---------- */

  function rectOf(node) {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    if (!(r.width > 4 && r.height > 4)) return null;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
    return r;
  }

  function flipFrom(r) {
    const to = lift.getBoundingClientRect();
    if (!r || !(to.width > 0)) return null;
    const sx = r.width / to.width;
    const sy = r.height / to.height;
    const dx = (r.left + r.width / 2) - (to.left + to.width / 2);
    const dy = (r.top + r.height / 2) - (to.top + to.height / 2);
    return "translate3d(" + dx.toFixed(1) + "px," + dy.toFixed(1) + "px,0) scale(" + sx.toFixed(4) + "," + sy.toFixed(4) + ")";
  }

  function buildFront(opts) {
    frontEl.replaceChildren();
    const img = document.createElement("img");
    img.alt = opts.alt || "";
    img.draggable = false;
    img.decoding = "async";
    const urls = (opts.urls || []).slice();
    let i = 0;
    img.onerror = () => {
      i++;
      if (i < urls.length) { img.src = urls[i]; return; }
      img.replaceWith(opts.missing ? opts.missing() : document.createElement("div"));
    };
    /* Show what the pocket already has, then swap to the sharper file. */
    if (opts.quick && urls.indexOf(opts.quick) < 0) {
      img.src = opts.quick;
      if (urls.length) {
        const hi = new Image();
        hi.decoding = "async";
        hi.onload = () => { if (state && state.token === opts.token) img.src = hi.src; };
        hi.src = urls[0];
      }
    } else if (urls.length) img.src = urls[0];
    else { img.remove(); if (opts.missing) frontEl.append(opts.missing()); }
    if (img.src) frontEl.append(img);
    const clipA = document.createElement("div");
    clipA.className = "inspect-sheen-clip";
    sheenEl = document.createElement("div");
    sheenEl.className = "inspect-sheen" + (opts.holo ? " holo" : "");
    clipA.append(sheenEl);
    const clipB = document.createElement("div");
    clipB.className = "inspect-sheen-clip";
    glareEl = document.createElement("div");
    glareEl.className = "inspect-glare";
    clipB.append(glareEl);
    frontEl.append(clipA, clipB);
  }

  function open(opts) {
    if (!setup()) return false;
    if (state) finishClose(true);
    const reduce = !!opts.reduce;
    const token = (open.n = (open.n || 0) + 1);
    state = {
      token, opts, reduce,
      rx: 0, ry: 0, vx: 0, vy: 0, scale: 1, scaleTo: 1,
      mode: "rest", dragging: false, closing: false, showingBack: false,
      pointers: new Map(), pinch: null, source: opts.from || null
    };
    buildFront({ urls: opts.urls, quick: opts.quick, alt: opts.alt, holo: opts.holo, missing: opts.missing, token });
    backEl.innerHTML = opts.backHtml || "";
    frontEl.setAttribute("aria-hidden", "false");
    backEl.setAttribute("aria-hidden", "true");
    if (titleEl) titleEl.textContent = opts.title || "Card";
    const detailsBtn = q("showcaseDetails");
    if (detailsBtn) detailsBtn.hidden = !opts.onDetails;
    const flip = q("showcaseFlip");
    if (flip) flip.setAttribute("aria-pressed", "false");
    root.classList.toggle("is-holo", !!opts.holo);
    root.hidden = false;
    root.classList.remove("is-closing");
    paint();
    state.returnFocus = document.activeElement;
    const fromRect = rectOf(opts.from);
    if (opts.from) opts.from.classList.add("inspect-source");
    if (!reduce && fromRect && lift.animate) {
      const from = flipFrom(fromRect);
      if (from) {
        lift.animate([{ transform: from }, { transform: "translate3d(0,0,0) scale(1)" }], { duration: 520, easing: "cubic-bezier(.16,.84,.24,1.06)" });
        cardEl.animate([{ transform: "rotateX(0deg) rotateY(0deg)" }, { transform: "rotateX(10deg) rotateY(-14deg)", offset: 0.55 }, { transform: "rotateX(0deg) rotateY(0deg)" }], { duration: 620, easing: "ease-out" });
      }
      root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    }
    try { cardEl.focus({ preventScroll: true }); } catch (e) {}
    return true;
  }

  function isOpen() { return !!(state && !state.closing && root && !root.hidden); }

  function finishClose(now) {
    const s = state;
    if (!s) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (s.source) s.source.classList.remove("inspect-source");
    root.hidden = true;
    root.classList.remove("is-closing");
    lift.getAnimations && lift.getAnimations().forEach(a => a.cancel());
    cardEl.getAnimations && cardEl.getAnimations().forEach(a => a.cancel());
    root.getAnimations && root.getAnimations().forEach(a => a.cancel());
    lift.style.transform = "";
    cardEl.style.transform = "";
    zoomEl.style.transform = "";
    frontEl.replaceChildren();
    backEl.replaceChildren();
    sheenEl = glareEl = null;
    const back = s.returnFocus;
    const onClose = s.opts.onClose;
    state = null;
    if (!now && back && back.isConnected && typeof back.focus === "function") {
      try { back.focus({ preventScroll: true }); } catch (e) {}
    }
    if (onClose) onClose();
  }

  /* how: "return" flies back to the pocket, "drop" falls off the bottom. */
  function close(how) {
    const s = state;
    if (!s || s.closing) return;
    s.closing = true;
    s.dragging = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (s.reduce || !lift.animate) { finishClose(); return; }
    root.classList.add("is-closing");
    const nowLift = getComputedStyle(lift).transform;
    const curCard = cardEl.style.transform || "rotateX(0deg) rotateY(0deg)";
    /* Unwind to the nearest whole turn so the face comes home face up. */
    const homeY = Math.round(s.ry / 360) * 360;
    const curZoom = zoomEl.style.transform || "scale(1)";
    zoomEl.animate([{ transform: curZoom }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out", fill: "forwards" });
    cardEl.animate([{ transform: curCard }, { transform: "rotateX(0deg) rotateY(" + homeY + "deg)" }], { duration: 300, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" });
    let to;
    const r = how === "drop" ? null : rectOf(s.source);
    if (how === "drop") to = "translate3d(0," + Math.round(innerHeight * 0.9) + "px,0) rotate(" + (s.vy > 0 ? 8 : -8) + "deg) scale(.9)";
    else to = r ? flipFrom(r) : "translate3d(0,24px,0) scale(.92)";
    const anim = lift.animate([{ transform: nowLift === "none" ? "translate3d(0,0,0) scale(1)" : nowLift }, { transform: to }], { duration: how === "drop" ? 300 : 360, easing: how === "drop" ? "cubic-bezier(.5,0,.9,.5)" : "cubic-bezier(.3,.75,.25,1)", fill: "forwards" });
    root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, delay: how === "drop" ? 0 : 120, easing: "ease-in", fill: "forwards" });
    let done = false;
    const fin = () => { if (done) return; done = true; finishClose(); };
    anim.onfinish = fin;
    setTimeout(fin, 700);
  }

  function flip() {
    const s = state;
    if (!s || s.closing) return;
    const toY = (Math.round(s.ry / 180) + 1) * 180;
    if (s.reduce) {
      s.ry = toY; s.rx = 0; s.vx = s.vy = 0; s.mode = "rest";
      paint(); syncFace();
      return;
    }
    /* Swing one face over and settle there. */
    s.settleY = toY;
    s.vx = 0;
    s.mode = "settle";
    kick();
  }

  function zoomBy(factor) {
    const s = state;
    if (!s || s.closing) return;
    s.scaleTo = clamp(s.scaleTo * factor, 1, 3);
    if (s.reduce) s.scale = s.scaleTo;
    kick();
    if (s.reduce) { paint(); }
  }

  /* ---------- input ---------- */

  function bind() {
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("wheel", e => {
      if (!isOpen()) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });
    cardEl.addEventListener("dblclick", e => {
      if (!isOpen()) return;
      e.preventDefault();
      state.scaleTo = state.scaleTo > 1.2 ? 1 : 2;
      kick();
    });
    cardEl.addEventListener("keydown", e => {
      if (!isOpen()) return;
      const s = state;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation();
        s.vy += e.key === "ArrowLeft" ? -320 : 320;
        s.mode = "spin";
        kick();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        s.vx += e.key === "ArrowUp" ? 260 : -260;
        s.mode = "spin";
        kick();
      } else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.25); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(0.8); }
      else if (e.key === "f" || e.key === "F" || e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
    });
    const flipBtn = q("showcaseFlip");
    if (flipBtn) flipBtn.addEventListener("click", () => flip());
    const closeBtn = q("showcaseClose");
    if (closeBtn) closeBtn.addEventListener("click", () => close("return"));
    const details = q("showcaseDetails");
    if (details) details.addEventListener("click", () => {
      const s = state;
      if (!s) return;
      const fn = s.opts.onDetails;
      close("return");
      if (fn) fn();
    });
    window.addEventListener("resize", () => { if (isOpen()) paint(); });
  }

  function onDown(e) {
    const s = state;
    if (!s || s.closing) return;
    if (e.target.closest(".inspect-bar")) return;
    if (e.button) return;
    e.preventDefault();
    s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { root.setPointerCapture(e.pointerId); } catch (err) {}
    if (s.pointers.size === 2) {
      const pts = [...s.pointers.values()];
      s.pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, scale: s.scaleTo };
      s.gesture = null;
      return;
    }
    if (s.pointers.size > 2) return;
    s.gesture = {
      id: e.pointerId,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      t0: performance.now(), t: performance.now(),
      onCard: !!e.target.closest("#showcaseCard"),
      travel: 0, vpx: 0, vpy: 0
    };
    s.dragging = true;
    s.vx = s.vy = 0;
    s.settleY = null;
    s.mode = "drag";
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    kick();
  }

  function onMove(e) {
    const s = state;
    if (!s || !s.pointers.has(e.pointerId)) return;
    s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.pinch && s.pointers.size >= 2) {
      const pts = [...s.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      s.scaleTo = clamp(s.pinch.scale * d / s.pinch.d, 1, 3);
      if (s.reduce) s.scale = s.scaleTo;
      kick();
      return;
    }
    const g = s.gesture;
    if (!g || g.id !== e.pointerId) return;
    const now = performance.now();
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    const dt = Math.max(1, now - g.t);
    g.x = e.clientX; g.y = e.clientY; g.t = now;
    g.travel = Math.max(g.travel, Math.hypot(e.clientX - g.x0, e.clientY - g.y0));
    /* Rotate as if the finger pushes the card's surface. Zoomed in, the
       same push turns it less. */
    const gain = 0.42 / Math.sqrt(s.scale);
    const dRy = dx * gain;
    const dRx = -dy * gain * 0.85;
    s.ry += dRy;
    s.rx = clamp(s.rx + dRx, -62, 62);
    const a = 0.35;
    s.vy = (1 - a) * s.vy + a * (dRy / dt * 1000);
    s.vx = (1 - a) * s.vx + a * (dRx / dt * 1000);
    g.vpx = (1 - a) * g.vpx + a * (dx / dt);
    g.vpy = (1 - a) * g.vpy + a * (dy / dt);
    if (s.reduce) { paint(); syncFace(); }
  }

  function onUp(e) {
    const s = state;
    if (!s) return;
    s.pointers.delete(e.pointerId);
    if (s.pinch) {
      if (s.pointers.size < 2) s.pinch = null;
      if (s.pointers.size === 0) endDrag(e);
      return;
    }
    const g = s.gesture;
    if (!g || g.id !== e.pointerId) return;
    endDrag(e);
    const cancelled = e.type === "pointercancel";
    const now = performance.now();
    const stale = now - g.t > 90;
    if (stale) { s.vx = 0; s.vy = 0; g.vpy = 0; }
    const totalDx = g.x - g.x0, totalDy = g.y - g.y0;
    if (!cancelled && g.travel < 7 && now - g.t0 < 400) {
      /* A tap off the card puts it away. */
      if (!g.onCard) { close("return"); return; }
      s.mode = "settle";
      kick();
      return;
    }
    if (!cancelled && totalDy > 110 && g.vpy > 0.45 && Math.abs(totalDx) < totalDy * 0.9) {
      close("drop");
      return;
    }
    if (s.reduce) {
      s.mode = "settle";
      s.vx = s.vy = 0;
      s.ry = Math.round(s.ry / 180) * 180;
      s.rx = 0;
      paint(); syncFace();
      return;
    }
    s.mode = Math.abs(s.vy) > 70 || Math.abs(s.vx) > 70 ? "spin" : "settle";
    kick();
  }

  function endDrag() {
    const s = state;
    if (!s) return;
    if (s.pointers.size) return;
    s.dragging = false;
    s.gesture = null;
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerup", onUp);
    root.removeEventListener("pointercancel", onUp);
  }

  window.CardInspect = {
    open, close, isOpen, flip, zoomBy,
    /* For tests: current angles and zoom. */
    peek() { return state ? { rx: state.rx, ry: state.ry, scale: state.scale, scaleTo: state.scaleTo, mode: state.mode, back: state.showingBack } : null; }
  };
})();
