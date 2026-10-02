import * as http from "node:http";
import type { ApiKeyRecord } from "./store";
import {
  handleJsonRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./mcp-jsonrpc";
import type { McpDispatchContext } from "./mcp-tools";

/**
 * Memory Flash MCP endpoint — JSON-RPC 2.0 over HTTP (0.5.0).
 *
 * Serves the same MCP tools as the stdio server, but for remote
 * clients: `POST /mcp` with `Authorization: Bearer <secret>`.
 * Secrets are verified against the SHA-256 hash stored by
 * `MemoryStore`; only the hash is ever kept, and the `Authorization`
 * header is never logged. Local agents keep using stdio.
 *
 * Security:
 * - missing/invalid/revoked/expired key → 401 with a generic body
 *   (no details about which check failed);
 * - 401s are rate-limited per client IP to slow key brute-forcing;
 * - `read`-scoped keys see and call read-only tools only;
 * - request bodies are capped (1 MiB).
 *
 * `GET /mcp` answers 405 (allowed by the Streamable HTTP spec for
 * servers that do not offer SSE streams). `GET /healthz` is an
 * unauthenticated liveness probe for connection checks.
 */

/** MCP path served by this endpoint. */
export const MCP_HTTP_PATH = "/mcp";
/** Unauthenticated liveness probe used by connection checks. */
export const HEALTH_PATH = "/healthz";

/**
 * Identity headers sent by memory-flash-client. They carry no authority —
 * authentication is the API key alone — but the memory host records who
 * connected so several clients can be told apart in the audit trail.
 */
export const CLIENT_ID_HEADER = "x-memory-flash-client-id";
export const CLIENT_HOST_HEADER = "x-memory-flash-host";

/** Identity a client announced on a request, as shown in the audit log. */
export interface ClientIdentity {
  /** Stable client UUID (memory-flash-client setting). */
  clientId: string;
  /** Human-readable host name the client runs on. */
  host: string;
}

/** Reads and sanitizes the identity headers; missing values stay empty. */
export function readClientIdentity(
  headers: http.IncomingHttpHeaders,
): ClientIdentity | null {
  const clientId = sanitizeHeaderValue(headers[CLIENT_ID_HEADER]);
  const host = sanitizeHeaderValue(headers[CLIENT_HOST_HEADER]);
  if (clientId === null && host === null) return null;
  return { clientId: clientId ?? "unknown", host: host ?? "unknown" };
}

/**
 * Keeps header values printable and single-line so a crafted value cannot
 * forge extra log lines. Values are also length-capped.
 */
function sanitizeHeaderValue(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\x20-\x7e]/g, "").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 64);
}

/** Tools a `read`-scoped key may see and call. */
const READ_ONLY_TOOLS = new Set([
  "memory_search",
  "memory_get",
  "memory_list_by_tag",
  "memory_stats",
]);

/** Reject bodies larger than this (bytes). */
const MAX_BODY_BYTES = 1024 * 1024;

/** Window for counting failed authentications. */
const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Failed authentications per IP within the window before 429. */
const MAX_AUTH_FAILURES = 10;

interface HttpServerOptions {
  host: string;
  port: number;
  context: McpDispatchContext;
  serverInfo: { name: string; version: string };
}

/** Per-IP 401 rate limiter (in-memory; restarts clear it). */
class AuthFailureRateLimiter {
  private failures = new Map<string, number[]>();

  /** Records a failure; returns true when the IP is now blocked. */
  recordFailure(ip: string): boolean {
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter(
      (at) => now - at < AUTH_FAILURE_WINDOW_MS,
    );
    recent.push(now);
    this.failures.set(ip, recent);
    return recent.length > MAX_AUTH_FAILURES;
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}

function parseBearer(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const secret = match[1].trim();
  return secret.length > 0 ? secret : null;
}

export class McpHttpServer {
  private readonly options: HttpServerOptions;
  private server: http.Server | null = null;
  /** Actual bound port — differs from the requested one when 0 (ephemeral). */
  private boundPort: number | null = null;
  private readonly rateLimiter = new AuthFailureRateLimiter();

  constructor(options: HttpServerOptions) {
    this.options = options;
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  get url(): string | null {
    if (!this.listening) return null;
    const host = this.options.host;
    const displayHost =
      host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const port = this.boundPort ?? this.options.port;
    return `http://${displayHost}:${port}${MCP_HTTP_PATH}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      server.on("error", (error) => {
        if (server.listening) return; // runtime errors are not fatal
        reject(error);
      });
      server.on("clientError", (_error, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });
      this.server = server;
      server.listen(this.options.port, this.options.host, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          this.boundPort = address.port;
        }
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      if (!server) return resolve();
      server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const ip = req.socket.remoteAddress ?? "unknown";
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === HEALTH_PATH) {
      if (req.method !== "GET") {
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      // Liveness only — no database details, no key hints.
      this.sendJson(res, 200, { ok: true, server: "memory-flash-mcp" });
      return;
    }

    if (url.pathname !== MCP_HTTP_PATH) {
      this.sendJson(res, 404, { error: "not found" });
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      // Streamable HTTP servers without SSE streams may answer 405.
      this.sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (req.method !== "POST") {
      this.sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // Authenticate. Any failure looks the same to the caller.
    const secret = parseBearer(req.headers.authorization);
    let key: ApiKeyRecord | null = null;
    try {
      key = secret !== null ? this.authenticate(secret) : null;
    } catch {
      key = null;
    }
    if (key === null) {
      if (this.rateLimiter.recordFailure(ip)) {
        this.sendJson(res, 429, { error: "too many requests" });
      } else {
        this.sendJson(res, 401, { error: "unauthorized" });
      }
      return;
    }
    this.rateLimiter.recordSuccess(ip);

    // Identity is advisory (the key already granted access) and is logged
    // only — the Authorization header itself is never logged.
    const identity = readClientIdentity(req.headers);
    this.log(
      `[memory-flash] client ${identity ? `${identity.host} (${identity.clientId})` : "unidentified"} ` +
        `authenticated with key ${key.id} [${key.label}] from ${ip}`,
    );

    this.readBody(req, (body) => {
      if (body === null) {
        this.sendJson(res, 413, { error: "payload too large" });
        return;
      }
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        this.sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }
      this.dispatch(request, key, res);
    });
  }

  private authenticate(secret: string): ApiKeyRecord | null {
    return this.options.context.store.authenticateApiKey(secret);
  }

  private dispatch(
    request: JsonRpcRequest,
    key: ApiKeyRecord,
    res: http.ServerResponse,
  ): void {
    const readOnly = !key.scopes.includes("read_write");

    // Scope check happens before dispatch: a read-only key must not
    // execute write tools, even though they exist on the server.
    if (readOnly && request.method === "tools/call") {
      const name = String((request.params ?? {}).name ?? "");
      if (!READ_ONLY_TOOLS.has(name)) {
        this.sendJson(res, 200, {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: {
            code: -32000,
            message: `Insufficient scope: "${name}" requires a read_write key`,
          },
        });
        return;
      }
    }

    const response: JsonRpcResponse | null = handleJsonRpcRequest(
      request,
      this.options.context,
      this.options.serverInfo,
      (message) => this.log(message),
    );

    if (response === null) {
      // Notification — accepted, nothing to send.
      this.sendJson(res, 202, {});
      return;
    }

    if (readOnly && this.isToolListResult(response.result)) {
      const result = response.result as { tools: Array<{ name: string }> };
      result.tools = result.tools.filter((tool) => READ_ONLY_TOOLS.has(tool.name));
    }

    this.sendJson(res, 200, response);
  }

  private isToolListResult(result: unknown): boolean {
    if (typeof result !== "object" || result === null) return false;
    const record = result as Record<string, unknown>;
    return Array.isArray(record.tools);
  }

  private readBody(
    req: http.IncomingMessage,
    done: (body: string | null) => void,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (body: string | null): void => {
      if (finished) return;
      finished = true;
      done(body);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => finish(null));
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }

  /** Never receives the Authorization header — only status lines. */
  private log(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}
