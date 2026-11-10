// Aura — a stand-alone fake camera, opened from its own QR on the
// spectator's phone. Nothing is needed on the performer's phone.
//
//   1. Pick screen: the performer taps the symbol (or it comes from ?s=star).
//   2. Camera: the symbol preview is on the viewfinder. Anywhere on screen,
//      two fingers move + resize + rotate it together.
//   3. Shutter: in the same tap, the photo (with the symbol blended in, named
//      and dated like a camera photo) is saved. iPhone: the share sheet opens
//      → "Save Image" → Photos. Android: it downloads straight away.
(() => {
  "use strict";

  const parts = location.pathname.split("/").filter(Boolean);
  const code = parts[0] === "a" ? parts[1] || "" : "";
  const params = new URLSearchParams(location.search);
  const DEBUG = params.get("debug") === "1";
  const MAX_EDGE = 2400;
  const CLEAN_URL = "https://www.google.com/";
  const STRENGTHS = [0.3, 0.5, 0.7, 0.9];
  const SHAPES = ["circle", "cross", "waves", "square", "star"];
  // Sets of symbols. "vector" sets are drawn (glow/shadow); "image" sets use
  // real photographed effects, multiplied onto the photo (white = no change).
  const SUITS = ["hearts", "diamonds", "clubs", "spades"];
  const VALUES = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  // Sets of symbols. "vector" sets are drawn (glow/shadow); "image" sets are
  // real photographed shadows, multiplied onto the photo (white = no change).
  const SETS = {
    light: { type: "vector", shapes: SHAPES },
    shadow: { type: "image", blend: "multiply", files: Object.fromEntries(SHAPES.map((k) => [k, `/sets/shadow/${k}.png?v=2`])) },
  };
  const CARD = (name) => `/sets/cards/${name}.png?v=2`;
  let currentSet = params.get("set") === "light" ? "light" : "shadow";
  const images = {};
  function loadImage(url) {
    if (!images[url]) {
      images[url] = new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = url;
      });
    }
    return images[url];
  }

  const $ = (id) => document.getElementById(id);
  const pick = $("pick"), camView = $("camView");
  const cam = $("cam"), shutter = $("shutter"), flip = $("flip"), focusEl = $("focus");
  const flash = $("flash");
  const overlay = $("overlay"), overlayPath = $("overlayPath"), overlayImg = $("overlayImg");
  const styleChip = $("styleChip"), strengthChip = $("strengthChip");
  const preview = $("preview"), previewImg = $("previewImg"), debugEl = $("debug");

  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  let stream = null;
  let facing = "environment";
  // The symbol, in screen terms: centre (px) and size (px of the 100-unit box).
  const sym = {
    shape: null,
    style: params.get("look") === "shadow" ? "shadow" : "glow",
    strength: 0.3,
    x: innerWidth / 2,
    y: innerHeight * 0.32,
    size: Math.min(innerWidth, innerHeight) * 0.32,
    rot: 0,
  };
  let device = { make: "", model: "" };
  let shots = 0;
  let wakeLock = null;

  function log(...a) {
    if (!DEBUG) return;
    debugEl.hidden = false;
    debugEl.textContent = (a.join(" ") + "\n" + debugEl.textContent).slice(0, 800);
  }

  ["contextmenu", "selectstart", "dragstart", "gesturestart"].forEach((t) =>
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  document.addEventListener("pointerdown", () => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }
    keepAwake();
  }, { capture: true });

  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (_) {}
  }

  // ---------- which phone is this (camera-like file name and details) ----------
  async function detectDevice() {
    let model = "";
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const v = await navigator.userAgentData.getHighEntropyValues(["model"]);
        model = v.model || "";
      }
    } catch (_) {}
    if (!model) {
      const m = navigator.userAgent.match(/Android [^;]+; ([^;)]+?)(?: Build|\))/);
      if (m && m[1] !== "K") model = m[1].trim();
    }
    let make = "";
    if (/^(SM-|GT-|SC-|SCG)/i.test(model) || /samsung/i.test(navigator.userAgent)) make = "samsung";
    else if (/pixel/i.test(model)) make = "Google";
    else if (/redmi|poco|xiaomi|^2\d{3}/i.test(model)) make = "Xiaomi";
    else if (/oneplus|^CPH|^NE2|^PJ/i.test(model)) make = "OnePlus";
    else if (IOS) { make = "Apple"; model = "iPhone"; }
    device = { make, model };
    log("device", make, model);
  }

  function fileName(d) {
    const p = (n, l = 2) => String(n).padStart(l, "0");
    const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    if (device.make === "samsung") return `${date}_${time}.jpg`;
    if (device.make === "Google") return `PXL_${date}_${time}${p(d.getMilliseconds(), 3)}.jpg`;
    return `IMG_${date}_${time}.jpg`;
  }

  // ---------- camera ----------
  async function startCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      });
      cam.srcObject = stream;
      cam.classList.toggle("mirror", facing === "user");
      await cam.play().catch(() => {});
      log("camera", cam.videoWidth + "x" + cam.videoHeight);
    } catch (err) {
      log("camera error:", err && err.name);
    }
  }

  flip.addEventListener("click", (e) => {
    e.stopPropagation();
    facing = facing === "environment" ? "user" : "environment";
    startCamera();
  });

  // ---------- step 1: the picker ----------
  // Row 1: ESP shapes → straight to the camera.
  // Row 2: suits → selects a suit and wakes up the value rows.
  // Rows 3–5: A–5, 6–10, J Q K → straight to the camera with that card.
  let suit = null;

  function tile(kind, name, src) {
    const b = document.createElement("button");
    b.dataset.kind = kind;
    b.dataset.v = name;
    b.setAttribute("aria-label", name);
    b.innerHTML = `<img src="${src}" alt="">`;
    return b;
  }
  const rowShape = document.querySelector('.prow[data-kind="shape"]');
  SHAPES.forEach((n) => rowShape.appendChild(tile("shape", n, `/sets/shadow/${n}.png?v=2`)));
  const rowSuit = document.querySelector('.prow[data-kind="suit"]');
  SUITS.forEach((n) => rowSuit.appendChild(tile("suit", n, CARD(n))));
  document.querySelectorAll('.prow[data-kind="value"]').forEach((r) =>
    r.dataset.list.split(",").forEach((n) => r.appendChild(tile("value", n, CARD(n)))));

  pick.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.kind === "shape") {
      chooseShape(b.dataset.v);
    } else if (b.dataset.kind === "suit") {
      suit = suit === b.dataset.v ? null : b.dataset.v;
      document.querySelectorAll('button[data-kind="suit"]').forEach((x) => x.classList.toggle("sel", x.dataset.v === suit));
      document.querySelectorAll(".prow.values").forEach((r) => r.classList.toggle("off", !suit));
      if (navigator.vibrate) navigator.vibrate(8);
    } else if (b.dataset.kind === "value" && suit) {
      chooseCard(b.dataset.v, suit);
    }
  });
  // Load the card images in the background so the card builds instantly.
  [...SUITS, ...VALUES].forEach((n) => loadImage(CARD(n)));

  async function chooseShape(shape) {
    const set = SETS[currentSet];
    sym.shape = shape;
    sym.image = null;
    if (set.type === "image") {
      sym.image = await loadImage(set.files[shape]);
      if (!sym.image) return;
      overlayImg.setAttribute("href", set.files[shape]);
    }
    openCamera(set.type === "image");
  }

  // Where the solid part of a shadow image starts and ends (fractions 0–1),
  // ignoring its soft edge.
  function inkBox(img) {
    const n = 256, c = document.createElement("canvas");
    c.width = c.height = n;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    let x0 = n, y0 = n, x1 = 0, y1 = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (d[(y * n + x) * 4] < 0.82 * 255) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { x0: x0 / n, y0: y0 / n, x1: (x1 + 1) / n, y1: (y1 + 1) / n };
  }

  // A card is one shadow: the value above the suit, like a card's corner.
  async function chooseCard(value, s) {
    const [vi, si] = await Promise.all([loadImage(CARD(value)), loadImage(CARD(s))]);
    if (!vi || !si) return;
    const N = 1024;
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, N, N);
    // Placed as close as possible without the solid parts overlapping: the
    // suit's top meets the value's bottom (measured on each image), and their
    // soft edges blend. "darken" keeps the darker of the two where they meet,
    // like two real shadows from one lamp, so there's no doubled seam.
    g.globalCompositeOperation = "darken";
    const vs = N * 0.56, ss = N * 0.46;          // value and suit sizes (images have margins)
    const vb = inkBox(vi), sb = inkBox(si);
    let vy = 0;
    let sy = vy + vb.y1 * vs - sb.y0 * ss;
    const top = vy + vb.y0 * vs, bottom = sy + sb.y1 * ss;
    const shift = (N - (bottom - top)) / 2 - top;  // centre the pair in the layer
    vy += shift; sy += shift;
    g.drawImage(vi, (N - vs) / 2, vy, vs, vs);
    g.drawImage(si, (N - ss) / 2, sy, ss, ss);
    sym.shape = "card";
    sym.image = c;
    overlayImg.setAttribute("href", c.toDataURL("image/png"));
    openCamera(true);
  }

  function openCamera(isImage) {
    styleChip.hidden = isImage;
    pick.hidden = true;
    camView.hidden = false;
    if (navigator.vibrate) navigator.vibrate(10);
    renderOverlay();
    if (!stream) startCamera();
    cam.play().catch(() => {});
  }

  // ---------- the symbols ----------
  const PATHS = {
    circle: "M38 0A38 38 0 1 1-38 0A38 38 0 1 1 38 0Z",
    cross: "M0-42V42M-42 0H42",
    square: "M-35-35H35V35H-35Z",
    waves: (() => {
      let d = "";
      for (const yy of [-26, 0, 26]) {
        for (let i = 0; i <= 48; i++) {
          const t = i / 48;
          d += (i === 0 ? "M" : "L") + (-42 + t * 84).toFixed(2) + " " + (yy + Math.sin(t * Math.PI * 4) * 6.5).toFixed(2);
        }
      }
      return d;
    })(),
    star: (() => {
      let d = "";
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
        d += (i === 0 ? "M" : "L") + (Math.cos(a) * 43).toFixed(2) + " " + (Math.sin(a) * 43 + 4).toFixed(2);
      }
      return d + "Z";
    })(),
  };

  // ---------- the live preview ----------
  let frame = 0;
  function renderOverlay() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawOverlay);
  }
  function drawOverlay() {
    if (!sym.shape) { overlay.setAttribute("hidden", ""); return; }
    overlay.removeAttribute("hidden");
    overlay.classList.toggle("image", !!sym.image);
    if (sym.image) {
      overlay.style.width = overlay.style.height = sym.size + "px";
      overlay.style.transform =
        `translate(${sym.x - sym.size / 2}px, ${sym.y - sym.size / 2}px) rotate(${sym.rot}rad)`;
      overlay.style.filter = "none";
      overlay.style.opacity = String(imageAlpha());
      return;
    }
    overlayPath.setAttribute("d", PATHS[sym.shape]);
    overlay.classList.toggle("glow", sym.style === "glow");
    overlay.classList.toggle("shadow", sym.style === "shadow");
    overlay.style.width = overlay.style.height = sym.size + "px";
    overlay.style.transform =
      `translate(${sym.x - sym.size / 2}px, ${sym.y - sym.size / 2}px) rotate(${sym.rot}rad)`;
    const edge = sym.style === "glow" ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.6)";
    const glow = sym.style === "glow" ? "rgba(255,220,160,.9)" : "rgba(20,18,30,.7)";
    overlay.style.filter =
      `drop-shadow(0 0 1px ${edge}) drop-shadow(0 0 1px ${edge}) drop-shadow(0 0 ${sym.size * 0.06}px ${glow})`;
    overlay.style.opacity = String(0.5 + 0.5 * sym.strength);
  }

  function setStyle(s) {
    sym.style = s;
    styleChip.textContent = s === "glow" ? "Glow" : "Shadow";
    renderOverlay();
  }
  styleChip.addEventListener("click", (e) => { e.stopPropagation(); setStyle(sym.style === "glow" ? "shadow" : "glow"); });
  strengthChip.addEventListener("click", (e) => {
    e.stopPropagation();
    const i = (STRENGTHS.indexOf(sym.strength) + 1) % STRENGTHS.length;
    sym.strength = STRENGTHS[i];
    strengthChip.textContent = Math.round(sym.strength * 100) + "%";
    renderOverlay();
  });

  // ---------- gestures, anywhere on the viewfinder ----------
  // Two fingers only: move, resize and rotate the symbol together, around its
  // own centre. One finger does nothing.
  const pointers = new Map();
  let g = null;      // gesture start state

  function snapshot() {
    const pts = [...pointers.values()];
    if (!pts.length) { g = null; return; }
    g = { n: pts.length, x: sym.x, y: sym.y, size: sym.size, rot: sym.rot };
    if (pts.length === 1) {
      g.p = { ...pts[0] };
    } else {
      const [a, b] = pts;
      g.m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g.d = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
      g.a = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }

  // The symbol's centre stays on the viewfinder, above the button bar.
  function keepAboveButtons() {
    const bar = document.getElementById("bottom").getBoundingClientRect().top;
    sym.x = Math.max(0, Math.min(innerWidth, sym.x));
    sym.y = Math.max(0, Math.min(bar - 12, sym.y));
  }

  function apply() {
    const pts = [...pointers.values()];
    if (!g || !pts.length) return;
    // Only two fingers move the symbol; a single finger does nothing.
    if (g.n >= 2 && pts.length >= 2) {
      const [a, b] = pts;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = Math.hypot(b.x - a.x, b.y - a.y) / g.d;
      const da = Math.atan2(b.y - a.y, b.x - a.x) - g.a;
      const lim = Math.min(innerWidth, innerHeight);
      const size = Math.max(lim * 0.08, Math.min(lim * 1.2, g.size * k));
      // It turns and grows around its own centre, and slides with the
      // fingers, so it never swings away when the fingers are elsewhere.
      sym.x = g.x + (m.x - g.m.x);
      sym.y = g.y + (m.y - g.m.y);
      sym.size = size;
      sym.rot = g.rot + da;
      keepAboveButtons();
    }
    renderOverlay();
  }

  // Raw touch events: on iPhone, Safari interrupts pointer events when two
  // fingers come down (it wants to zoom), so touches are read directly.
  function readTouches(list) {
    pointers.clear();
    for (const t of list) {
      if (t.target && t.target.closest && t.target.closest("#bottom")) continue;
      pointers.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
  }
  const onTouch = (e) => {
    // Touches on the buttons are left alone, so taps on them still work.
    if (e.target.closest && e.target.closest("#bottom")) return;
    e.preventDefault();
    const before = pointers.size;
    readTouches(e.touches);
    if (e.type === "touchmove" && pointers.size === before && g) apply();
    else snapshot(); // fingers added or lifted: restart from where it is now
  };
  for (const t of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    camView.addEventListener(t, onTouch, { passive: false });
  }
  // Safari's own pinch/rotate gesture events: block them so it never zooms.
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  function jumpTo(x, y) {
    focusEl.style.left = x + "px";
    focusEl.style.top = y + "px";
    focusEl.animate(
      [
        { opacity: 0, transform: "scale(1.4)" },
        { opacity: 1, transform: "scale(1)", offset: 0.25 },
        { opacity: 1, transform: "scale(1)", offset: 0.8 },
        { opacity: 0, transform: "scale(1)" },
      ],
      { duration: 1100, easing: "ease-out" }
    );
    sym.x = x;
    sym.y = y;
    renderOverlay();
  }

  // ---------- drawing the symbol into the photo ----------
  function softStroke(ctx, shape, cx, cy, scale, lineW, color, blur, rot = 0) {
    const off = ctx.canvas.width * 3;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = off;
    ctx.translate(cx - off, cy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.lineWidth = lineW / scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#000";
    ctx.stroke(new Path2D(PATHS[shape]));
    ctx.restore();
  }

  function localLight(src, cx, cy, r) {
    const s = 24;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, cx - r, cy - r, r * 2, r * 2, 0, 0, s, s);
    const d = g.getImageData(0, 0, s, s).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4) / 255;
  }

  function overlayInPhoto(canvas) {
    const vw = cam.videoWidth || 1, vh = cam.videoHeight || 1;
    const W = innerWidth, H = innerHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    let fx = (sym.x - (W - dw) / 2) / dw;
    const fy = (sym.y - (H - dh) / 2) / dh;
    if (facing === "user") fx = 1 - fx;
    const k = canvas.width / vw;
    return { cx: fx * canvas.width, cy: fy * canvas.height, box: (sym.size / s) * k, rot: facing === "user" ? -sym.rot : sym.rot };
  }

  // How strongly an image symbol is applied, from the % chip.
  function imageAlpha() { return Math.min(1, 0.25 + sym.strength); }

  function addImageSymbol(canvas) {
    const ctx = canvas.getContext("2d");
    const { cx, cy, box, rot } = overlayInPhoto(canvas);
    ctx.save();
    ctx.globalCompositeOperation = SETS[currentSet].blend || "multiply";
    ctx.globalAlpha = imageAlpha();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.drawImage(sym.image, -box / 2, -box / 2, box, box);
    ctx.restore();
  }

  function addSymbol(canvas) {
    if (!sym.shape) return;
    if (sym.image) return addImageSymbol(canvas);
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d");
    const { cx, cy, box, rot } = overlayInPhoto(canvas);
    const scale = box / 100;
    const lw = 7.5 * scale;
    const k = sym.strength;
    const light = localLight(canvas, cx, cy, box * 0.35);

    const layer = document.createElement("canvas");
    layer.width = W; layer.height = H;
    const lg = layer.getContext("2d");

    if (sym.style === "shadow") {
      const a = (0.25 + 0.45 * light) * k * 1.4;
      softStroke(lg, sym.shape, cx, cy, scale, lw * 1.6, `rgba(20,18,30,${Math.min(1, a * 0.6)})`, box * 0.08, rot);
      softStroke(lg, sym.shape, cx, cy, scale, lw, `rgba(15,12,25,${Math.min(1, a)})`, box * 0.025, rot);
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    } else {
      const a = (0.35 + 0.5 * (1 - light)) * k * 1.4;
      softStroke(lg, sym.shape, cx, cy, scale, lw * 2.4, `rgba(255,226,180,${Math.min(1, a * 0.55)})`, box * 0.11, rot);
      softStroke(lg, sym.shape, cx, cy, scale, lw, `rgba(255,244,225,${Math.min(1, a)})`, box * 0.03, rot);
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    }

    const r = Math.round(box * 0.65);
    const x0 = Math.max(0, Math.round(cx - r)), y0 = Math.max(0, Math.round(cy - r));
    const w = Math.min(W - x0, r * 2), h = Math.min(H - y0, r * 2);
    if (w > 0 && h > 0) {
      const img = ctx.getImageData(x0, y0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * 6;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
      }
      ctx.putImageData(img, x0, y0);
    }
  }

  // ---------- EXIF: make the file look like a camera photo ----------
  function exifDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function buildExif(d) {
    const enc = (s) => { const b = new TextEncoder().encode(s); const o = new Uint8Array(b.length + 1); o.set(b); return o; };
    const dt = enc(exifDate(d));
    const m = -d.getTimezoneOffset(), a = Math.abs(m);
    const tz = enc(`${m >= 0 ? "+" : "-"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`);

    const ifd0 = [];
    if (device.make) ifd0.push({ tag: 0x010f, type: 2, data: enc(device.make) });
    if (device.model) ifd0.push({ tag: 0x0110, type: 2, data: enc(device.model) });
    ifd0.push({ tag: 0x0112, type: 3, value: 1 });
    ifd0.push({ tag: 0x0132, type: 2, data: dt });
    ifd0.push({ tag: 0x8769, type: 4, value: 0 });
    const exif = [
      { tag: 0x9003, type: 2, data: dt },
      { tag: 0x9004, type: 2, data: dt },
      { tag: 0x9011, type: 2, data: tz },
    ];

    const ifdSize = (n) => 2 + n * 12 + 4;
    const dataSize = (list) => list.reduce((s, e) => s + (e.data && e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
    const ifd0Off = 8;
    const ifd0DataOff = ifd0Off + ifdSize(ifd0.length);
    const exifOff = ifd0DataOff + dataSize(ifd0);
    const exifDataOff = exifOff + ifdSize(exif.length);
    const total = exifDataOff + dataSize(exif);
    ifd0[ifd0.length - 1].value = exifOff;

    const buf = new Uint8Array(total);
    const v = new DataView(buf.buffer);
    buf.set([0x49, 0x49, 0x2a, 0x00]);
    v.setUint32(4, ifd0Off, true);

    const writeIfd = (list, off, dataOff) => {
      v.setUint16(off, list.length, true);
      let p = off + 2, dp = dataOff;
      for (const e of list) {
        v.setUint16(p, e.tag, true);
        v.setUint16(p + 2, e.type, true);
        if (e.data) {
          v.setUint32(p + 4, e.data.length, true);
          if (e.data.length <= 4) buf.set(e.data, p + 8);
          else { v.setUint32(p + 8, dp, true); buf.set(e.data, dp); dp += e.data.length + (e.data.length & 1); }
        } else {
          v.setUint32(p + 4, 1, true);
          if (e.type === 3) v.setUint16(p + 8, e.value, true); else v.setUint32(p + 8, e.value, true);
        }
        p += 12;
      }
      v.setUint32(p, 0, true);
    };
    writeIfd(ifd0, ifd0Off, ifd0DataOff);
    writeIfd(exif, exifOff, exifDataOff);

    const seg = new Uint8Array(10 + total);
    const len = 8 + total;
    seg.set([0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    seg.set(buf, 10);
    return seg;
  }

  // Everything here is synchronous on purpose: the iPhone only opens the
  // share sheet if it's asked within the same tap as the shutter.
  function jpegWithExif(canvas, d) {
    const url = canvas.toDataURL("image/jpeg", 0.92);
    const bin = atob(url.slice(url.indexOf(",") + 1));
    const src = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) src[i] = bin.charCodeAt(i);
    let rest = 2;
    if (src[2] === 0xff && src[3] === 0xe0) rest = 4 + ((src[4] << 8) | src[5]);
    const exif = buildExif(d);
    const out = new Uint8Array(2 + exif.length + (src.length - rest));
    out.set([0xff, 0xd8]);
    out.set(exif, 2);
    out.set(src.subarray(rest), 2 + exif.length);
    return out;
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function sendToPerformer(file) {
    if (!/^[A-Za-z0-9]{6,16}$/.test(code)) return;
    fetch("/api/photo/" + encodeURIComponent(code), {
      method: "POST", headers: { "Content-Type": "image/jpeg" }, body: file,
    }).catch(() => {});
  }

  // After saving: mark this phone as used (so the page never shows again
  // from history or a suggestion) and turn the tab into Google.
  function done() {
    shots++;
    try { localStorage.setItem("aura-used", String(Date.now())); } catch (_) {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    camView.hidden = true;
    setTimeout(() => location.replace(CLEAN_URL), IOS ? 300 : 1200);
  }

  // ---------- step 3: the shutter ----------
  shutter.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!cam.videoWidth) return;
    const when = new Date();

    const vw = cam.videoWidth, vh = cam.videoHeight;
    const s = Math.min(1, MAX_EDGE / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * s);
    canvas.height = Math.round(vh * s);
    const ctx = canvas.getContext("2d");
    if (facing === "user") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(cam, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    addSymbol(canvas);

    const bytes = jpegWithExif(canvas, when);
    const file = new File([bytes], fileName(when), { type: "image/jpeg", lastModified: when.getTime() });
    log("ready", file.name, Math.round(file.size / 1024) + "KB", sym.shape, sym.style, sym.strength);

    flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 160, easing: "ease-out" });
    sendToPerformer(file);

    if (DEBUG) {
      previewImg.src = URL.createObjectURL(file);
      preview.hidden = false;
    }

    if (IOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      // Same tap → share sheet → "Save Image" → Photos.
      navigator.share({ files: [file] })
        .then(() => { log("saved via share"); done(); })
        .catch((err) => log("share:", err && err.name)); // closed: shoot again
    } else {
      download(file); // Android: straight to the Download album
      done();
    }
  });

  preview.addEventListener("click", () => { preview.hidden = true; });

  const leave = () => { if (shots > 0) location.replace(CLEAN_URL); };
  window.addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave();
    if (document.visibilityState === "visible") keepAwake();
  });

  // ---------- go ----------
  keepAwake();
  detectDevice();
  startCamera(); // ask for the camera now, so it's ready by the time a symbol is picked
  const preset = params.get("s");
  if (SHAPES.includes(preset)) chooseShape(preset);
})();
