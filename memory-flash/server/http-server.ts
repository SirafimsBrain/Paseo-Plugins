import * as http from "node:http";
import * as os from "node:os";
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
  // Measures search quality over control queries; writes nothing.
  "memory_diagnose",
]);

/** Reject bodies larger than this (bytes). */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Bind addresses that mean "every interface". Node accepts them, but nothing
 * can be *dialled* at them, so they must never be pasted into an MCP config.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*", ""]);

/** True for `0.0.0.0`, `::`, `*` and the empty string. */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim().toLowerCase());
}

/** Wraps a bare IPv6 literal in brackets so it can sit in a URL host part. */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Picks an address other machines can actually dial.
 *
 * A wildcard bind has no address of its own, so the first non-internal IPv4
 * (LAN/Wi-Fi, Tailscale included) is used, then a non-internal IPv6, and only
 * as a last resort loopback — correct for the tunnel case, but it does not
 * reach the network, so callers should show which one was picked.
 */
export function resolveRoutableHost(host: string): string {
  const trimmed = host.trim();
  if (!isWildcardHost(trimmed)) return trimmed;
  const addresses: os.NetworkInterfaceInfo[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) addresses.push(entry);
  }
  // `family` is the string "IPv4" on current Node and the number 4 on older
  // releases, so both spellings are accepted.
  const isIpv4 = (entry: os.NetworkInterfaceInfo): boolean =>
    entry.family === "IPv4" || (entry.family as unknown as number) === 4;
  const ipv4 = addresses.find((entry) => isIpv4(entry) && !entry.internal);
  if (ipv4) return ipv4.address;
  const ipv6 = addresses.find((entry) => !isIpv4(entry) && !entry.internal);
  if (ipv6) return ipv6.address;
  return "127.0.0.1";
}

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
  /** Actual bound address as reported by the OS (`0.0.0.0`, `127.0.0.1`, …). */
  private boundAddress: string | null = null;
  private readonly rateLimiter = new AuthFailureRateLimiter();

  constructor(options: HttpServerOptions) {
    this.options = options;
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Interface the endpoint is actually bound to, verbatim. */
  get boundHost(): string {
    return this.boundAddress ?? this.options.host;
  }

  /** Port the endpoint is actually bound to (differs when 0 was requested). */
  get boundTcpPort(): number {
    return this.boundPort ?? this.options.port;
  }

  /**
   * URL of the *bound* endpoint, including a wildcard address.
   *
   * This is what the settings screen shows as `listening on …`: it reports the
   * interface the socket really sits on, so switching the bind address is
   * visible. `http://0.0.0.0:8787/mcp` is not dialable and must not be copied
   * into an MCP config — use `url` for that.
   */
  get bindUrl(): string | null {
    if (!this.listening) return null;
    return `http://${urlHost(this.boundHost)}:${this.boundTcpPort}${MCP_HTTP_PATH}`;
  }

  /**
   * URL a remote client can be pointed at. A wildcard bind is replaced by the
   * first non-internal IPv4 (LAN/Wi-Fi/Tailscale), then a non-internal IPv6,
   * then loopback, so the copy block never contains `0.0.0.0`.
   */
  get url(): string | null {
    if (!this.listening) return null;
    const host = resolveRoutableHost(this.boundHost);
    return `http://${urlHost(host)}:${this.boundTcpPort}${MCP_HTTP_PATH}`;
  }

  /** True when the bound address is a wildcard other than loopback. */
  get wildcardBound(): boolean {
    return isWildcardHost(this.boundHost);
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
