// Aura — a stand-alone fake camera, opened from its own QR on the
// spectator's phone. Nothing is needed on the performer's phone.
//
// The performer (holding the phone, screen facing them) picks a symbol from
// the strip under the viewfinder. A live preview of it appears on the
// viewfinder: drag it into place, pinch to resize, double-tap it to switch
// glow/shadow. The shutter flashes and "files" the shot like a real camera,
// and the photo saved to the phone has the symbol blended in, named and
// dated like a camera photo.
(() => {
  "use strict";

  const parts = location.pathname.split("/").filter(Boolean);
  const code = parts[0] === "a" ? parts[1] || "" : parts[1] || "";
  const params = new URLSearchParams(location.search);
  const DEBUG = params.get("debug") === "1";
  const MAX_EDGE = 2400;
  const CLEAN_URL = "https://www.google.com/";
  const STRENGTHS = [0.3, 0.5, 0.7, 0.9];

  const $ = (id) => document.getElementById(id);
  const cam = $("cam"), shutter = $("shutter"), flip = $("flip"), focusEl = $("focus");
  const flash = $("flash"), fly = $("fly"), thumbImg = $("thumbImg");
  const overlay = $("overlay"), overlayPath = $("overlayPath");
  const styleChip = $("styleChip"), strengthChip = $("strengthChip");
  const preview = $("preview"), previewImg = $("previewImg"), debugEl = $("debug");

  let stream = null;
  let facing = "environment";
  // The symbol, in screen terms: centre (px) and size (px of the 100-unit box).
  const sym = {
    shape: "none",
    style: "glow",
    strength: 0.5,
    x: innerWidth / 2,
    y: innerHeight * 0.32,
    size: Math.min(innerWidth, innerHeight) * 0.32,
  };
  let device = { make: "", model: "" };
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let pendingFile = null;
  let shots = 0;
  let busy = false;
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
    else if (/iPhone/.test(navigator.userAgent)) { make = "Apple"; model = "iPhone"; }
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
          const x = -42 + t * 84;
          const y = yy + Math.sin(t * Math.PI * 4) * 6.5;
          d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2);
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

  // ---------- the live overlay ----------
  function renderOverlay() {
    if (sym.shape === "none") { overlay.setAttribute("hidden", ""); return; }
    overlay.removeAttribute("hidden");
    overlayPath.setAttribute("d", PATHS[sym.shape]);
    overlay.classList.toggle("glow", sym.style === "glow");
    overlay.classList.toggle("shadow", sym.style === "shadow");
    overlay.style.width = overlay.style.height = sym.size + "px";
    overlay.style.transform = `translate(${sym.x - sym.size / 2}px, ${sym.y - sym.size / 2}px)`;
    // A thin contrasting outline keeps it visible on bright or dark scenes.
    const edge = sym.style === "glow" ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.6)";
    const glow = sym.style === "glow" ? "rgba(255,220,160,.9)" : "rgba(20,18,30,.7)";
    overlay.style.filter =
      `drop-shadow(0 0 1px ${edge}) drop-shadow(0 0 1px ${edge}) drop-shadow(0 0 ${sym.size * 0.06}px ${glow})`;
    overlay.style.opacity = String(0.5 + 0.5 * sym.strength);
  }

  document.querySelectorAll("#symbols button").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      sym.shape = b.dataset.v;
      document.querySelectorAll("#symbols button").forEach((x) => x.classList.toggle("on", x === b));
      if (navigator.vibrate) navigator.vibrate(8);
      renderOverlay();
    }));

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

  // Drag to move, pinch to resize, double-tap to switch glow/shadow.
  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;

  overlay.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    if (pointers.size === 1 && now - lastTap < 300) setStyle(sym.style === "glow" ? "shadow" : "glow");
    lastTap = now;
    startGesture();
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.values()];
    if (pts.length === 1 && gesture.n === 1) {
      sym.x = gesture.sx + (pts[0].x - gesture.p0.x);
      sym.y = gesture.sy + (pts[0].y - gesture.p0.y);
    } else if (pts.length >= 2 && gesture.n >= 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const minS = Math.min(innerWidth, innerHeight) * 0.1, maxS = Math.min(innerWidth, innerHeight) * 0.95;
      sym.size = Math.max(minS, Math.min(maxS, gesture.size * (d / gesture.d0)));
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      sym.x = gesture.sx + (mx - gesture.m0.x);
      sym.y = gesture.sy + (my - gesture.m0.y);
    }
    renderOverlay();
  });
  const endPointer = (e) => { pointers.delete(e.pointerId); startGesture(); };
  overlay.addEventListener("pointerup", endPointer);
  overlay.addEventListener("pointercancel", endPointer);

  function startGesture() {
    const pts = [...pointers.values()];
    if (!pts.length) { gesture = null; return; }
    gesture = { n: pts.length, sx: sym.x, sy: sym.y, size: sym.size, p0: pts[0] };
    if (pts.length >= 2) {
      gesture.d0 = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      gesture.m0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }
  }

  // Tapping the viewfinder looks like tap-to-focus, and moves the symbol there.
  cam.addEventListener("pointerdown", (e) => {
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

  // ---------- drawing the symbol into the photo ----------
  function shapePath(ctx, shape) {
    ctx.beginPath();
    const p = new Path2D(PATHS[shape]);
    return p;
  }

  // Blurred stroke: drawn off-canvas so only its shadow lands in place.
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
    ctx.stroke(shapePath(ctx, shape));
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

  // Where the overlay sits on the screen -> where it sits in the photo.
  function overlayInPhoto(canvas) {
    const vw = cam.videoWidth || 1, vh = cam.videoHeight || 1;
    const W = innerWidth, H = innerHeight;
    const s = Math.max(W / vw, H / vh);            // video px -> screen px
    const dw = vw * s, dh = vh * s;
    let fx = (sym.x - (W - dw) / 2) / dw;
    const fy = (sym.y - (H - dh) / 2) / dh;
    if (facing === "user") fx = 1 - fx;
    const k = canvas.width / vw;                   // video px -> photo px
    return { cx: fx * canvas.width, cy: fy * canvas.height, box: (sym.size / s) * k };
  }

  function addSymbol(canvas) {
    if (sym.shape === "none") return;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d");
    const { cx, cy, box } = overlayInPhoto(canvas);
    const scale = box / 100;                       // path units -> photo px
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

    // Grain over the symbol area so it sits in the photo's noise.
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

  async function withExif(blob, d) {
    const src = new Uint8Array(await blob.arrayBuffer());
    if (src[0] !== 0xff || src[1] !== 0xd8) return blob;
    let rest = 2;
    if (src[2] === 0xff && src[3] === 0xe0) rest = 4 + ((src[4] << 8) | src[5]);
    const exif = buildExif(d);
    const out = new Uint8Array(2 + exif.length + (src.length - rest));
    out.set([0xff, 0xd8]);
    out.set(exif, 2);
    out.set(src.subarray(rest), 2 + exif.length);
    return new Blob([out], { type: "image/jpeg" });
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Optional: if the page was opened with a performer code, a copy goes to
  // that performer's receiver too (never stored). Not needed for the trick.
  function sendToPerformer(blob) {
    if (!/^[A-Za-z0-9]{6,16}$/.test(code)) return;
    fetch("/api/photo/" + encodeURIComponent(code), {
      method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob,
    }).catch(() => {});
  }

  // ---------- the shutter ----------
  shutter.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (busy || !cam.videoWidth) return;
    busy = true;
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

    flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 180, easing: "ease-out" });
    if (navigator.vibrate) navigator.vibrate(12);
    flyToThumb(canvas.toDataURL("image/jpeg", 0.6));

    addSymbol(canvas);
    const raw = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
    if (!raw) { busy = false; return; }
    const blob = await withExif(raw, when);
    const name = fileName(when);
    if (IOS) {
      // iPhone: Photos only accepts it through the share sheet, which needs
      // its own tap. The photo waits; tapping the thumbnail opens the sheet.
      pendingFile = new File([blob], name, { type: "image/jpeg", lastModified: when.getTime() });
    } else {
      save(blob, name);
    }
    sendToPerformer(blob);
    shots++;
    log("saved", name, Math.round(blob.size / 1024) + "KB", sym.shape, sym.style, sym.strength);

    // Clear the symbol so nothing lingers on screen after the shot.
    sym.shape = "none";
    document.querySelectorAll("#symbols button").forEach((x) => x.classList.toggle("on", x.dataset.v === "none"));
    renderOverlay();

    if (DEBUG) {
      previewImg.src = URL.createObjectURL(blob);
      preview.hidden = false;
    }
    busy = false;
  });

  preview.addEventListener("click", () => { preview.hidden = true; });

  // iPhone: tap the corner thumbnail -> share sheet -> "Save Image" -> Photos.
  document.getElementById("thumb").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!pendingFile) return;
    const file = pendingFile;
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        pendingFile = null;
        log("shared", file.name);
        return;
      }
    } catch (err) {
      log("share:", err && err.name);
      if (err && err.name === "AbortError") return; // sheet closed; tap again
    }
    save(file, file.name); // fallback: goes to Files → Downloads
    pendingFile = null;
  });

  function flyToThumb(src) {
    fly.src = src;
    const t = document.getElementById("thumb").getBoundingClientRect();
    const sx = t.width / innerWidth, sy = t.height / innerHeight;
    fly.animate(
      [
        { opacity: 1, transform: "translate(0,0) scale(1,1)", borderRadius: "0px" },
        { opacity: 1, transform: `translate(${t.left}px, ${t.top}px) scale(${sx}, ${sy})`, borderRadius: "400px" },
      ],
      { duration: 380, easing: "cubic-bezier(.4,0,.2,1)" }
    ).onfinish = () => {
      thumbImg.src = src;
      thumbImg.classList.add("on");
    };
  }

  // After the shot, once the performer leaves the page, leave an innocent tab.
  document.addEventListener("visibilitychange", () => {
    // (Not while the iPhone share sheet is waiting to be used.)
    if (document.visibilityState === "hidden" && shots > 0 && !pendingFile) {
      setTimeout(() => location.replace(CLEAN_URL), 300);
    }
    if (document.visibilityState === "visible") keepAwake();
  });

  // ---------- go ----------
  keepAwake();
  detectDevice();
  renderOverlay();
  startCamera();
})();
