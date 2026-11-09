// Aura — the spectator's phone, opened from the performer's QR.
// Looks and behaves like a plain camera: tap to focus, press the shutter,
// flash, the photo flies into the corner thumbnail, the camera stays live.
// What it saves to the phone's gallery is the photo with the performer's
// chosen ESP symbol blended into it, named and dated like a camera photo.
(() => {
  "use strict";

  const code = location.pathname.split("/")[2] || "";
  const params = new URLSearchParams(location.search);
  const DEBUG = params.get("debug") === "1";
  const MAX_EDGE = 2400;
  const CLEAN_URL = "https://www.google.com/";

  const $ = (id) => document.getElementById(id);
  const cam = $("cam"), shutter = $("shutter"), flip = $("flip"), focusEl = $("focus");
  const flash = $("flash"), fly = $("fly"), thumbImg = $("thumbImg");
  const preview = $("preview"), previewImg = $("previewImg"), debugEl = $("debug");

  let stream = null;
  let facing = "environment";
  let config = { shape: "star", style: "aura", strength: 0.5 };
  let anchor = { x: 0.5, y: 0.2 };   // where the symbol goes, as a fraction of the photo
  let device = { make: "", model: "" };
  let shots = 0;
  let busy = false;
  let wakeLock = null;

  // ---------- helpers ----------
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

  // ---------- settings from the performer's phone ----------
  async function loadConfig(timeoutMs = 2500) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch("/api/config/" + encodeURIComponent(code), { cache: "no-store", signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) config = { ...config, ...(await r.json()) };
      log("config", config.shape, config.style, config.strength);
    } catch (_) {
      log("config: using last known");
    }
  }

  // ---------- which phone is this (for camera-like file name and details) ----------
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
    else if (/redmi|poco|^M2\d|^2\d{3}|xiaomi|^22|^23|^24/i.test(model)) make = "Xiaomi";
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

  // ---------- tap to focus = place the symbol ----------
  // Convert a screen point into a position on the captured photo, taking
  // the "cover" crop of the viewfinder into account.
  function screenToPhoto(x, y) {
    const vw = cam.videoWidth || 1, vh = cam.videoHeight || 1;
    const W = innerWidth, H = innerHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    let px = (x - (W - dw) / 2) / dw;
    const py = (y - (H - dh) / 2) / dh;
    if (facing === "user") px = 1 - px;
    return { x: Math.min(0.95, Math.max(0.05, px)), y: Math.min(0.95, Math.max(0.05, py)) };
  }

  cam.addEventListener("pointerdown", (e) => {
    anchor = screenToPhoto(e.clientX, e.clientY);
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
    log("anchor", anchor.x.toFixed(2), anchor.y.toFixed(2));
  });

  // ---------- the ESP symbols ----------
  // Drawn as stroked paths in a unit box centred on 0,0 (size 1).
  function shapePath(ctx, shape) {
    ctx.beginPath();
    switch (shape) {
      case "circle":
        ctx.arc(0, 0, 0.42, 0, Math.PI * 2);
        break;
      case "cross":
        ctx.moveTo(0, -0.45); ctx.lineTo(0, 0.45);
        ctx.moveTo(-0.45, 0); ctx.lineTo(0.45, 0);
        break;
      case "square":
        ctx.rect(-0.38, -0.38, 0.76, 0.76);
        break;
      case "waves":
        for (const yy of [-0.28, 0, 0.28]) {
          for (let i = 0; i <= 48; i++) {
            const t = i / 48;
            const x = -0.45 + t * 0.9;
            const y = yy + Math.sin(t * Math.PI * 4) * 0.07;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
        }
        break;
      case "star":
      default:
        for (let i = 0; i <= 5; i++) {
          const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
          const x = Math.cos(a) * 0.46, y = Math.sin(a) * 0.46 + 0.04;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        break;
    }
  }

  // Draw only the blurred glow of the stroke (the stroke itself is drawn
  // off-canvas; its shadow lands in place). Works on every browser.
  function softStroke(ctx, shape, cx, cy, size, lineW, color, blur) {
    const off = ctx.canvas.width * 3;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = off;
    ctx.translate(cx - off, cy);
    ctx.scale(size, size);
    ctx.lineWidth = lineW / size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#000";
    shapePath(ctx, shape);
    ctx.stroke();
    ctx.restore();
  }

  // Average brightness around the anchor, so the symbol adapts to the scene.
  function localLight(src, cx, cy, r) {
    const s = 24;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, cx - r, cy - r, r * 2, r * 2, 0, 0, s, s);
    const d = g.getImageData(0, 0, s, s).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4) / 255; // 0 dark .. 1 bright
  }

  function addSymbol(canvas) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d");
    const size = Math.min(W, H) * 0.24;
    const cx = anchor.x * W, cy = anchor.y * H;
    const k = Math.max(0.1, Math.min(1, config.strength || 0.5));
    const light = localLight(canvas, cx, cy, size * 0.7);
    const lw = size * 0.075;

    // A separate layer, blended onto the photo as one piece.
    const layer = document.createElement("canvas");
    layer.width = W; layer.height = H;
    const lg = layer.getContext("2d");

    if (config.style === "shadow") {
      // A soft, cool shadow, darker on bright surfaces.
      const a = (0.25 + 0.45 * light) * k;
      softStroke(lg, config.shape, cx, cy, size, lw * 1.6, `rgba(20,18,30,${a * 0.6})`, size * 0.16);
      softStroke(lg, config.shape, cx, cy, size, lw, `rgba(15,12,25,${a})`, size * 0.05);
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    } else {
      // A faint warm light, like an aura: stronger in darker surroundings.
      const a = (0.35 + 0.5 * (1 - light)) * k;
      softStroke(lg, config.shape, cx, cy, size, lw * 2.4, `rgba(255,226,180,${a * 0.55})`, size * 0.22);
      softStroke(lg, config.shape, cx, cy, size, lw, `rgba(255,244,225,${a})`, size * 0.06);
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    }

    // Fine grain over the symbol area so it sits in the photo's noise.
    const r = Math.round(size * 0.8);
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
    const tz = (() => {
      const m = -d.getTimezoneOffset();
      const s = m >= 0 ? "+" : "-";
      const a = Math.abs(m);
      return enc(`${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`);
    })();

    // IFD0: Make, Model (if known), Orientation, DateTime, ExifIFD pointer.
    const ifd0 = [];
    if (device.make) ifd0.push({ tag: 0x010f, type: 2, data: enc(device.make) });
    if (device.model) ifd0.push({ tag: 0x0110, type: 2, data: enc(device.model) });
    ifd0.push({ tag: 0x0112, type: 3, value: 1 });
    ifd0.push({ tag: 0x0132, type: 2, data: dt });
    ifd0.push({ tag: 0x8769, type: 4, value: 0 }); // filled in below
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
    buf.set([0x49, 0x49, 0x2a, 0x00]); // "II*\0" little-endian TIFF
    v.setUint32(4, ifd0Off, true);

    const writeIfd = (list, off, dataOff, next) => {
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
      v.setUint32(p, next, true);
    };
    writeIfd(ifd0, ifd0Off, ifd0DataOff, 0);
    writeIfd(exif, exifOff, exifDataOff, 0);

    // APP1 segment: FFE1, length, "Exif\0\0", TIFF data.
    const seg = new Uint8Array(4 + 6 + total);
    seg[0] = 0xff; seg[1] = 0xe1;
    const len = 2 + 6 + total;
    seg[2] = len >> 8; seg[3] = len & 0xff;
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    seg.set(buf, 10);
    return seg;
  }

  // Replace the browser's JFIF header with camera-style EXIF.
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

  // ---------- saving ----------
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

  // Send the finished photo to the performer's phone too (never stored).
  function sendToPerformer(blob) {
    fetch("/api/photo/" + encodeURIComponent(code), {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    }).catch(() => {});
    fetch("/api/event/" + encodeURIComponent(code), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "aura-saved" }),
      keepalive: true,
    }).catch(() => {});
  }

  // ---------- the shutter ----------
  shutter.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (busy || !cam.videoWidth) return;
    busy = true;
    const when = new Date();

    // Freeze the frame now, before anything else.
    const vw = cam.videoWidth, vh = cam.videoHeight;
    const s = Math.min(1, MAX_EDGE / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * s);
    canvas.height = Math.round(vh * s);
    const ctx = canvas.getContext("2d");
    if (facing === "user") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(cam, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Like a real camera: a blink, then the shot flies into the thumbnail.
    flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 180, easing: "ease-out" });
    if (navigator.vibrate) navigator.vibrate(12);
    const cleanUrl = canvas.toDataURL("image/jpeg", 0.6);
    flyToThumb(cleanUrl);

    // Fresh settings (the performer may have just chosen the shape).
    await loadConfig(1500);
    addSymbol(canvas);

    const raw = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
    if (!raw) { busy = false; return; }
    const blob = await withExif(raw, when);
    const name = fileName(when);
    save(blob, name);
    sendToPerformer(blob);
    shots++;
    log("saved", name, Math.round(blob.size / 1024) + "KB", config.shape, config.style);

    if (DEBUG) {
      previewImg.src = URL.createObjectURL(blob);
      preview.hidden = false;
    }
    busy = false;
  });

  preview.addEventListener("click", () => { preview.hidden = true; });

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
      fly.style.opacity = "0";
      thumbImg.src = src;
      thumbImg.classList.add("on");
    };
  }

  // After the shot, once the performer leaves the page, leave an innocent tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && shots > 0) {
      setTimeout(() => location.replace(CLEAN_URL), 300);
    }
    if (document.visibilityState === "visible") keepAwake();
  });

  // ---------- go ----------
  keepAwake();
  detectDevice();
  loadConfig();
  startCamera();
})();
