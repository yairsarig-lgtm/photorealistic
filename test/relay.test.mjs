// End-to-end check of the relay against a running worker.
// Usage: npx wrangler dev   (in one terminal)
//        BASE=http://localhost:8787 npm test
import WebSocket from "ws";
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:8787";
const WS_BASE = BASE.replace(/^http/, "ws");
const rand = () => "T" + Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, "X");
const fakeJpeg = (n) => {
  const b = Buffer.alloc(n, 7);
  b[0] = 0xff; b[1] = 0xd8; b[n - 2] = 0xff; b[n - 1] = 0xd9;
  return b;
};

function openReceiver(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/${code}`);
    const inbox = [];
    const waiters = [];
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? { binary: Buffer.from(data) } : { text: data.toString() };
      const w = waiters.shift();
      if (w) w(msg); else inbox.push(msg);
    });
    ws.next = (ms = 3000) => new Promise((res, rej) => {
      if (inbox.length) return res(inbox.shift());
      const t = setTimeout(() => rej(new Error("timeout waiting for message")), ms);
      waiters.push((m) => { clearTimeout(t); res(m); });
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function post(path, body, type) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": type }, body });
  return { status: r.status, json: await r.json().catch(() => null) };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("✓", name);
}

await test("pages are served", async () => {
  for (const p of ["/", "/s/ABCDEFGH", "/r/ABCDEFGH", "/spectator.js", "/receiver.js", "/vendor/qrcode.js"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
  }
  const s = await fetch(BASE + "/s/ABCDEFGH");
  assert.match(await s.text(), /<title>Camera<\/title>/);
  assert.equal(s.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(BASE + "/spectator.html")).status, 404);
  assert.equal((await fetch(BASE + "/s/bad")).status, 404);
});

await test("photo goes straight to a connected receiver", async () => {
  const code = rand();
  const ws = await openReceiver(code);
  assert.match((await ws.next()).text, /hello/);
  const img = fakeJpeg(300_000);
  const r = await post(`/api/photo/${code}`, img, "image/jpeg");
  assert.equal(r.status, 200);
  assert.equal(r.json.delivered, 1);
  const m = await ws.next();
  assert.ok(m.binary && m.binary.equals(img), "same bytes arrive");
  ws.close();
});

await test("codes are case-insensitive", async () => {
  const code = rand();
  const ws = await openReceiver(code);
  await ws.next();
  const r = await post(`/api/photo/${code.toLowerCase()}`, fakeJpeg(1000), "image/jpeg");
  assert.equal(r.json.delivered, 1);
  assert.ok((await ws.next()).binary);
  ws.close();
});

await test("photo is held in memory until a receiver connects, then dropped", async () => {
  const code = rand();
  const img = fakeJpeg(5000);
  const r = await post(`/api/photo/${code}`, img, "image/jpeg");
  assert.equal(r.json.delivered, 0);
  assert.equal(r.json.held, true);
  const ws = await openReceiver(code);
  await ws.next(); // hello
  const m = await ws.next();
  assert.ok(m.binary && m.binary.equals(img));
  ws.close();
  // A second receiver gets nothing: it was delivered and dropped.
  const ws2 = await openReceiver(code);
  await ws2.next(); // hello
  await assert.rejects(ws2.next(800));
  ws2.close();
});

await test("vanished event reaches the receiver", async () => {
  const code = rand();
  const ws = await openReceiver(code);
  await ws.next();
  const r = await post(`/api/event/${code}`, JSON.stringify({ type: "vanished" }), "application/json");
  assert.equal(r.status, 200);
  const m = JSON.parse((await ws.next()).text);
  assert.deepEqual(m, { type: "event", event: "vanished" });
  ws.close();
});

await test("ping/pong keepalive", async () => {
  const code = rand();
  const ws = await openReceiver(code);
  await ws.next();
  ws.send("ping");
  assert.equal((await ws.next()).text, "pong");
  ws.close();
});

await test("rejects bad input", async () => {
  assert.equal((await post(`/api/photo/x`, fakeJpeg(10), "image/jpeg")).status, 400);
  assert.equal((await post(`/api/photo/${rand()}`, Buffer.alloc(0), "image/jpeg")).status, 400);
  assert.equal((await post(`/api/event/${rand()}`, "nope", "application/json")).status, 400);
});

console.log(`\n${passed} passed`);
process.exit(0);
