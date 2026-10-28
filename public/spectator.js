// Pluck — spectator page.
// The spectator's phone runs this after the performer taps the QR link chip
// in the native camera. Flow:
//   camera  -> shutter -> photo is uploaded to the performer instantly
//   shown   -> tap      -> "isolate": viewer chrome slides away, photo fills the screen
//   isolated-> touch+lift -> "pluck": photo condenses into the fingertip and vanishes
//   gone    -> exit (back to the camera app / Google / black)
(() => {
  "use strict";

  const code = location.pathname.split("/")[2] || "";
  const params = new URLSearchParams(location.search);
  const EXIT = ["camera", "google", "black"].includes(params.get("exit")) ? params.get("exit") : "camera";
  const DEBUG = params.get("debug") === "1";
  const MAX_EDGE = 1920;
  const CLEAN_URL = "https://www.google.com/";

  const $ = (id) => document.getElementById(id);
  const cam = $("cam"), controls = $("controls"), shutter = $("shutter"), flip = $("flip");
  const stage = $("stage"), photo = $("photo"), barTop = $("barTop"), barBottom = $("barBottom");
  const flash = $("flash"), debugEl = $("debug");

  let state = "camera";
  let stream = null;
  let facing = "environment";
  let photoUrl = null;
  let natural = { w: 1, h: 1 };
  let coverK = 1; // scale from "contain" to "cover"
  let wakeLock = null;
  let exited = false;

  // ---------- helpers ----------
  function log(...a) {
    if (!DEBUG) return;
    debugEl.hidden = false;
    debugEl.textContent = (a.join(" ") + "\n" + debugEl.textContent).slice(0, 600);
  }

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeIn = (t) => t * t * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;

  function goFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }
    try { screen.orientation && screen.orientation.lock && screen.orientation.lock("portrait").catch(() => {}); } catch (_) {}
  }

  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (_) {}
  }

  // No browser gestures, menus or selection anywhere on the page.
  ["contextmenu", "selectstart", "dragstart", "gesturestart"].forEach((t) =>
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  // First touch anywhere: fullscreen + keep the screen awake.
  document.addEventListener("pointerdown", () => { goFullscreen(); keepAwake(); }, { capture: true });

  // ---------- camera ----------
  async function startCamera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      cam.srcObject = stream;
      cam.classList.toggle("mirror", facing === "user");
      await cam.play().catch(() => {});
      log("camera", cam.videoWidth + "x" + cam.videoHeight);
    } catch (err) {
      log("camera error:", err && err.name);
    }
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  flip.addEventListener("click", () => {
    facing = facing === "environment" ? "user" : "environment";
    startCamera();
  });

  // ---------- capture + upload ----------
  shutter.addEventListener("click", async () => {
    if (state !== "camera" || !cam.videoWidth) return;
    state = "capturing";

    flash.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 260, easing: "ease-out" });
    if (navigator.vibrate) navigator.vibrate(15);

    const vw = cam.videoWidth, vh = cam.videoHeight;
    const s = Math.min(1, MAX_EDGE / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * s);
    canvas.height = Math.round(vh * s);
    const ctx = canvas.getContext("2d");
    if (facing === "user") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(cam, 0, 0, canvas.width, canvas.height);

    stopCamera(); // camera light off as soon as we have the frame

    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) { log("encode failed"); return; }

    upload(blob); // fire and forget; the theater continues regardless
    showPhoto(blob);
  });

  async function upload(blob, attempt = 1) {
    try {
      const r = await fetch("/api/photo/" + encodeURIComponent(code), {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      const j = await r.json().catch(() => ({}));
      log("upload", r.status, "delivered:", j.delivered, j.held ? "(held)" : "");
      if (!r.ok) throw new Error("status " + r.status);
    } catch (err) {
      log("upload failed", attempt, err && err.message);
      if (attempt < 4) setTimeout(() => upload(blob, attempt + 1), 600 * attempt);
    }
  }

  function sendEvent(type) {
    try {
      fetch("/api/event/" + encodeURIComponent(code), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  // ---------- state 1: photo shown ----------
  async function showPhoto(blob) {
    photoUrl = URL.createObjectURL(blob);
    photo.src = photoUrl;
    try { await photo.decode(); } catch (_) {}
    natural = { w: photo.naturalWidth || 1, h: photo.naturalHeight || 1 };
    computeCover();

    cam.hidden = true;
    controls.hidden = true;
    stage.hidden = false;
    state = "shown";
  }

  function computeCover() {
    const W = innerWidth, H = innerHeight;
    const contain = Math.min(W / natural.w, H / natural.h);
    const cover = Math.max(W / natural.w, H / natural.h);
    coverK = cover / contain;
  }
  addEventListener("resize", () => {
    if (state === "camera" || state === "gone") return;
    computeCover();
  });

  // ---------- state 2: isolate (one tap) ----------
  function isolate() {
    state = "isolating";
    const dur = 700;
    const opts = { duration: dur, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" };
    barTop.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], opts);
    barBottom.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(100%)", opacity: 0 }], opts);
    const a = photo.animate([{ transform: "scale(1)" }, { transform: `scale(${coverK})` }], opts);
    a.onfinish = () => {
      // Same picture on screen, but now the element itself is the visible
      // image, so the pluck can shape and shrink it directly.
      photo.style.objectFit = "cover";
      photo.style.transform = "none";
      a.cancel();
      state = "isolated";
    };
  }

  // ---------- state 3: pluck (touch, hold, lift) ----------
  const GATHER_MS = 650;  // photo condenses toward the fingertip while held
  const FINISH_MS = 260;  // if lifted early, finish condensing this fast
  const VANISH_MS = 220;  // final collapse to a point

  let pluck = null; // { fx, fy, t0, p, lifted, raf }

  function startPluck(e) {
    state = "plucking";
    pluck = { fx: e.clientX, fy: e.clientY, t0: performance.now(), p: 0, lifted: false, liftAt: 0, pAtLift: 0 };
    pluck.raf = requestAnimationFrame(tickPluck);
  }

  function renderPluck(p, extraScale = 1, opacity = 1) {
    const W = innerWidth, H = innerHeight;
    const e = easeInOut(p);
    const dx = (pluck.fx - W / 2) * e;
    const dy = (pluck.fy - H / 2) * e;
    // From full screen down to a small glowing ember (~6% of the screen).
    const s = lerp(1, 0.06, e) * extraScale;
    photo.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    // The rectangle rounds into a circle as it condenses.
    const q = easeIn(p);
    const side = Math.min(W, H);
    const iy = ((H - side) / 2) * q, ix = ((W - side) / 2) * q;
    photo.style.clipPath = `inset(${iy}px ${ix}px round ${(side / 2) * q}px)`;
    photo.style.filter = `brightness(${lerp(1, 1.9, e)}) saturate(${lerp(1, 1.3, e)}) blur(${lerp(0, 2.5, q)}px)`;
    photo.style.opacity = String(opacity);
  }

  function tickPluck(now) {
    if (!pluck) return;
    if (!pluck.lifted) {
      pluck.p = Math.min(1, (now - pluck.t0) / GATHER_MS);
      renderPluck(pluck.p);
      pluck.raf = requestAnimationFrame(tickPluck);
      return;
    }
    // Lifted: finish gathering (if needed), then collapse to nothing.
    const since = now - pluck.liftAt;
    const finishDur = (1 - pluck.pAtLift) * FINISH_MS;
    if (since < finishDur) {
      const p = lerp(pluck.pAtLift, 1, easeOut(since / finishDur));
      renderPluck(p);
      pluck.raf = requestAnimationFrame(tickPluck);
      return;
    }
    const v = Math.min(1, (since - finishDur) / VANISH_MS);
    renderPluck(1, lerp(1, 0, easeIn(v)), lerp(1, 0, easeIn(v)));
    if (v < 1) {
      pluck.raf = requestAnimationFrame(tickPluck);
    } else {
      vanished();
    }
  }

  // The photo has been plucked: wipe it and leave.
  function vanished() {
    state = "gone";
    pluck = null;
    photo.removeAttribute("src");
    photo.style.opacity = "0";
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    sendEvent("vanished");
    setTimeout(exit, 250);
  }

  const CAMERA_INTENTS = [
    // Default camera app, still-photo mode.
    "intent:#Intent;action=android.media.action.STILL_IMAGE_CAMERA;end",
    // Some phones only answer the generic "take a picture" action.
    "intent:#Intent;action=android.media.action.IMAGE_CAPTURE;end",
  ];

  function exit() {
    if (exited) return;
    exited = true;
    log("exit:", EXIT);
    if (EXIT === "google") {
      location.replace(CLEAN_URL);
      return;
    }
    if (EXIT === "black") {
      reportExit("black");
      return; // the performer swipes back/home
    }

    // "camera": try, in order, each way of leaving on our own.
    // 1) Close the tab. Chrome allows this when the tab was opened by another
    //    app (like the camera), in which case Android returns to that app.
    try { window.close(); } catch (_) {}

    // 2) Still here? Ask Android to open the camera app.
    let i = 0;
    const tryNext = () => {
      if (document.visibilityState !== "visible") return; // we left
      if (i >= CAMERA_INTENTS.length) return;
      log("intent", i);
      location.href = CAMERA_INTENTS[i++];
      setTimeout(tryNext, 400);
    };
    setTimeout(tryNext, 80);
    reportExit("camera");
  }

  // Tell the performer's receiver whether the page managed to leave,
  // so exits can be tested without watching the spectator's phone.
  let exitReported = false;
  function reportExit(mode) {
    setTimeout(() => {
      if (exitReported) return;
      exitReported = true;
      const left = document.visibilityState !== "visible";
      log("exit result:", left ? "left" : "stuck");
      sendEvent(left ? "exit-left" : "exit-stuck-" + mode);
    }, 1600);
  }

  // Whenever we leave after the trick, leave an innocent tab behind.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state === "gone") {
      if (!exitReported) { exitReported = true; sendEvent("exit-left"); }
      // Let the report go out, then leave an innocent tab behind.
      setTimeout(() => location.replace(CLEAN_URL), 300);
    }
    if (document.visibilityState === "visible" && state !== "gone") keepAwake();
  });

  // ---------- pointer routing ----------
  let downAt = null;
  stage.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (state === "shown") {
      downAt = { x: e.clientX, y: e.clientY };
    } else if (state === "isolated") {
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      startPluck(e);
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (state === "plucking" && pluck && !pluck.lifted) {
      pluck.fx = e.clientX;
      pluck.fy = e.clientY;
    }
  });
  const onUp = () => {
    if (state === "shown" && downAt) {
      downAt = null;
      isolate();
    } else if (state === "plucking" && pluck && !pluck.lifted) {
      pluck.lifted = true;
      pluck.liftAt = performance.now();
      pluck.pAtLift = pluck.p;
    }
  };
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);

  // ---------- go ----------
  if (!/^[A-Za-z0-9]{6,16}$/.test(code)) log("bad code");
  keepAwake();
  startCamera();
})();
