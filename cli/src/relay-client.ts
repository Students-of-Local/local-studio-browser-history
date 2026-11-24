// Vendored, unchanged below this header, from baney75/local-studio-tunnels relay/client/relay-client.ts
// at commit 342b763ca0c6f89ce0eb784c6227044a03c8304a (2026-11-24). Change it upstream and copy it again;
// cli/test/relay-vendor.test.mjs fails when the body below stops matching that copy's SHA-256.
// License: the upstream file has no license header and its repository no license file. Both repositories are
// baney75's, and this copy is distributed under Tychicus's license (AGPL-3.0, LICENSE).
// ---- upstream file starts here ----
// Reference connector for the Local Studio relay (docs/INTERFACE.md, Relay).
// Node 22 or later, no dependencies: one file to vendor, checked with tsc.
//
// It dials the relay with the built-in WebSocket (which sends the Authorization
// header), reconnects with backoff, and forwards each request to a loopback
// origin by path. The origin leg uses node:http, so the public Host reaches the
// origin unchanged; the built-in WebSocket would replace it with the loopback
// address, so /v1/ws to the origin speaks RFC 6455 over an http upgrade here.
//
//   const relay = new RelayClient({ url: "https://name.sub.workers.dev", key });
//   relay.start();

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** Public path to loopback origin, as in docs/INTERFACE.md. */
export const DEFAULT_ROUTES: Readonly<Record<string, string>> = {
  "/v1/health": "http://127.0.0.1:18094",
  "/v1/ws": "http://127.0.0.1:18094",
  "/mcp": "http://127.0.0.1:8787",
  "/.well-known/oauth-protected-resource": "http://127.0.0.1:8787",
  "/.well-known/oauth-protected-resource/mcp": "http://127.0.0.1:8787",
  "/.well-known/oauth-authorization-server": "http://127.0.0.1:8787",
  "/.well-known/oauth-authorization-server/mcp": "http://127.0.0.1:8787",
  "/authorize": "http://127.0.0.1:8787",
  "/token": "http://127.0.0.1:8787",
  "/register": "http://127.0.0.1:8787",
  "/revoke": "http://127.0.0.1:8787",
};

export type RelayState =
  | "connecting"
  | "connected"
  | "disconnected" // retrying with backoff
  | "replaced" // another connector took over; not retrying
  | "unauthorized" // wrong key; not retrying
  | "outdated" // the relay speaks another protocol version; not retrying
  | "stopped";

export interface RelayClientOptions {
  /** The relay's address, for example https://name.sub.workers.dev. */
  url: string;
  /** RELAY_KEY. Never logged. */
  key: string;
  routes?: Readonly<Record<string, string>>;
  onState?: (state: RelayState) => void;
  /** Keepalive period; the protocol says 30 seconds. */
  pingMs?: number;
}

const PING = '{"v":1,"t":"ping"}';
const PONG = '{"v":1,"t":"pong"}';
const DATA = 1;
const WS_TEXT = 2;
const WS_BINARY = 3;
const CHUNK = 64 * 1024;
/** Pause an origin response while this much is queued on the relay socket. */
const HIGH_WATER = 1024 * 1024;
/** Largest message accepted from an origin WebSocket. */
const MAX_MESSAGE = 16 * 1024 * 1024;
const USER_AGENT = "local-studio-relay-client/1";

type Pairs = [string, string][];

interface Req {
  t: "req";
  id: number;
  method: string;
  path: string;
  headers: Pairs;
  body: boolean;
  ws: boolean;
}

interface Stream {
  req?: ClientRequest;
  res?: IncomingMessage;
  origin?: OriginSocket;
}

export class RelayClient {
  private readonly routes: Readonly<Record<string, string>>;
  private readonly pingMs: number;
  private ws: WebSocket | null = null;
  private streams = new Map<number, Stream>();
  private current: RelayState = "stopped";
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private lastPong = 0;
  private upSince = 0;

  private readonly opts: RelayClientOptions;

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
    this.routes = opts.routes ?? DEFAULT_ROUTES;
    this.pingMs = opts.pingMs ?? 30_000;
  }

  get state(): RelayState {
    return this.current;
  }

  /** Starts, or starts again after replaced, unauthorized, outdated or stopped. */
  start(): void {
    if (this.ws || this.timer) return;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.halt("stopped");
  }

  private set(state: RelayState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onState?.(state);
  }

  private connectUrl(): string {
    const u = new URL("/_relay/connect", this.opts.url);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    return u.href;
  }

  private connect(): void {
    this.set("connecting");
    const ws = new WebSocket(this.connectUrl(), {
      headers: { authorization: `Bearer ${this.opts.key}`, "user-agent": USER_AGENT },
    });
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.upSince = Date.now();
      this.lastPong = Date.now();
      this.pinger = setInterval(() => this.keepalive(ws), this.pingMs);
    });
    ws.addEventListener("message", (e) => {
      if (this.ws !== ws) return;
      // A throw here would reach the host app as an uncaught exception; one bad frame must not stop it.
      try {
        if (typeof e.data === "string") this.control(ws, e.data);
        else this.data(new Uint8Array(e.data as ArrayBuffer));
      } catch {
        // Dropped; a request that threw was already answered in open().
      }
    });
    const lost = (code: number): void => {
      if (this.ws !== ws) return;
      this.down();
      if (code === 4000) return this.halt("replaced");
      if (!opened) void this.probe();
      else this.retry();
    };
    ws.addEventListener("close", (e) => lost(e.code));
    // Node's WebSocket fires only error, never close, when the handshake is refused.
    ws.addEventListener("error", () => {
      if (!opened) lost(1006);
    });
  }

  private keepalive(ws: WebSocket): void {
    if (Date.now() - this.lastPong > 2 * this.pingMs) {
      // Dead without a close: drop it now rather than wait for TCP.
      this.down();
      try {
        ws.close();
      } catch {
        // Already closing.
      }
      return this.retry();
    }
    ws.send(PING);
  }

  /** A browser-style WebSocket can't read a refused handshake's status; ask once over plain HTTP. */
  private async probe(): Promise<void> {
    try {
      const res = await fetch(new URL("/_relay/connect", this.opts.url), {
        headers: { authorization: `Bearer ${this.opts.key}`, "user-agent": USER_AGENT },
      });
      await res.body?.cancel();
      if (res.status === 401) return this.halt("unauthorized");
    } catch {
      // Offline or the relay is down; retry below.
    }
    if (this.current !== "stopped") this.retry();
  }

  private retry(): void {
    if (this.current === "stopped" || this.timer) return;
    // Start over only when the socket that just dropped had been up a minute; a
    // relay that is down, or one that keeps dropping, backs off to 30 s.
    if (this.upSince && Date.now() - this.upSince > 60_000) this.attempt = 0;
    this.upSince = 0;
    const base = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.set("disconnected");
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.connect();
      },
      base / 2 + Math.random() * (base / 2),
    );
  }

  /** The relay socket is gone: stop its timers and every stream on it. */
  private down(): void {
    clearInterval(this.pinger);
    this.pinger = undefined;
    this.ws = null;
    for (const id of [...this.streams.keys()]) this.abort(id);
  }

  private halt(state: RelayState): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const ws = this.ws;
    this.down();
    try {
      ws?.close(1000, "stopped");
    } catch {
      // Already closed.
    }
    this.set(state);
  }

  private send(m: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ v: 1, ...m }));
  }

  /** Body bytes go in slices of at most 64 KiB; a WebSocket message is always one frame. */
  private sendFrame(kind: number, id: number, payload: Uint8Array): void {
    const step = kind === DATA ? CHUNK : Math.max(payload.byteLength, 1);
    for (let off = 0; off === 0 || off < payload.byteLength; off += step) {
      const part = payload.subarray(off, off + step);
      const f = new Uint8Array(5 + part.byteLength);
      f[0] = kind;
      new DataView(f.buffer).setUint32(1, id);
      f.set(part, 5);
      this.ws?.send(f);
    }
  }

  private control(ws: WebSocket, raw: string): void {
    if (raw === PONG) {
      this.lastPong = Date.now();
      return;
    }
    let m: { v?: number; t?: string; id?: number; [k: string]: unknown };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      return;
    }
    if (m.t === "hello") {
      if (m.v !== 1) return this.halt("outdated");
      return this.set("connected");
    }
    // Close code 4000 follows, but Node reports a close only once TCP closes.
    if (m.t === "replaced") return this.halt("replaced");
    if (m.v !== 1 || typeof m.id !== "number") return;
    const s = this.streams.get(m.id);
    switch (m.t) {
      case "req":
        if (this.ws === ws) this.open(m as unknown as Req);
        return;
      case "end":
        s?.req?.end();
        return;
      case "cancel":
        return this.abort(m.id);
      case "ws_close":
        this.streams.delete(m.id);
        s?.origin?.close(Number(m.code), String(m.reason ?? ""));
        return;
    }
  }

  private data(f: Uint8Array): void {
    if (f.byteLength < 5) return;
    const id = new DataView(f.buffer, f.byteOffset).getUint32(1);
    const s = this.streams.get(id);
    const payload = f.subarray(5);
    if (f[0] === DATA) s?.req?.write(payload);
    else if (f[0] === WS_TEXT) s?.origin?.send(1, Buffer.from(payload));
    else if (f[0] === WS_BINARY) s?.origin?.send(2, Buffer.from(payload));
  }

  private abort(id: number): void {
    const s = this.streams.get(id);
    this.streams.delete(id);
    s?.req?.destroy();
    s?.res?.destroy();
    s?.origin?.destroy();
  }

  private fail(id: number, message: string): void {
    if (!this.streams.has(id)) return;
    this.send({ t: "error", id, message });
    this.abort(id);
  }

  private open(m: Req): void {
    try {
      this.forward(m);
    } catch {
      // node:http refuses some values a public client can send (a header above U+00FF, an odd method).
      this.streams.get(m.id)?.req?.destroy();
      this.streams.delete(m.id);
      this.send({ t: "res", id: m.id, status: 400, headers: [["content-type", "text/plain; charset=utf-8"]] });
      this.sendFrame(DATA, m.id, new TextEncoder().encode("Bad request.\n"));
      this.send({ t: "end", id: m.id });
    }
  }

  private forward(m: Req): void {
    const pathname = new URL(m.path, "http://relay").pathname;
    const origin = this.routes[pathname];
    if (!origin) {
      this.send({ t: "res", id: m.id, status: 404, headers: [["content-type", "text/plain; charset=utf-8"]] });
      this.sendFrame(DATA, m.id, new TextEncoder().encode("No local route for this path.\n"));
      this.send({ t: "end", id: m.id });
      return;
    }
    const target = new URL(origin);
    const flat = m.headers.flat();
    let key = "";
    if (m.ws) {
      key = randomBytes(16).toString("base64");
      flat.push("connection", "Upgrade", "upgrade", "websocket", "sec-websocket-version", "13", "sec-websocket-key", key);
    }
    const req = httpRequest({
      host: target.hostname,
      port: Number(target.port) || 80,
      method: m.method,
      path: m.path,
      headers: flat,
      setHost: false,
    });
    const s: Stream = { req };
    this.streams.set(m.id, s);

    req.on("response", (res) => this.respond(m.id, s, res));
    req.on("upgrade", (res, socket, head) => {
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (!m.ws || res.headers["sec-websocket-accept"] !== accept) {
        socket.destroy();
        return this.fail(m.id, "bad upgrade");
      }
      s.req = undefined;
      s.origin = new OriginSocket(socket, head, {
        message: (op, payload) => this.sendFrame(op === 1 ? WS_TEXT : WS_BINARY, m.id, payload),
        close: (code, reason) => {
          if (this.streams.delete(m.id)) this.send({ t: "ws_close", id: m.id, code: sendableCode(code), reason });
        },
      });
      const protocol = res.headers["sec-websocket-protocol"];
      this.send({ t: "res", id: m.id, status: 101, headers: protocol ? [["sec-websocket-protocol", String(protocol)]] : [] });
    });
    req.on("error", () => this.fail(m.id, "origin unreachable"));
    if (!m.body) req.end();
  }

  private respond(id: number, s: Stream, res: IncomingMessage): void {
    if (!this.streams.has(id)) return void res.destroy();
    s.res = res;
    const headers: Pairs = [];
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i]!.toLowerCase(), res.rawHeaders[i + 1]!]);
    this.send({ t: "res", id, status: res.statusCode ?? 502, headers });
    res.on("data", (chunk: Buffer) => {
      if (!this.streams.has(id)) return void res.destroy();
      this.sendFrame(DATA, id, chunk);
      this.backpressure(res);
    });
    res.on("end", () => {
      if (this.streams.delete(id)) this.send({ t: "end", id });
    });
    res.on("error", () => this.fail(id, "origin response failed"));
  }

  private backpressure(res: IncomingMessage): void {
    const ws = this.ws;
    if (!ws || ws.bufferedAmount < HIGH_WATER || res.isPaused()) return;
    res.pause();
    const check = (): void => {
      if (this.ws !== ws || res.destroyed) return;
      if (ws.bufferedAmount < HIGH_WATER / 2) res.resume();
      else setTimeout(check, 10);
    };
    setTimeout(check, 10);
  }
}

/** A close code a WebSocket endpoint may send: 1000 or 3000 to 4999. */
function sendableCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

/** A close code RFC 6455 lets an endpoint put on the wire. */
function wireCode(code: number): number {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999) ? code : 1000;
}

interface OriginEvents {
  message: (op: number, payload: Buffer) => void;
  close: (code: number, reason: string) => void;
}

/**
 * The client end of an RFC 6455 WebSocket on an upgraded socket: masked frames
 * out, fragments joined, pings answered, close handshake. No extensions.
 */
class OriginSocket {
  private buf: Buffer;
  private parts: Buffer[] = [];
  private size = 0;
  private op = 0;
  private closeSent = false;
  private closed = false;

  private readonly socket: Duplex;
  private readonly on: OriginEvents;

  constructor(socket: Duplex, head: Buffer, on: OriginEvents) {
    this.socket = socket;
    this.on = on;
    this.buf = head;
    socket.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.parse();
    });
    socket.on("close", () => this.gone(1006, ""));
    socket.on("error", () => socket.destroy());
    if (head.length) queueMicrotask(() => this.parse());
  }

  send(op: number, payload: Buffer): void {
    if (this.closeSent || this.closed) return;
    this.write(op, payload);
  }

  close(code: number, reason: string): void {
    if (this.closeSent || this.closed) return;
    const r = Buffer.from(reason).subarray(0, 123);
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(wireCode(code));
    r.copy(body, 2);
    this.write(8, body);
    this.closeSent = true;
    setTimeout(() => this.socket.destroy(), 5000).unref();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private write(op: number, payload: Buffer): void {
    const len = payload.length;
    const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = 0x80 | len;
    else if (len < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = randomBytes(4);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i & 3]!;
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  private parse(): void {
    while (!this.closed && this.buf.length >= 2) {
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.tooBig();
        len = Number(big);
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const at = off + (masked ? 4 : 0);
      if (this.buf.length < at + len) return;
      let payload = this.buf.subarray(at, at + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((x, i) => x ^ mask[i & 3]!));
      }
      this.buf = this.buf.subarray(at + len);
      this.frame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    }
  }

  private frame(fin: boolean, op: number, payload: Buffer): void {
    if (op === 8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.subarray(2).toString("utf8");
      if (!this.closeSent) this.close(code, reason);
      this.socket.end();
      return this.gone(code, reason);
    }
    if (op === 9) return this.send(10, payload);
    if (op === 10) return;
    if (op !== 0) {
      this.op = op;
      this.parts = [];
      this.size = 0;
    }
    this.size += payload.length;
    if (this.size > MAX_MESSAGE) return this.tooBig();
    this.parts.push(Buffer.from(payload));
    if (!fin) return;
    const message = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    if (this.op === 1 || this.op === 2) this.on.message(this.op, message);
  }

  private tooBig(): void {
    this.close(1009, "message too big");
    this.gone(1009, "message too big");
  }

  private gone(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.on.close(code, reason);
  }
}
