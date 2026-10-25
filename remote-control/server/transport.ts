// Transport layer for the terminal bridge (ADR-6, stage A3).
//
// The console web app talks to the plugin daemon over a socket transport.
// A2 proved the loopback HTTP server; A3 proves (or rejects) WebSocket in
// the Paseo workspace browser. The winning transport is the only real
// implementation here; the other one stays a documented stub so swapping
// later costs nothing (see __doc.md § Transport for the recorded decision).
//
// Frame contract (§5.3):
// - binary WebSocket frames are raw PTY bytes (client → stdin, server →
//   stdout);
// - text frames are JSON control messages, e.g. `{t:"attach"…}`,
//   `{t:"resize"…}`, `{t:"ping"}`. User-typed bytes must never be mistaken
//   for a control frame because the two framings are distinct.
//
// Until a PTY sink exists (stage B3) the bridge runs in echo mode: binary
// frames are returned byte-exact, `ping` is answered with `pong`, and any
// other control frame gets `{t:"error", code:"unsupported-control"}`.
//
// Handshake hardening (ADR-2):
// - upgrade handled only for `GET <path>` with `Upgrade: websocket`;
// - access token (query `?token=` for browsers, `Authorization: Bearer`
//   also accepted) compared timing-safe;
// - `Origin` header required and its host must equal the request's `Host`
//   header — a console page can only bridge to the server it came from.

import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

export type TransportKind = "ws" | "sse-post";

export const DEFAULT_TRANSPORT_PATH = "/term";

const DEFAULT_MAX_PAYLOAD = 1 << 20; // 1 MiB; PTY chunks are small

export interface TransportControlFrame {
  t: string;
  [key: string]: unknown;
}

export interface TransportConnection {
  /** Stable id for logging/tests. */
  readonly id: string;
  /** Remote end this connection arrived on (best effort, may be null). */
  readonly remoteAddress: string | null;
  sendBinary(data: Uint8Array): void;
  sendControl(frame: Record<string, unknown>): void;
  onBinary(listener: (data: Uint8Array) => void): void;
  onControl(listener: (frame: TransportControlFrame) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface TransportBridge {
  readonly kind: TransportKind;
  /** Wire the bridge onto a running HTTP server (upgrade handling). */
  attachHttpServer(server: http.Server): void;
  /** Terminate live connections and stop accepting upgrades. */
  dispose(): void;
  /** Number of currently live client connections. */
  readonly activeConnections: number;
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  const headers =
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(reason)}\r\n`;
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Rejected"}\r\n${headers}\r\n${reason}`,
  );
  socket.destroy();
}

/** Timing-safe token comparison. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function isWebSocketUpgrade(request: http.IncomingMessage): boolean {
  const connection = typeof request.headers.connection === "string"
    ? request.headers.connection.toLowerCase()
    : "";
  const upgrade = typeof request.headers.upgrade === "string"
    ? request.headers.upgrade.toLowerCase()
    : "";
  return connection.split(",").some((part) => part.trim() === "upgrade") && upgrade === "websocket";
}

/**
 * The ADR-2 origin guard: `Origin` is required and its host must equal the
 * request's `Host` header. Missing header (non-browser clients) → false,
 * so a foreign page or tool never gets a bridge.
 */
function originAllowed(originHeader: unknown, hostHeader: unknown): boolean {
  if (typeof originHeader !== "string" || originHeader.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  const host = hostHeader.split(",")[0].trim();
  return host.length > 0 && parsed.host === host;
}

export class WebSocketTransport implements TransportBridge {
  readonly kind = "ws" as const;

  private readonly token: string;
  private readonly path: string;
  private readonly onConnection: (connection: TransportConnection) => void;
  private readonly log: (message: string) => void;
  private wss: WebSocketServer | null = null;
  private attached: http.Server | null = null;
  private upgradeHandler:
    | ((request: http.IncomingMessage, socket: Socket, head: Buffer) => void)
    | null = null;

  constructor(options: {
    token: string;
    path?: string;
    onConnection?: (connection: TransportConnection) => void;
    log?: (message: string) => void;
  }) {
    if (options.token.length === 0) {
      throw new Error("the WebSocket transport requires a non-empty access token");
    }
    this.token = options.token;
    this.path = options.path ?? DEFAULT_TRANSPORT_PATH;
    this.onConnection = options.onConnection ?? echoConnection;
    this.log = options.log ?? (() => {});
  }

  get activeConnections(): number {
    return this.wss?.clients.size ?? 0;
  }

  attachHttpServer(server: http.Server): void {
    if (this.attached !== null) {
      throw new Error("WebSocketTransport is already attached to a server");
    }
    const wss = new WebSocketServer({ noServer: true, maxPayload: DEFAULT_MAX_PAYLOAD });
    const handler = (request: http.IncomingMessage, socket: Socket, head: Buffer): void => {
      const fail = (status: number, reason: string): void => {
        this.log(`[remote-control] ws upgrade rejected (${status}): ${reason}`);
        rejectUpgrade(socket, status, reason);
      };
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        fail(400, "malformed request URL");
        return;
      }
      if (!isWebSocketUpgrade(request)) {
        fail(400, "not a websocket upgrade");
        return;
      }
      if (url.pathname !== this.path) {
        fail(404, `unknown transport path ${url.pathname}`);
        return;
      }
      const provided =
        url.searchParams.get("token") ?? bearerToken(request.headers.authorization);
      if (provided === null || !tokenMatches(this.token, provided)) {
        fail(401, "unauthorized");
        return;
      }
      if (!originAllowed(request.headers.origin, request.headers.host)) {
        fail(403, "bridge origin refused");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const remoteAddress =
          typeof request.socket.remoteAddress === "string" && request.socket.remoteAddress.length > 0
            ? request.socket.remoteAddress
            : null;
        const connection = wrapSocket(ws, remoteAddress);
        this.log(
          `[remote-control] ws session ${connection.id} attached from ${connection.remoteAddress}`,
        );
        this.onConnection(connection);
      });
    };
    server.on("upgrade", handler);
    this.upgradeHandler = handler;
    this.attached = server;
    this.wss = wss;
  }

  dispose(): void {
    const server = this.attached;
    const handler = this.upgradeHandler;
    this.attached = null;
    this.upgradeHandler = null;
    if (server && handler) server.off("upgrade", handler);
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    for (const client of wss.clients) client.terminate();
    wss.close();
  }
}

function toBytes(chunk: unknown): Uint8Array {
  if (Array.isArray(chunk)) {
    return Buffer.concat(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return new Uint8Array(chunk);
  }
  throw new TypeError(`unsupported ws message payload: ${typeof chunk}`);
}

function wrapSocket(ws: WebSocket, remoteAddress: string | null): TransportConnection {
  const id = crypto.randomUUID();
  let open = true;
  const binaryListeners: Array<(data: Uint8Array) => void> = [];
  const controlListeners: Array<(frame: TransportControlFrame) => void> = [];
  const closeListeners: Array<() => void> = [];

  ws.on("message", (chunk, isBinary) => {
    if (!open) return;
    let data: Uint8Array;
    try {
      data = toBytes(chunk);
    } catch {
      return;
    }
    if (isBinary) {
      for (const listener of binaryListeners) listener(data);
      return;
    }
    const text = Buffer.from(data).toString("utf8");
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      // Transport-level diagnostics go straight back to the peer; they are
      // not control frames and must not reach the connection sink.
      ws.send(JSON.stringify({ t: "error", code: "bad-json" }));
      return;
    }
    if (!frame || typeof frame !== "object" || typeof (frame as { t?: unknown }).t !== "string") {
      ws.send(JSON.stringify({ t: "error", code: "bad-frame" }));
      return;
    }
    for (const listener of controlListeners) listener(frame as TransportControlFrame);
  });

  ws.on("close", () => {
    open = false;
    for (const listener of closeListeners) listener();
  });

  return {
    id,
    remoteAddress,
    sendBinary(data) {
      if (!open) return;
      ws.send(Buffer.from(data));
    },
    sendControl(frame) {
      if (!open) return;
      ws.send(JSON.stringify(frame));
    },
    onBinary(listener) {
      binaryListeners.push(listener);
    },
    onControl(listener) {
      controlListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close() {
      open = false;
      ws.close();
    },
  };
}

/**
 * Default spike sink: full echo of PTY bytes plus a minimal control
 * surface. Replaced by the PTY sink in stage B3.
 */
export function echoConnection(connection: TransportConnection): void {
  connection.onBinary((data) => connection.sendBinary(data));
  connection.onControl((frame) => {
    if (frame.t === "ping") {
      connection.sendControl({ t: "pong" });
      return;
    }
    connection.sendControl({ t: "error", code: "unsupported-control", received: frame.t });
  });
}

/** Stub that documents the fallback transport without implementing it. */
export class SsePostTransport implements TransportBridge {
  readonly kind = "sse-post" as const;

  attachHttpServer(): void {
    // Intentionally inert: SSE+POST is implemented only if the workspace
    // browser ever rejects WS (decision recorded in __doc.md § Transport).
  }

  dispose(): void {}

  get activeConnections(): number {
    return 0;
  }
}

export function createTransport(
  kind: TransportKind,
  options: { token: string },
): TransportBridge {
  if (kind === "ws") return new WebSocketTransport({ token: options.token });
  return new SsePostTransport();
}
