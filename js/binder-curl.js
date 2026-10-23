/* Draggable page curl for the binder spread.
   The mesh is a real cylinder: a grab near the middle of the edge
   curls horizontally, and a grab toward a corner tilts the cylinder
   so the page peels on a diagonal. Card faces and card backs are
   painted once, then the GPU only resamples them. */
(function () {
  const COLS = 28;
  const ROWS = 36;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function program(gl) {
    const vs = compile(gl, gl.VERTEX_SHADER, [
      "attribute vec3 aPos;",
      "attribute vec2 aUv;",
      "attribute float aTheta;",
      "varying vec2 vUv;",
      "varying float vTheta;",
      "void main(){",
      "  gl_Position=vec4(aPos,1.0);",
      "  vUv=aUv;",
      "  vTheta=aTheta;",
      "}"
    ].join("\n"));
    const fs = compile(gl, gl.FRAGMENT_SHADER, [
      "precision mediump float;",
      "uniform sampler2D uFront;",
      "uniform sampler2D uBack;",
      "varying vec2 vUv;",
      "varying float vTheta;",
      "void main(){",
      "  float back=step(1.5707963,vTheta);",
      "  vec4 frontColor=texture2D(uFront,vUv);",
      "  vec4 backColor=texture2D(uBack,vec2(1.0-vUv.x,vUv.y));",
      "  vec4 color=mix(frontColor,backColor,back);",
      "  float shade=mix(0.64+0.36*cos(vTheta*0.72),0.9,step(3.1415,vTheta));",
      "  float spec=smoothstep(0.42,0.0,abs(vTheta-0.82))*0.28;",
      "  gl_FragColor=vec4(color.rgb*(shade+spec),color.a);",
      "}"
    ].join("\n"));
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.bindAttribLocation(prog, 1, "aUv");
    gl.bindAttribLocation(prog, 2, "aTheta");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
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

  function contain(img, x, y, w, h) {
    const ir = img.naturalWidth / img.naturalHeight;
    const box = w / Math.max(1, h);
    if (ir > box) {
      const dh = w / ir;
      return { x: x, y: y + (h - dh) / 2, w: w, h: dh };
    }
    const dw = h * ir;
    return { x: x + (w - dw) / 2, y: y, w: dw, h: h };
  }

  function pill(ctx, text, x, y, fill, color) {
    ctx.font = "800 11px Nunito, sans-serif";
    const w = Math.ceil(ctx.measureText(text).width) + 12;
    const h = 16;
    ctx.fillStyle = fill;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, x + 6, y + h / 2 + 0.5);
  }

  function cardBack(ctx, x, y, w, h) {
    ctx.save();
    roundRect(ctx, x, y, w, h, 5);
    ctx.clip();
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, "#2a6fbf");
    g.addColorStop(1, "#14386e");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(230,197,106,.9)";
    ctx.lineWidth = Math.max(1.5, w * 0.035);
    roundRect(ctx, x + 3, y + 3, w - 6, h - 6, 4);
    ctx.stroke();
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rad = Math.min(w, h) * 0.2;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = "#f4f1ea";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, rad, Math.PI, 0);
    ctx.fillStyle = "#c44747";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = "#f7f4ee";
    ctx.strokeStyle = "#1c1c1c";
    ctx.lineWidth = Math.max(1, w * 0.02);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function paintSheet(face, mode, skipImages) {
    const rect = face.getBoundingClientRect();
    const w = Math.max(2, rect.width);
    const h = Math.max(2, rect.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(w * dpr));
    canvas.height = Math.max(2, Math.round(h * dpr));
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#24262e");
    bg.addColorStop(1, "#16171d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const host = rect;
    face.querySelectorAll(".sleeve").forEach(sleeve => {
      const box = sleeve.getBoundingClientRect();
      const x = box.left - host.left;
      const y = box.top - host.top;
      if (box.width < 2 || box.height < 2) return;
      ctx.save();
      roundRect(ctx, x, y, box.width, box.height, 7);
      ctx.clip();
      const well = ctx.createLinearGradient(x, y, x, y + box.height);
      well.addColorStop(0, "#101116");
      well.addColorStop(1, "#0b0c10");
      ctx.fillStyle = well;
      ctx.fillRect(x, y, box.width, box.height);
      ctx.restore();
      ctx.save();
      roundRect(ctx, x, y, box.width, box.height, 7);
      ctx.strokeStyle = "rgba(255,255,255,.16)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      const empty = sleeve.classList.contains("empty");
      if (mode === "back") {
        if (!empty) cardBack(ctx, x + 1, y + 1, box.width - 2, box.height - 2);
        return;
      }
      if (empty) return;
      const img = sleeve.querySelector("img");
      if (!skipImages && img && img.complete && img.naturalWidth) {
        try {
          const fit = contain(img, x, y, box.width, box.height);
          ctx.save();
          roundRect(ctx, x, y, box.width, box.height, 6);
          ctx.clip();
          ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
          ctx.restore();
        } catch (e) {}
      }
      const price = sleeve.querySelector(".price-pill");
      if (price && price.textContent) pill(ctx, price.textContent, x + 4, y + box.height - 20, "rgba(10,10,14,.62)", "#fff");
      const badge = sleeve.querySelector(".drop-badge [aria-hidden='true']");
      if (badge && badge.textContent) {
        ctx.font = "800 11px Nunito, sans-serif";
        const tw = Math.ceil(ctx.measureText(badge.textContent).width) + 12;
        pill(ctx, badge.textContent, x + box.width - tw - 4, y + box.height - 20, "rgba(246,201,201,.94)", "#1f1f1e");
      }
    });
    const num = face.querySelector(".page-num");
    if (num && num.textContent && mode === "front") {
      ctx.font = "700 12px Nunito, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.42)";
      ctx.textBaseline = "bottom";
      const left = face.classList.contains("page-left") && !face.closest(".book.solo");
      ctx.textAlign = left ? "left" : "right";
      ctx.fillText(num.textContent, left ? 10 : w - 10, h - 3);
    }
    try { ctx.getImageData(0, 0, 1, 1); }
    catch (e) {
      if (!skipImages) return paintSheet(face, mode, true);
      return null;
    }
    return canvas;
  }

  function upload(gl, source) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function smooth(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  function deform(px, py, turn, grab, W, H, flip) {
    // A grab at mid-height keeps the crease vertical. A grab toward a
    // corner slants that crease so the near corner peels first.
    let x = flip ? W - px : px;
    const y = py;
    const g = Math.max(0, Math.min(1, grab));
    const diag = smooth(0.08, 0.42, Math.abs(g - 0.5) * 2);
    const lead = (0.5 - g) * 2;
    const along = y / Math.max(1, H) - 0.5;
    const t = Math.max(0, Math.min(1.06, turn));
    const amount = t * (1.02 + lead * -along * diag * 0.9);
    const crease = W * (1 - Math.max(0.02, Math.min(1.22, amount)));
    const R = Math.max(W * 0.09, W * (0.2 - 0.06 * Math.min(1, t)));
    let rx = x;
    let ry = y;
    let zz = 0;
    let theta = 0;
    if (x > crease) {
      const arc = x - crease;
      theta = arc / R;
      if (theta < Math.PI) {
        rx = crease + R * Math.sin(theta);
        zz = R * (1 - Math.cos(theta));
      } else {
        rx = crease - (arc - Math.PI * R);
        zz = 8;
        theta = Math.PI + 0.05;
      }
      ry = y + Math.sin(Math.min(theta, Math.PI)) * H * 0.05 * lead * diag;
    }
    if (flip) rx = W - rx;
    const persp = 1 / (1 + zz * 0.0034);
    const ox = W * (flip ? 0.64 : 0.36);
    const oy = H * (0.5 + lead * diag * 0.12);
    return {
      x: (rx - ox) * persp + ox,
      y: (ry - oy) * persp + oy,
      z: zz,
      theta: theta
    };
  }

  function start(opts) {
    try { return mount(opts); }
    catch (e) { return null; }
  }
  function mount(opts) {
    const book = opts && opts.book;
    const leaf = opts && opts.leaf;
    if (!book || !leaf || !window.WebGLRenderingContext) return null;
    const face = leaf.querySelector(":scope > .face.front");
    if (!face) return null;
    const bookRect = book.getBoundingClientRect();
    const leafRect = leaf.getBoundingClientRect();
    if (bookRect.width < 40 || leafRect.width < 40 || leafRect.height < 40) return null;
    const front = paintSheet(face, "front");
    const back = paintSheet(face, "back");
    if (!front || !back) return null;

    const canvas = document.createElement("canvas");
    canvas.className = "curl-view";
    canvas.setAttribute("aria-hidden", "true");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(bookRect.width * dpr));
    canvas.height = Math.max(2, Math.round(bookRect.height * dpr));
    canvas.style.width = bookRect.width + "px";
    canvas.style.height = bookRect.height + "px";
    const attrs = { alpha: true, premultipliedAlpha: false, antialias: true, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: false };
    const gl = canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs);
    if (!gl) return null;
    const prog = program(gl);
    if (!prog) return null;

    const verts = (COLS + 1) * (ROWS + 1);
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const theta = new Float32Array(verts);
    const index = new Uint16Array(COLS * ROWS * 6);
    let n = 0;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const a = y * (COLS + 1) + x;
        index[n++] = a;
        index[n++] = a + 1;
        index[n++] = a + (COLS + 1);
        index[n++] = a + 1;
        index[n++] = a + (COLS + 1) + 1;
        index[n++] = a + (COLS + 1);
      }
    }
    const posBuf = gl.createBuffer();
    const uvBuf = gl.createBuffer();
    const thBuf = gl.createBuffer();
    const ixBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ixBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);

    const frontTex = upload(gl, front);
    const backTex = upload(gl, back);
    const uFront = gl.getUniformLocation(prog, "uFront");
    const uBack = gl.getUniformLocation(prog, "uBack");

    const shadow = document.createElement("div");
    shadow.className = "curl-cast";
    shadow.setAttribute("aria-hidden", "true");
    book.append(shadow, canvas);

    const pageX = leafRect.left - bookRect.left;
    const pageY = leafRect.top - bookRect.top;
    const W = leafRect.width;
    const H = leafRect.height;
    const bookW = bookRect.width;
    const bookH = bookRect.height;
    const flip = opts.dir < 0;
    let dead = false;

    function render(turn, grab) {
      if (dead) return;
      const g = grab == null ? 0.5 : grab;
      let k = 0;
      let t = 0;
      for (let y = 0; y <= ROWS; y++) {
        for (let x = 0; x <= COLS; x++) {
          const px = (x / COLS) * W;
          const py = (y / ROWS) * H;
          const p = deform(px, py, turn, g, W, H, flip);
          const sx = pageX + p.x;
          const sy = pageY + p.y;
          pos[k++] = (sx / bookW) * 2 - 1;
          pos[k++] = 1 - (sy / bookH) * 2;
          pos[k++] = Math.max(-1, Math.min(1, -p.z * 0.004));
          uv[t * 2] = x / COLS;
          uv[t * 2 + 1] = 1 - y / ROWS;
          theta[t] = p.theta;
          t++;
        }
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frontTex);
      gl.uniform1i(uFront, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, backTex);
      gl.uniform1i(uBack, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, thBuf);
      gl.bufferData(gl.ARRAY_BUFFER, theta, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ixBuf);
      gl.drawElements(gl.TRIANGLES, index.length, gl.UNSIGNED_SHORT, 0);

      const lift = Math.sin(Math.PI * Math.max(0, Math.min(1, turn)));
      const travel = W * Math.max(0, Math.min(1, turn));
      const x = flip ? pageX + travel * 0.42 : pageX + W * (1 - Math.min(1, turn)) - W * 0.16;
      const slant = (g - 0.5) * 2 * smooth(0.08, 0.42, Math.abs(g - 0.5) * 2) * -16;
      shadow.style.opacity = String(0.16 + lift * 0.55);
      shadow.style.transformOrigin = flip ? "right center" : "left center";
      shadow.style.transform = "translate3d(" + x.toFixed(1) + "px,0,0) rotate(" + slant.toFixed(2) + "deg)";
    }

    function destroy() {
      if (dead) return;
      dead = true;
      if (canvas.parentNode) canvas.remove();
      if (shadow.parentNode) shadow.remove();
    }

    return { render: render, destroy: destroy };
  }

  window.BinderCurl = { start: start };
})();
