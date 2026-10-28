// Pluck — receiver page (the performer's phone).
// Holds a WebSocket to the relay. Photos arrive as binary JPEG and are
// decoded ahead of time, so the reveal is instant when the screen is touched.
(() => {
  "use strict";

  const code = (location.pathname.split("/")[2] || "").toUpperCase();
  const $ = (id) => document.getElementById(id);
  const setup = $("setup"), stage = $("stage"), photo = $("photo"), dot = $("dot"), corner = $("corner");
  const connEl = $("conn"), photoStateEl = $("photoState");

  $("code").textContent = code || "——";
  $("back").href = "/?code=" + encodeURIComponent(code);

  let ws = null;
  let backoff = 500;
  let pingTimer = null;
  let ready = null;      // { url } decoded and waiting
  let showing = null;    // { url } currently on screen
  let armed = false;
  let wakeLock = null;

  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- connection ----------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(code)}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      backoff = 500;
      setConn(true);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch (_) {} }, 20000);
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        receive(new Blob([e.data], { type: "image/jpeg" }));
        return;
      }
      if (e.data === "pong") return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "event" && msg.event === "vanished") {
          dot.classList.add("gone");
          buzz([30, 70, 30]);
        }
      } catch (_) {}
    };
    ws.onclose = () => {
      setConn(false);
      clearInterval(pingTimer);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function setConn(ok) {
    connEl.textContent = ok ? "Connected" : "Connecting…";
    connEl.className = "pill" + (ok ? " ok" : " dim");
  }

  function setPhotoState() {
    if (ready) {
      photoStateEl.textContent = "Photo ready";
      photoStateEl.className = "pill ok";
    } else {
      photoStateEl.textContent = "No photo yet";
      photoStateEl.className = "pill dim";
    }
    dot.classList.toggle("ready", !!ready && !showing);
    if (!ready) dot.classList.remove("gone");
  }

  // ---------- receiving ----------
  async function receive(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch (_) {}
    if (ready) URL.revokeObjectURL(ready.url);
    ready = { url };
    dot.classList.remove("gone");
    setPhotoState();
    buzz(90);
  }

  // ---------- reveal ----------
  const REVEAL_MS = 950;

  function reveal(fx, fy) {
    if (!ready || showing) return;
    showing = ready;
    ready = null;
    photo.src = showing.url;
    setPhotoState();
    dot.classList.remove("ready", "gone");

    const W = innerWidth, H = innerHeight;
    const side = Math.min(W, H);
    const ox = fx - W / 2, oy = fy - H / 2;
    const t0 = performance.now();

    const frame = (now) => {
      const t = Math.min(1, (now - t0) / REVEAL_MS);
      const e = easeOut(t);
      // Starts as a small bright ember at the fingertip, stretches out to fill the screen.
      const s = lerp(0.04, 1, e);
      const q = 1 - easeOut(Math.min(1, t * 1.4)); // circle -> rectangle, a bit faster
      const iy = ((H - side) / 2) * q, ix = ((W - side) / 2) * q;
      photo.style.transform = `translate(${ox * (1 - e)}px, ${oy * (1 - e)}px) scale(${s})`;
      photo.style.clipPath = `inset(${iy}px ${ix}px round ${(side / 2) * q}px)`;
      photo.style.filter = `brightness(${lerp(1.9, 1, e)}) blur(${lerp(3, 0, e)}px)`;
      photo.style.opacity = String(Math.min(1, t * 5));
      if (t < 1) requestAnimationFrame(frame);
      else {
        photo.style.filter = "none";
        photo.style.clipPath = "none";
      }
    };
    requestAnimationFrame(frame);
  }

  function clearShowing() {
    if (showing) URL.revokeObjectURL(showing.url);
    showing = null;
    photo.removeAttribute("src");
    photo.style.opacity = "0";
    photo.style.transform = "";
    setPhotoState();
  }

  // ---------- arming ----------
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (_) {}
  }

  function arm() {
    armed = true;
    setup.hidden = true;
    stage.hidden = false;
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    keepAwake();
    setPhotoState();
  }

  function disarm() {
    armed = false;
    clearShowing();
    stage.hidden = true;
    setup.hidden = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && armed) keepAwake();
  });

  // ---------- touches on the black screen ----------
  stage.addEventListener("pointerdown", (e) => {
    if (e.target === corner) return;
    e.preventDefault();
    reveal(e.clientX, e.clientY);
  });
  ["contextmenu", "selectstart", "dragstart"].forEach((t) =>
    stage.addEventListener(t, (e) => e.preventDefault()));
  document.addEventListener("touchmove", (e) => { if (armed) e.preventDefault(); }, { passive: false });

  // Long-press top-left corner: reset (photo showing) or go back to setup (empty).
  let holdTimer = null;
  corner.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      buzz(25);
      if (showing) clearShowing();
      else disarm();
    }, 1500);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) =>
    corner.addEventListener(t, () => clearTimeout(holdTimer)));

  // ---------- buttons ----------
  $("arm").addEventListener("click", arm);
  $("test").addEventListener("click", () => {
    const c = document.createElement("canvas");
    c.width = 1080; c.height = 1920;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 1080, 1920);
    grad.addColorStop(0, "#2b5876");
    grad.addColorStop(1, "#c9a26b");
    g.fillStyle = grad;
    g.fillRect(0, 0, 1080, 1920);
    g.fillStyle = "rgba(255,255,255,.9)";
    g.font = "bold 160px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("TEST", 540, 920);
    g.font = "60px system-ui, sans-serif";
    g.fillText(new Date().toLocaleTimeString(), 540, 1040);
    c.toBlob((b) => b && receive(b), "image/jpeg", 0.85);
  });

  if (!/^[A-Z0-9]{6,16}$/.test(code)) {
    connEl.textContent = "Bad code in the link";
  } else {
    connect();
  }
  setPhotoState();
})();
