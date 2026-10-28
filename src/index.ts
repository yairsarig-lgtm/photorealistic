import { DurableObject } from "cloudflare:workers";

export interface Env {
  ASSETS: Fetcher;
  RELAY: DurableObjectNamespace<Relay>;
}

// Performer codes: 6–16 letters/digits.
const CODE_RE = /^[A-Za-z0-9]{6,16}$/;

// Photos are held in memory only, and only while no receiver is connected.
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const PAGE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "camera=(self), fullscreen=(self)",
};

async function servePage(env: Env, request: Request, file: string): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(file, request.url)));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // /ws/<code>            receiver WebSocket
    // /api/photo/<code>     spectator uploads the photo (POST, JPEG body)
    // /api/event/<code>     spectator sends a small event (POST, JSON body)
    if (parts[0] === "ws" || parts[0] === "api") {
      const code = parts[0] === "ws" ? parts[1] : parts[2];
      if (!code || !CODE_RE.test(code)) return new Response("Bad code", { status: 400 });
      const stub = env.RELAY.get(env.RELAY.idFromName(code.toUpperCase()));
      return stub.fetch(request);
    }

    if (parts.length === 2 && parts[0] === "s" && CODE_RE.test(parts[1])) {
      return servePage(env, request, "/spectator.html");
    }
    if (parts.length === 2 && parts[0] === "r" && CODE_RE.test(parts[1])) {
      return servePage(env, request, "/receiver.html");
    }
    if (parts.length === 0) {
      return servePage(env, request, "/index.html");
    }

    // Static files (js, css, vendor). Block direct access to the html templates.
    if (url.pathname.endsWith(".html")) return new Response("Not found", { status: 404 });
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return new Response("Not found", { status: 404 });
    return res;
  },
} satisfies ExportedHandler<Env>;

/**
 * One Relay per performer code. Receivers (the performer's phone) hold a
 * WebSocket open; the spectator page POSTs the photo, which is forwarded
 * straight to every connected receiver. Nothing is ever written to storage.
 */
export class Relay extends DurableObject<Env> {
  private receivers = new Set<WebSocket>();
  private pending: { data: ArrayBuffer; at: number } | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptReceiver();
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/photo/")) {
      const len = Number(request.headers.get("Content-Length") || 0);
      if (len > MAX_PHOTO_BYTES) return json({ ok: false, error: "too_large" }, 413);
      const data = await request.arrayBuffer();
      if (data.byteLength === 0 || data.byteLength > MAX_PHOTO_BYTES) {
        return json({ ok: false, error: "bad_size" }, 400);
      }
      const delivered = this.broadcast(data);
      if (delivered === 0) {
        this.pending = { data, at: Date.now() };
        await this.ctx.storage.setAlarm(Date.now() + PENDING_TTL_MS);
      } else {
        this.pending = null;
      }
      return json({ ok: true, delivered, held: delivered === 0 });
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/event/")) {
      let event: unknown = null;
      try {
        event = await request.json();
      } catch {
        return json({ ok: false, error: "bad_json" }, 400);
      }
      const type = (event as { type?: unknown })?.type;
      if (typeof type !== "string" || type.length > 32) return json({ ok: false }, 400);
      this.broadcast(JSON.stringify({ type: "event", event: type }));
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    if (this.pending && Date.now() - this.pending.at >= PENDING_TTL_MS - 1000) {
      this.pending = null;
    }
  }

  private acceptReceiver(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.receivers.add(server);

    server.addEventListener("message", (e) => {
      if (e.data === "ping") {
        try { server.send("pong"); } catch { /* closed */ }
      }
    });
    const drop = () => this.receivers.delete(server);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    server.send(JSON.stringify({ type: "hello" }));

    // Deliver a photo that arrived while no receiver was connected.
    if (this.pending) {
      if (Date.now() - this.pending.at < PENDING_TTL_MS) {
        try {
          server.send(this.pending.data);
          this.pending = null;
        } catch { /* keep it for the next receiver */ }
      } else {
        this.pending = null;
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(msg: ArrayBuffer | string): number {
    let n = 0;
    for (const ws of this.receivers) {
      try {
        ws.send(msg);
        n++;
      } catch {
        this.receivers.delete(ws);
      }
    }
    return n;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
