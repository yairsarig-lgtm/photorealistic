// Performer setup: create or reuse a code, show the QR, link to the receiver.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KEY = "pluck.code";
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const CODE_RE = /^[A-Z0-9]{6,16}$/;

  const store = {
    get() { try { return localStorage.getItem(KEY); } catch (_) { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch (_) {} },
    clear() { try { localStorage.removeItem(KEY); } catch (_) {} },
  };

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  }

  const spectatorUrl = (code, q = "") => `${location.origin}/s/${code}${q}`;

  let qr = null;
  let current = null;

  function show(code) {
    current = code;
    store.set(code);
    $("empty").hidden = true;
    $("have").hidden = false;
    $("codeText").textContent = code;

    const url = spectatorUrl(code);
    $("urlText").textContent = url;
    qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    $("qr").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });

    $("openReceiver").href = `/r/${code}`;
    $("exitCamera").href = spectatorUrl(code, "?exit=camera");
    $("exitGoogle").href = spectatorUrl(code, "?exit=google");
    $("exitBlack").href = spectatorUrl(code, "?exit=black");
    $("exitDebug").href = spectatorUrl(code, "?exit=black&debug=1");
  }

  function showEmpty() {
    current = null;
    $("empty").hidden = false;
    $("have").hidden = true;
  }

  $("create").addEventListener("click", () => show(newCode()));

  $("useForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("useInput").value.trim().toUpperCase();
    if (CODE_RE.test(v)) show(v);
    else $("useInput").select();
  });

  $("reset").addEventListener("click", () => { store.clear(); showEmpty(); });

  $("download").addEventListener("click", () => {
    if (!qr || !current) return;
    const n = qr.getModuleCount();
    const cell = 24, margin = 4 * cell;
    const size = n * cell + margin * 2;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, size, size);
    g.fillStyle = "#000";
    for (let r = 0; r < n; r++)
      for (let col = 0; col < n; col++)
        if (qr.isDark(r, col)) g.fillRect(margin + col * cell, margin + r * cell, cell, cell);
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = `pluck-${current}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  const fromQuery = (new URLSearchParams(location.search).get("code") || "").toUpperCase();
  const saved = (store.get() || "").toUpperCase();
  if (CODE_RE.test(fromQuery)) show(fromQuery);
  else if (CODE_RE.test(saved)) show(saved);
  else showEmpty();
})();
