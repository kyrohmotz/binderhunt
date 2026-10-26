/* Stiff binder page turn.
   A binder page is a rigid sheet hinged at the spine, so the turning leaf
   only rotates about the gutter: no curl, no peel. Everything that moves per
   frame is a transform or an opacity, so the compositor does the work and the
   turn holds frame rate on slow phones.

   The caller drives it in "progress degrees": 0 is the page lying where it
   started, 180 is the page lying on the other side. */
(function () {
  const RAD = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function el(cls, parent) {
    const node = document.createElement("div");
    node.className = cls;
    node.setAttribute("aria-hidden", "true");
    if (parent) parent.append(node);
    return node;
  }

  /* opts:
       spread  the .book-spread element
       leaf    the .leaf that turns
       kind    "forward" | "backward" | "solo-forward" | "solo-backward"
       reduce  true when motion is reduced (turns jump, no springs) */
  function arm(opts) {
    const spread = opts.spread;
    const leaf = opts.leaf;
    const kind = opts.kind;
    const reduce = !!opts.reduce;
    const solo = kind.indexOf("solo") === 0;
    const backHalf = kind === "backward";
    const front = leaf.querySelector(":scope > .face.front");
    const back = leaf.querySelector(":scope > .face.back");

    leaf.classList.add("turning", "turn-" + kind);
    const shadeF = front ? el("turn-shade", front) : null;
    const glintF = front ? el("turn-glint", front) : null;
    const shadeB = back ? el("turn-shade", back) : null;
    const glintB = back ? el("turn-glint", back) : null;
    /* The cast shadow lands on the page under the lifted leaf, then on the
       facing page once the leaf crosses the spine. */
    const castStart = el("turn-cast " + (backHalf ? "on-left" : "on-right"), spread);
    const castEnd = solo ? null : el("turn-cast " + (backHalf ? "on-right" : "on-left"), spread);

    let theta = 0;       /* shown angle */
    let target = 0;      /* where the finger wants it */
    let vel = 0;         /* degrees per second */
    let raf = 0;
    let last = 0;
    let phase = "idle";  /* idle | follow | settle */
    let settleTo = 0;
    let settleDone = null;
    let alive = true;

    /* Geometric angle of the sheet: 0 = flat where it began, 180 = flat on
       the far side. solo-backward starts flipped away and comes home. */
    const geo = t => kind === "solo-backward" ? 180 - t : t;
    const sign = kind === "backward" ? 1 : -1;

    function paint(t) {
      const phi = clamp(geo(t), -6, 186);
      leaf.style.transform = "rotateY(" + (sign * phi).toFixed(2) + "deg)";
      leaf.dataset.shown = (t / 180).toFixed(3);
      if (phase !== "follow") leaf.dataset.turn = (t / 180).toFixed(3);
      const p = clamp(phi, 0, 180);
      const s = Math.sin(p * RAD);
      const c = Math.cos(p * RAD);
      /* Light comes from the viewer's upper left, so a page tilting up
         toward the spine darkens and a page settling flat brightens. */
      const frontDark = 0.66 * Math.pow(clamp(p / 90, 0, 1), 1.35);
      const backDark = 0.66 * Math.pow(clamp((180 - p) / 90, 0, 1), 1.35);
      if (shadeF) shadeF.style.opacity = frontDark.toFixed(3);
      if (shadeB) shadeB.style.opacity = backDark.toFixed(3);
      if (glintF) glintF.style.opacity = (0.32 * Math.exp(-Math.pow((p - 38) / 24, 2))).toFixed(3);
      if (glintB) glintB.style.opacity = (0.26 * Math.exp(-Math.pow((p - 142) / 24, 2))).toFixed(3);
      /* The lifted sheet throws a shadow past its own edge, onto the page
         it uncovers and, once it crosses the spine, onto the facing page. */
      const startW = clamp((112 - p) / 40, 0, 1);
      const endW = clamp((p - 68) / 40, 0, 1);
      castStart.style.opacity = (0.66 * s * startW).toFixed(3);
      castStart.style.transform = "scaleX(" + Math.min(1.05, Math.max(0.03, Math.max(0, c) * 1.08 + 0.38 * s)).toFixed(3) + ")";
      if (castEnd) {
        castEnd.style.opacity = (0.66 * s * endW).toFixed(3);
        castEnd.style.transform = "scaleX(" + Math.min(1.05, Math.max(0.03, Math.max(0, -c) * 1.08 + 0.38 * s)).toFixed(3) + ")";
      }
    }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      const dt = Math.min(0.034, Math.max(0.001, (now - last) / 1000));
      last = now;
      if (phase === "follow") {
        /* The sheet has mass: it chases the finger through a critically
           damped spring instead of snapping to it. */
        const k = 900, c = 2 * Math.sqrt(k);
        const a = k * (target - theta) - c * vel;
        vel += a * dt;
        theta += vel * dt;
        paint(theta);
        if (Math.abs(target - theta) > 0.05 || Math.abs(vel) > 1) raf = requestAnimationFrame(frame);
        return;
      }
      if (phase === "settle") {
        /* Heavy page: low stiffness, a touch under critical damping, so it
           swings over and lands with one small settle. */
        const k = 150, c = 2 * Math.sqrt(k) * 0.8;
        const a = k * (settleTo - theta) - c * vel;
        vel += a * dt;
        theta += vel * dt;
        /* It cannot sink through the page it lands on: a small bounce. */
        if (settleTo === 0 && theta < -3) { theta = -3; vel = Math.abs(vel) * 0.25; }
        if (settleTo === 180 && theta > 183) { theta = 183; vel = -Math.abs(vel) * 0.25; }
        paint(theta);
        if (Math.abs(settleTo - theta) < 0.15 && Math.abs(vel) < 4) {
          theta = settleTo;
          paint(theta);
          phase = "idle";
          const done = settleDone;
          settleDone = null;
          if (done) done(settleTo === 180);
          return;
        }
        raf = requestAnimationFrame(frame);
      }
    }

    function kick() {
      if (!raf && alive) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }

    const api = {
      kind,
      get theta() { return theta; },
      get target() { return target; },
      /* Finger moved. t is in progress degrees. */
      follow(t) {
        target = clamp(t, 0, 180);
        leaf.dataset.turn = (target / 180).toFixed(3);
        if (settleDone) { const d = settleDone; settleDone = null; d(null); }
        phase = "follow";
        if (reduce) { theta = target; vel = 0; paint(theta); return; }
        kick();
      },
      /* Jump without animation (used when grabbing a turn mid-flight). */
      set(t) {
        theta = target = clamp(t, 0, 180);
        paint(theta);
      },
      /* Animate to 0 or 180. v0 is the starting speed in degrees/second. */
      settle(to, v0) {
        return new Promise(resolve => {
          if (settleDone) { const d = settleDone; settleDone = null; d(null); }
          settleTo = to >= 90 ? 180 : 0;
          if (typeof v0 === "number" && isFinite(v0)) vel = clamp(v0, -2400, 2400);
          if (reduce) {
            theta = settleTo;
            paint(theta);
            resolve(settleTo === 180);
            return;
          }
          /* A tap or key press still gives the page a firm push. */
          if (settleTo === 180 && vel < 260) vel = Math.max(vel, 260);
          settleDone = resolve;
          phase = "settle";
          kick();
        });
      },
      destroy() {
        alive = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (settleDone) { const d = settleDone; settleDone = null; d(null); }
        [shadeF, glintF, shadeB, glintB, castStart, castEnd].forEach(n => { if (n) n.remove(); });
        leaf.classList.remove("turning", "turn-" + kind);
        leaf.style.removeProperty("transform");
        delete leaf.dataset.turn;
        delete leaf.dataset.shown;
      }
    };
    paint(0);
    return api;
  }

  /* Map a horizontal drag to progress degrees so the grabbed point of the
     page stays under the finger. reach is twice the distance from the hinge
     to the grab point; for a solo page it is a fixed share of its width. */
  function dragAngle(travel, reach) {
    const p = clamp(travel / Math.max(1, reach), 0, 1);
    return Math.acos(1 - 2 * p) / RAD;
  }
  function travelFor(theta, reach) {
    return (1 - Math.cos(clamp(theta, 0, 180) * RAD)) / 2 * reach;
  }

  window.BinderTurn = { arm, dragAngle, travelFor };
})();
