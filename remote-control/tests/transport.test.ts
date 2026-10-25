import * as crypto from "node:crypto";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ConsoleHttpServer } from "../server/http-server";
import {
  DEFAULT_TRANSPORT_PATH,
  SsePostTransport,
  WebSocketTransport,
} from "../server/transport";
import type { TransportConnection, TransportControlFrame } from "../server/transport";

const TOKEN = "test-token";

let transport: WebSocketTransport;
let server: ConsoleHttpServer;
let base: string;

beforeEach(async () => {
  transport = new WebSocketTransport({ token: TOKEN });
  server = new ConsoleHttpServer({ token: TOKEN, port: 0, transport });
  await server.start();
  base = server.origin!;
});

afterEach(async () => {
  await server.stop();
});

/** WebSocket URL for the transport path with the token attached. */
function wsUrl(): string {
  return `${base.replace("http:", "ws:")}${DEFAULT_TRANSPORT_PATH}?token=${TOKEN}`;
}

interface RawHandshake {
  status: number;
}

/**
 * Raw upgrade request so the test observes the exact response status
 * (a WebSocket client hides rejection codes behind `error` events).
 */
function rawHandshake(
  path: string,
  headers: Record<string, string | undefined>,
): Promise<RawHandshake> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    request.on("upgrade", () => resolve({ status: 101 }));
    request.on("error", reject);
    request.end();
  });
}

function openClient(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, { headers });
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function nextMessage(
  client: WebSocket,
): Promise<{ binary: Uint8Array | null; text: string | null }> {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("no message within 5s")), 5000);
    client.once("message", (chunk, isBinary) => {
      clearTimeout(guard);
      if (isBinary) {
        resolve({ binary: chunk as Uint8Array, text: null });
        return;
      }
      resolve({ binary: null, text: String(chunk) });
    });
    client.once("close", () => {
      clearTimeout(guard);
      reject(new Error("connection closed before a message arrived"));
    });
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("condition not met within timeout"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("ws transport security", () => {
  it("rejects an upgrade without a token with 401", async () => {
    const result = await rawHandshake(DEFAULT_TRANSPORT_PATH, { Origin: base });
    expect(result.status).toBe(401);
  });

  it("rejects a wrong token with 401", async () => {
    const result = await rawHandshake(`${DEFAULT_TRANSPORT_PATH}?token=nope`, {
      Origin: base,
    });
    expect(result.status).toBe(401);
  });

  it("rejects a foreign origin with 403", async () => {
    const result = await rawHandshake(`${DEFAULT_TRANSPORT_PATH}?token=${TOKEN}`, {
      Origin: "http://evil.example",
    });
    expect(result.status).toBe(403);
  });

  it("rejects a missing origin (non-browser client) with 403", async () => {
    const result = await rawHandshake(`${DEFAULT_TRANSPORT_PATH}?token=${TOKEN}`, {});
    expect(result.status).toBe(403);
  });

  it("accepts the same-origin handshake with the token", async () => {
    const result = await rawHandshake(`${DEFAULT_TRANSPORT_PATH}?token=${TOKEN}`, {
      Origin: base,
    });
    expect(result.status).toBe(101);
  });

  it("rejects unknown upgrade paths with 404", async () => {
    const result = await rawHandshake(`/elsewhere?token=${TOKEN}`, { Origin: base });
    expect(result.status).toBe(404);
  });

  it("serves the SPA shell for a plain GET to the transport path", async () => {
    const response = await fetch(`${base}${DEFAULT_TRANSPORT_PATH}?token=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

describe("ws transport echo mode (spike contract, §5.3)", () => {
  it("echoes binary frames byte-exact", async () => {
    const client = await openClient(wsUrl(), { Origin: base });
    try {
      const chunk = Uint8Array.from({ length: 300 }, (_, i) => (i * 11 + 5) & 0xff);
      const reply = nextMessage(client);
      client.send(chunk, { binary: true });
      const { binary } = await reply;
      const bytes = binary === null ? new Uint8Array(0) : Uint8Array.from(binary);
      expect(bytes).toEqual(chunk);
      expect(bytes[0]).toBe(5);
      expect(bytes[299]).toBe((299 * 11 + 5) & 0xff);
    } finally {
      client.close();
    }
  });

  it("answers the ping control frame with pong", async () => {
    const client = await openClient(wsUrl(), { Origin: base });
    try {
      const reply = nextMessage(client);
      client.send(JSON.stringify({ t: "ping" }));
      const frame = JSON.parse((await reply).text ?? "{}") as TransportControlFrame;
      expect(frame.t).toBe("pong");
    } finally {
      client.close();
    }
  });

  it("flags unsupported control frames instead of echoing them", async () => {
    const client = await openClient(wsUrl(), { Origin: base });
    try {
      const reply = nextMessage(client);
      client.send(JSON.stringify({ t: "attach", sessionId: "abc" }));
      const frame = JSON.parse((await reply).text ?? "{}") as TransportControlFrame;
      expect(frame.t).toBe("error");
      expect(frame.code).toBe("unsupported-control");
      expect(frame.received).toBe("attach");
    } finally {
      client.close();
    }
  });

  it("reports malformed JSON control input as bad-json", async () => {
    const client = await openClient(wsUrl(), { Origin: base });
    try {
      const reply = nextMessage(client);
      client.send("<this is not json>");
      const frame = JSON.parse((await reply).text ?? "{}") as TransportControlFrame;
      expect(frame.t).toBe("error");
      expect(frame.code).toBe("bad-json");
    } finally {
      client.close();
    }
  });

  it("keeps two parallel sessions independent", async () => {
    const a = await openClient(wsUrl(), { Origin: base });
    const b = await openClient(wsUrl(), { Origin: base });
    try {
      const replyA = nextMessage(a);
      const replyB = nextMessage(b);
      a.send(Uint8Array.from([1, 2]), { binary: true });
      b.send(Uint8Array.from([9, 9, 9, 9]), { binary: true });
      expect(Uint8Array.from((await replyA).binary!)).toEqual(Uint8Array.from([1, 2]));
      expect(Uint8Array.from((await replyB).binary!)).toEqual(Uint8Array.from([9, 9, 9, 9]));
    } finally {
      a.close();
      b.close();
    }
  });

  it("tracks the number of live connections", async () => {
    const a = await openClient(wsUrl(), { Origin: base });
    await waitUntil(() => server.transportConnections === 1);
    const b = await openClient(wsUrl(), { Origin: base });
    await waitUntil(() => server.transportConnections === 2);
    b.close();
    await waitUntil(() => server.transportConnections === 1);
    a.close();
    await waitUntil(() => server.transportConnections === 0);
  });

  it("closes live sessions when the server stops", async () => {
    const client = await openClient(wsUrl(), { Origin: base });
    const closed = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });
    await server.stop();
    await expect(closed).resolves.toBeGreaterThanOrEqual(1000);
  });
});

describe("sse fallback channel", () => {
  it("requires the token", async () => {
    const response = await fetch(`${base}/api/events`);
    expect(response.status).toBe(401);
  });

  it("streams an event-source response and tracks subscribers", async () => {
    const response = await fetch(`${base}/api/events?token=${TOKEN}`, {
      headers: { Accept: "text/event-stream" },
    });
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await waitUntil(() => server.sseSubscribers === 1);
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      expect(Buffer.from(value).toString("utf8")).toContain("retry: 3000");
      await reader.cancel(); // closes the stream → subscriber count drops
    } finally {
      await waitUntil(() => server.sseSubscribers === 0);
    }
  });
});

describe("transport adapter variants", () => {
  it("returns an inert stub for the sse-post kind", () => {
    const stub = new SsePostTransport();
    expect(stub.kind).toBe("sse-post");
    expect(stub.activeConnections).toBe(0);
    expect(() => stub.attachHttpServer()).not.toThrow();
    expect(() => stub.dispose()).not.toThrow();
  });

  it("feeds an injected sink with binary frames and control messages", async () => {
    const seen: Array<{ binary: Uint8Array | null; control: TransportControlFrame | null }> = [];
    const sink = (connection: TransportConnection): void => {
      connection.onBinary((data) => seen.push({ binary: data, control: null }));
      connection.onControl((frame) => seen.push({ binary: null, control: frame }));
    };
    const custom = new WebSocketTransport({ token: TOKEN, log: () => {}, onConnection: sink });
    const plain = new ConsoleHttpServer({ token: TOKEN, port: 0, transport: custom });
    await plain.start();
    try {
      const url = `${plain.origin!.replace("http:", "ws:")}${DEFAULT_TRANSPORT_PATH}?token=${TOKEN}`;
      const client = await openClient(url, { Origin: plain.origin! });
      client.send(Uint8Array.from([42, 43]), { binary: true });
      client.send(JSON.stringify({ t: "resize", cols: 80, rows: 24 }));
      await waitUntil(
        () => seen.some((entry) => entry.control?.t === "resize" && entry.control.cols === 80),
      );
    } finally {
      await plain.stop();
    }
  });

  it("refuses to attach twice", async () => {
    const second = new WebSocketTransport({ token: TOKEN });
    const plain = new ConsoleHttpServer({ token: TOKEN, port: 0, transport: second });
    await plain.start();
    try {
      expect(() => second.attachHttpServer({} as http.Server)).toThrow(/already attached/);
    } finally {
      await plain.stop();
    }
  });

  it("requires a token at construction", () => {
    expect(() => new WebSocketTransport({ token: "" })).toThrow(/non-empty access token/);
  });
});
