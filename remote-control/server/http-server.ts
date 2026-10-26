import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { resolveConsoleDir, resolvePluginVersion } from "./paths";
import type { TransportBridge } from "./transport";
import type { SessionRegistry } from "./sessions";
import {
  applyGhosttySettings,
  loadGhosttySettings,
  previewGhosttyImport,
} from "./ghostty-config";

export const DEFAULT_CONSOLE_HOST = "127.0.0.1";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>remote-control console</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem; line-height: 1.5">
<h1>remote-control console</h1>
<p>The console web app is not built in this checkout (run the plugin build).</p>
</body>
</html>
`;

export interface ConsoleHttpServerOptions {
  token: string;
  port: number;
  host?: string;
  version?: string;
  consoleDir?: string;
  /** WebSocket bridge for the terminal transport (A3); disposed on stop(). */
  transport?: TransportBridge;
  /** Session registry for /api/sessions routes and SSE broadcasts. */
  sessions?: SessionRegistry;
}

export class ConsoleHttpServer {
  private readonly token: string;
  private readonly host: string;
  private readonly version: string;
  private readonly consoleDir: string;
  private readonly transport: TransportBridge | null;
  private readonly sessions: SessionRegistry | null;
  private readonly options: ConsoleHttpServerOptions;
  private server: http.Server | null = null;
  private boundPort: number | null = null;
  private boundAddress: string | null = null;

  /**
   * Fallback channel probe (ADR-6/ADR-12 groundwork): a trivial SSE stream
   * with heartbeats. No state changes are emitted yet — that arrives with
   * the change-feed stage; here the route only proves the workspace
   * browser streams from the plugin server at all.
   */
  private eventClients = new Set<http.ServerResponse>();
  private eventTicker: ReturnType<typeof setInterval> | null = null;

  constructor(options: ConsoleHttpServerOptions) {
    if (options.token.length === 0) {
      throw new Error("the console HTTP server requires a non-empty access token");
    }
    this.options = options;
    this.token = options.token;
    this.host = options.host ?? DEFAULT_CONSOLE_HOST;
    this.version = options.version ?? resolvePluginVersion();
    this.consoleDir = options.consoleDir ?? resolveConsoleDir();
    this.transport = options.transport ?? null;
    this.sessions = options.sessions ?? null;
    if (this.sessions) {
      this.sessions.setOnEvent((event) => {
        this.broadcastSse(event.type, event);
      });
    }
  }

  /** Number of live transport connections (WebSocket bridge). */
  get transportConnections(): number {
    return this.transport?.activeConnections ?? 0;
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  get boundHost(): string {
    return this.boundAddress ?? this.host;
  }

  get boundTcpPort(): number {
    return this.boundPort ?? this.options.port;
  }

  get origin(): string | null {
    if (!this.listening) return null;
    return `http://${this.boundHost}:${this.boundTcpPort}`;
  }

  get url(): string | null {
    const origin = this.origin;
    if (origin === null) return null;
    return `${origin}/?token=${encodeURIComponent(this.token)}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      server.on("error", (error) => {
        if (server.listening) return;
        reject(error);
      });
      server.on("clientError", (_error, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });
      this.server = server;
      if (this.transport) this.transport.attachHttpServer(server);
      server.listen(this.options.port, this.host, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          this.boundPort = address.port;
          this.boundAddress = address.address;
        }
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      const transport = this.transport;
      this.eventClients.clear();
      if (this.eventTicker !== null) {
        clearInterval(this.eventTicker);
        this.eventTicker = null;
      }
      // Dispose the bridge first: Node does not track upgraded WebSocket
      // sockets in closeAllConnections(), so a live terminal connection
      // would otherwise keep server.close() hanging for the socket lifetime.
      transport?.dispose();
      if (!server || !server.listening) {
        return resolve();
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      this.sendJson(res, 200, { ok: true, server: "remote-control", version: this.version });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!this.authorized(req, url)) {
        this.sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (url.pathname === "/api/state") {
        if (req.method !== "GET") {
          this.sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        this.sendJson(res, 200, { ok: true, listening: true });
        return;
      }
      if (url.pathname === "/api/events") {
        if (req.method !== "GET") {
          this.sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        this.serveEvents(req, res);
        return;
      }
      if (url.pathname === "/api/sessions") {
        if (!this.sessions) {
          this.sendJson(res, 503, { error: "sessions unavailable" });
          return;
        }
        if (req.method === "GET") {
          this.sendJson(res, 200, { sessions: this.sessions.list() });
          return;
        }
        if (req.method === "POST") {
          void this.readJsonBody(req)
            .then((body) => {
              const kind = (body && typeof body === "object" && "kind" in body)
                ? String((body as { kind: unknown }).kind)
                : "local";
              if (kind !== "local") {
                this.sendJson(res, 400, { error: `unsupported session kind: ${kind}` });
                return;
              }
              const title = (body && typeof body === "object" && "title" in body)
                ? String((body as { title: unknown }).title)
                : undefined;
              const session = this.sessions!.createLocal({ title });
              this.sendJson(res, 201, { session });
            })
            .catch((cause) => {
              this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
            });
          return;
        }
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)\/(kill|reconnect)$/.exec(url.pathname);
      if (sessionMatch && this.sessions) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        if (req.method !== "POST") {
          this.sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        if (sessionMatch[2] === "kill") {
          const ok = this.sessions.kill(sessionId);
          this.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" });
          return;
        }
        const session = this.sessions.reconnect(sessionId);
        if (!session) {
          this.sendJson(res, 404, { error: "not found" });
          return;
        }
        this.sendJson(res, 200, { session });
        return;
      }
      if (url.pathname === "/api/ghostty/import") {
        if (req.method === "GET") {
          return;
        }
        if (req.method === "POST") {
          void this.readJsonBody(req)
            .then((body) => {
              const settings = (body && typeof body === "object" && "settings" in body)
                ? (body as { settings: unknown }).settings
                : body;
              applyGhosttySettings(settings as never);
              this.sendJson(res, 200, { ok: true, settings: loadGhosttySettings() });
            })
            .catch((cause) => {
              this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
            });
          return;
        }
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      this.sendJson(res, 404, { error: "not found" });
      return;
    }

    this.serveStatic(req, res, url);
  }

  /** Number of open SSE subscriptions. */
  get sseSubscribers(): number {
    return this.eventClients.size;
  }

  broadcastSse(eventName: string, data: unknown): void {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.eventClients) {
      try {
        client.write(payload);
      } catch {
        this.eventClients.delete(client);
      }
    }
  }

  private serveEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    this.eventClients.add(res);
    if (this.eventTicker === null) {
      this.eventTicker = setInterval(() => {
        for (const client of this.eventClients) {
          try {
            client.write(": heartbeat\n\n");
          } catch {
            this.eventClients.delete(client);
          }
        }
      }, 15_000);
    }
    req.on("close", () => {
      this.eventClients.delete(res);
      if (this.eventClients.size === 0 && this.eventTicker !== null) {
        clearInterval(this.eventTicker);
        this.eventTicker = null;
      }
    });
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
      req.on("error", reject);
    });
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const fromQuery = url.searchParams.get("token");
    if (fromQuery !== null && this.tokenMatches(fromQuery)) return true;
    const header = req.headers.authorization;
    if (typeof header === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (match && this.tokenMatches(match[1].trim())) return true;
    }
    return false;
  }

  private tokenMatches(provided: string): boolean {
    const expected = Buffer.from(this.token, "utf8");
    const actual = Buffer.from(provided, "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const indexFile = path.join(this.consoleDir, "index.html");
    if (!fs.existsSync(indexFile)) {
      this.sendHtml(res, 200, PLACEHOLDER_HTML, req.method === "HEAD");
      return;
    }
    const root = path.resolve(this.consoleDir);
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      this.sendJson(res, 400, { error: "malformed path" });
      return;
    }
    const relative = decoded.replace(/^\/+/, "");
    const candidate = path.resolve(root, relative);
    const inside = candidate === root || candidate.startsWith(`${root}${path.sep}`);
    if (relative.length > 0 && inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      this.sendFile(res, candidate, req.method === "HEAD");
      return;
    }
    if (path.extname(relative).length === 0) {
      this.sendFile(res, indexFile, req.method === "HEAD");
      return;
    }
    this.sendJson(res, 404, { error: "not found" });
  }

  private sendFile(res: http.ServerResponse, file: string, headOnly: boolean): void {
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch {
      this.sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(file),
      "Content-Length": data.byteLength,
      "Cache-Control": "no-store",
    });
    if (headOnly) res.end();
    else res.end(data);
  }

  private sendHtml(res: http.ServerResponse, status: number, html: string, headOnly: boolean): void {
    const body = Buffer.from(html, "utf8");
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.byteLength,
      "Cache-Control": "no-store",
    });
    if (headOnly) res.end();
    else res.end(body);
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }
}
