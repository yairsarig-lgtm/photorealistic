// Aura — a stand-alone fake camera, opened from its own QR on the
// spectator's phone. Nothing is needed on the performer's phone.
//
//   1. Pick screen: the performer taps the symbol (or it comes from ?s=star).
//   2. Camera: the symbol preview is on the viewfinder. One finger drags it,
//      a pinch resizes it, a double-tap switches glow/shadow, tapping the
//      viewfinder moves it there.
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

  const $ = (id) => document.getElementById(id);
  const pick = $("pick"), camView = $("camView");
  const cam = $("cam"), shutter = $("shutter"), flip = $("flip"), focusEl = $("focus");
  const flash = $("flash");
  const overlay = $("overlay"), overlayPath = $("overlayPath");
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
    strength: 0.5,
    x: innerWidth / 2,
    y: innerHeight * 0.32,
    size: Math.min(innerWidth, innerHeight) * 0.32,
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

  // ---------- step 1: pick the symbol ----------
  function choose(shape) {
    sym.shape = shape;
    pick.hidden = true;
    camView.hidden = false;
    if (navigator.vibrate) navigator.vibrate(10);
    renderOverlay();
    if (!stream) startCamera();
    cam.play().catch(() => {});
  }
  document.querySelectorAll("#pickGrid button").forEach((b) =>
    b.addEventListener("click", () => choose(b.dataset.v)));

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
  function renderOverlay() {
    if (!sym.shape) { overlay.setAttribute("hidden", ""); return; }
    overlay.removeAttribute("hidden");
    overlayPath.setAttribute("d", PATHS[sym.shape]);
    overlay.classList.toggle("glow", sym.style === "glow");
    overlay.classList.toggle("shadow", sym.style === "shadow");
    overlay.style.width = overlay.style.height = sym.size + "px";
    overlay.style.transform = `translate(${sym.x - sym.size / 2}px, ${sym.y - sym.size / 2}px)`;
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

  // One finger drags. Two fingers only resize (the symbol stays where it is).
  // Double-tap switches glow/shadow.
  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;

  function startGesture() {
    const pts = [...pointers.values()];
    if (!pts.length) { gesture = null; return; }
    gesture = { n: pts.length, sx: sym.x, sy: sym.y, size: sym.size, p0: pts[0] };
    if (pts.length >= 2) gesture.d0 = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
  }

  overlay.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tapStart = pointers.size === 1 ? { t: performance.now(), x: e.clientX, y: e.clientY } : null;
    startGesture();
  });
  function onMove(e) {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.values()];
    if (pts.length === 1 && gesture.n === 1) {
      sym.x = gesture.sx + (pts[0].x - gesture.p0.x);
      sym.y = gesture.sy + (pts[0].y - gesture.p0.y);
    } else if (pts.length >= 2 && gesture.n >= 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const m = Math.min(innerWidth, innerHeight);
      sym.size = Math.max(m * 0.1, Math.min(m * 0.95, gesture.size * (d / gesture.d0)));
    }
    renderOverlay();
  }
  overlay.addEventListener("pointermove", onMove);
  const endPointer = (e) => { pointers.delete(e.pointerId); startGesture(); };
  // A double-tap is two quick taps that don't move: drags and pinches never count.
  let tapStart = null;
  overlay.addEventListener("pointerup", (e) => {
    const t = tapStart;
    tapStart = null;
    if (t && pointers.size === 1 && performance.now() - t.t < 250 &&
        Math.hypot(e.clientX - t.x, e.clientY - t.y) < 10) {
      const now = performance.now();
      if (now - lastTap < 350) { setStyle(sym.style === "glow" ? "shadow" : "glow"); lastTap = 0; }
      else lastTap = now;
    } else {
      lastTap = 0;
    }
  });
  overlay.addEventListener("pointerup", endPointer);
  overlay.addEventListener("pointercancel", endPointer);

  // A pinch whose second finger lands on the viewfinder (not on the symbol)
  // still resizes: track it there too.
  cam.addEventListener("pointerdown", (e) => {
    if (pointers.size >= 1) {
      tapStart = null;
      lastTap = 0;
      cam.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      startGesture();
      return;
    }
    // Otherwise: tap-to-focus, and the symbol jumps there.
    focusEl.style.left = e.clientX + "px";
    focusEl.style.top = e.clientY + "px";
    focusEl.animate(
      [
        { opacity: 0, transform: "scale(1.4)" },
        { opacity: 1, transform: "scale(1)", offset: 0.25 },
        { opacity: 1, transform: "scale(1)", offset: 0.8 },
        { opacity: 0, transform: "scale(1)" },
      ],
      { duration: 1100, easing: "ease-out" }
    );
    sym.x = e.clientX;
    sym.y = e.clientY;
    renderOverlay();
  });
  cam.addEventListener("pointermove", onMove);
  cam.addEventListener("pointerup", endPointer);
  cam.addEventListener("pointercancel", endPointer);

  // ---------- drawing the symbol into the photo ----------
  function softStroke(ctx, shape, cx, cy, scale, lineW, color, blur) {
    const off = ctx.canvas.width * 3;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = off;
    ctx.translate(cx - off, cy);
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
    return { cx: fx * canvas.width, cy: fy * canvas.height, box: (sym.size / s) * k };
  }

  function addSymbol(canvas) {
    if (!sym.shape) return;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d");
    const { cx, cy, box } = overlayInPhoto(canvas);
    const scale = box / 100;
    const lw = 7.5 * scale;
    const k = sym.strength;
    const light = localLight(canvas, cx, cy, box * 0.35);

    const layer = document.createElement("canvas");
    layer.width = W; layer.height = H;
    const lg = layer.getContext("2d");

    if (sym.style === "shadow") {
      const a = (0.25 + 0.45 * light) * k * 1.4;
      softStroke(lg, sym.shape, cx, cy, scale, lw * 1.6, `rgba(20,18,30,${Math.min(1, a * 0.6)})`, box * 0.08);
      softStroke(lg, sym.shape, cx, cy, scale, lw, `rgba(15,12,25,${Math.min(1, a)})`, box * 0.025);
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    } else {
      const a = (0.35 + 0.5 * (1 - light)) * k * 1.4;
      softStroke(lg, sym.shape, cx, cy, scale, lw * 2.4, `rgba(255,226,180,${Math.min(1, a * 0.55)})`, box * 0.11);
      softStroke(lg, sym.shape, cx, cy, scale, lw, `rgba(255,244,225,${Math.min(1, a)})`, box * 0.03);
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

  function done() {
    shots++;
    // Leave an innocent tab behind once the performer leaves the page.
    if (IOS) setTimeout(() => location.replace(CLEAN_URL), 400);
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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && shots > 0) {
      setTimeout(() => location.replace(CLEAN_URL), 300);
    }
    if (document.visibilityState === "visible") keepAwake();
  });

  // ---------- go ----------
  keepAwake();
  detectDevice();
  startCamera(); // ask for the camera now, so it's ready by the time a symbol is picked
  const preset = params.get("s");
  if (SHAPES.includes(preset)) choose(preset);
})();
