import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_EVENTS_PATH,
  DASHBOARD_EVENT_READY,
  DASHBOARD_HEALTH_PATH,
  DASHBOARD_NODE_PATH,
  DASHBOARD_PROJECT_PARAM,
  DASHBOARD_SEARCH_PATH,
  DASHBOARD_STATS_PATH,
  DASHBOARD_TOKEN_PARAM,
  DASHBOARD_TREE_PATH,
  dashboardUrl,
  type HealthResponse,
  type NodeResponse,
  type ReadyEvent,
  type SearchResponse,
  type StatsResponse,
  type TreeResponse,
} from "../shared/api";
import {
  leafStatusSchema,
  nodeKindSchema,
  type LeafStatus,
  type NodeKind,
} from "../shared/tree";
import type { LuckPlannerStore } from "./store";

/**
 * Dashboard HTTP server (PLAN.md stage F1, `__doc.md` §6).
 *
 * The 2D/3D dashboards are a separate web app (ADR-1) that this server
 * *serves* from `dist/dashboard` and feeds from a read-only JSON API. It runs
 * in the daemon subprocess next to the store, so it shares the one SQLite file
 * the panel and the agent MCP servers use (ADR-2).
 *
 * Security (ADR-8/ADR-9):
 * - binds `127.0.0.1` only — never `0.0.0.0` (the memory-flash `httpHost`
 *   setting has no counterpart here on purpose);
 * - every `/api/*` request needs the per-installation token, accepted either
 *   as `?token=` (how the browser tab is opened) or `Authorization: Bearer`
 *   (how scripts call it). The comparison is constant-time; the token is
 *   never logged;
 * - the API is **read-only** — there is no write path here, so a leaked token
 *   cannot mutate the tree (mutations stay on MCP/RPC);
 * - static assets are unauthenticated: they are the SPA shell (no data) and
 *   the browser cannot attach the token to relative asset requests.
 * `GET /health` is the public liveness probe.
 *
 * The response payloads are the shared contracts in `shared/api.ts`, which
 * reuses the RPC output schemas — one shape for the panel and the dashboard.
 */

/** The only interface the server ever binds (ADR-9). */
export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";

/** Heartbeat interval for idle SSE streams (proxies drop silent sockets). */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * Resolves the plugin version for `GET /health` from `package.json`. The
 * daemon loads `server/http-server.ts` from the plugin checkout, so the file
 * sits one level up; a missing/unreadable manifest degrades to `0.0.0`
 * instead of failing the endpoint.
 */
export function resolvePluginVersion(): string {
  try {
    const raw = fs.readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * `dist/dashboard` next to the plugin checkout — the SPA build produced by
 * stage G1. Kept as a function (not a constant) so tests can point the server
 * at a temporary directory.
 */
export function resolveDashboardDir(): string {
  return fileURLToPath(new URL("../dist/dashboard/", import.meta.url));
}

// ---------------------------------------------------------------------------
// Response builders — pure functions over the store, testable without HTTP.
// ---------------------------------------------------------------------------

/** The whole graph of one project in one read (nodes/bees/bugs/goals/growth). */
export function buildTreeResponse(
  store: LuckPlannerStore,
  projectKey: string,
): TreeResponse {
  return {
    projectKey,
    generatedAt: Date.now(),
    nodes: store.listNodes(projectKey),
    bees: store.listBees(projectKey),
    bugs: store.listBugs(projectKey),
    bugAttachments: store.listBugAttachments(projectKey),
    goals: store.listGoals(projectKey),
    growth: store.listGrowth(projectKey),
  };
}

/** One node with everything the details panel renders; `null` when unknown. */
export function buildNodeResponse(
  store: LuckPlannerStore,
  projectKey: string,
  nodeId: string,
): NodeResponse | null {
  const node = store.getNode(projectKey, nodeId);
  if (!node) return null;
  return {
    node,
    path: store.getNodePath(projectKey, node.id),
    children: store.listChildren(projectKey, node.id),
    bees: store.listBeesForNode(projectKey, node.id),
    bugs: store.listBugsForNode(projectKey, node.id),
    blockingBugs: store.listBlockingBugs(projectKey, node.id),
    history: store.listHistory(projectKey, node.id),
    growth: store.getGrowthForSubject(projectKey, "node", node.id),
  };
}

/** Query-derived search options; unknown `kind`/`status` values are rejected. */
function parseSearchOptions(
  params: URLSearchParams,
): { kind: NodeKind[]; status: LeafStatus[]; query: string; limit?: number } {
  const readList = (name: string): string[] =>
    params
      .getAll(name)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

  const kinds: NodeKind[] = [];
  for (const value of readList("kind")) {
    const parsed = nodeKindSchema.safeParse(value);
    if (!parsed.success) throw new Error(`unknown node kind "${value}"`);
    kinds.push(parsed.data);
  }
  const statuses: LeafStatus[] = [];
  for (const value of readList("status")) {
    const parsed = leafStatusSchema.safeParse(value);
    if (!parsed.success) throw new Error(`unknown leaf status "${value}"`);
    statuses.push(parsed.data);
  }

  let limit: number | undefined;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && rawLimit.trim().length > 0) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("limit must be a positive integer");
    }
    limit = parsed;
  }

  return { kind: kinds, status: statuses, query: params.get("q") ?? "", limit };
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Shown at `/` when `dist/dashboard` is absent — e.g. a checkout where the
 * `build` step never ran (the MCP server works from source, the SPA needs the
 * bundle). It keeps such an install from answering a blank 404 and tells a
 * human where to look; the JSON API below it already works.
 */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>luck-planner dashboard</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem; line-height: 1.5">
<h1>luck-planner dashboard</h1>
<p>The dashboard web app is not built in this checkout (run the plugin build).</p>
<p>The read-only API is live: <code>/health</code>, <code>/api/tree</code>,
<code>/api/node/:id</code>, <code>/api/search</code>, <code>/api/stats</code>,
<code>/api/events</code> — each needs the access token as <code>?token=</code>.</p>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface DashboardHttpServerOptions {
  store: LuckPlannerStore;
  /** Access token every `/api/*` request must present. */
  token: string;
  /** Bind port; `0` asks the OS for an ephemeral one. */
  port: number;
  /** Bind address; defaults to the loopback constant. */
  host?: string;
  /** Reported by `GET /health`; defaults to `package.json`. */
  version?: string;
  /** SPA root; defaults to `dist/dashboard`. */
  dashboardDir?: string;
  /**
   * Audit-row cursor reported in the SSE `ready` payload (stage H1). The
   * endpoint passes its change feed's watermark, so a reconnecting tab can
   * tell whether it missed anything; defaults to a constant `0`.
   */
  watermark?: () => number;
}

export class DashboardHttpServer {
  private readonly store: LuckPlannerStore;
  private readonly token: string;
  private readonly host: string;
  private readonly version: string;
  private readonly dashboardDir: string;
  private readonly watermark: () => number;
  private readonly options: DashboardHttpServerOptions;
  private server: http.Server | null = null;
  /** Actual bound port — differs from the requested one when 0 was asked. */
  private boundPort: number | null = null;
  private boundAddress: string | null = null;
  /**
   * Open SSE streams. Each keeps its heartbeat timer and the project it was
   * opened for (`null` = every project), so a broadcast only wakes the tabs
   * that care about the project that changed (stage H1).
   */
  private readonly sseClients = new Map<
    http.ServerResponse,
    { heartbeat: NodeJS.Timeout; projectKey: string | null }
  >();

  constructor(options: DashboardHttpServerOptions) {
    // An empty token would expose the API to any local process; never allow it
    // (the endpoint generates one when the setting is empty).
    if (options.token.length === 0) {
      throw new Error("the dashboard HTTP server requires a non-empty access token");
    }
    this.options = options;
    this.store = options.store;
    this.token = options.token;
    this.host = options.host ?? DEFAULT_DASHBOARD_HOST;
    this.version = options.version ?? resolvePluginVersion();
    this.dashboardDir = options.dashboardDir ?? resolveDashboardDir();
    this.watermark = options.watermark ?? (() => 0);
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Interface the socket is actually bound to, verbatim. */
  get boundHost(): string {
    return this.boundAddress ?? this.host;
  }

  /** Port the socket is actually bound to (`0` requested → ephemeral). */
  get boundTcpPort(): number {
    return this.boundPort ?? this.options.port;
  }

  /** `http://host:port` of the running server, or `null` when it is down. */
  get origin(): string | null {
    if (!this.listening) return null;
    return `http://${this.boundHost}:${this.boundTcpPort}`;
  }

  /**
   * Browser URL of the dashboard, token included — the address stage F2 opens
   * in the workspace browser. `null` while the server is down. Carries no
   * project: see {@link urlForProject} for the per-workspace URL.
   */
  get url(): string | null {
    const origin = this.origin;
    if (origin === null) return null;
    return dashboardUrl(origin, this.token);
  }

  /**
   * Dashboard URL pointed at one project (token + `?project=`), so opening the
   * dashboard from a workspace lands on that workspace's tree. `null` while the
   * server is down.
   */
  urlForProject(projectKey: string): string | null {
    const origin = this.origin;
    if (origin === null) return null;
    return dashboardUrl(origin, this.token, projectKey);
  }

  /** Number of live SSE streams — lets tests and the status screen see them. */
  get sseClientCount(): number {
    return this.sseClients.size;
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

  /**
   * Stops the server: closes every SSE stream, drops the listening socket and
   * force-closes keep-alive connections so the port is released immediately
   * (a leaked port would break the next `start` on the same setting).
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      this.closeSseClients();
      if (!server) {
        resolve();
        return;
      }
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      // Keep-alive sockets would otherwise hold `close` open indefinitely.
      server.closeAllConnections();
    });
  }

  /**
   * Pushes one event to every open SSE stream — or, when `projectKey` is
   * given, only to the streams opened for that project (stage H1: a daemon
   * can host several workspaces, and a tab for one of them must not refetch
   * because another project moved).
   */
  broadcast(event: string, data: unknown, projectKey?: string): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, client] of [...this.sseClients.entries()]) {
      if (projectKey !== undefined && client.projectKey !== null && client.projectKey !== projectKey) {
        continue;
      }
      try {
        res.write(payload);
      } catch {
        this.closeSseClient(res);
      }
    }
  }

  // -------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === DASHBOARD_HEALTH_PATH) {
      if (req.method !== "GET") {
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const body: HealthResponse = {
        ok: true,
        server: "luck-planner",
        version: this.version,
      };
      this.sendJson(res, 200, body);
      return;
    }

    const isApi = url.pathname.startsWith("/api/");

    if (isApi) {
      // Every `/api/*` path — known or not — is authenticated first, so the
      // route table is not exposed to an unauthenticated local caller.
      if (!this.authorized(req, url)) {
        this.sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method !== "GET") {
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (url.pathname === DASHBOARD_EVENTS_PATH) {
        this.openSseStream(req, res, url);
        return;
      }
      this.handleApi(url, res);
      return;
    }

    this.serveStatic(req, res, url);
  }

  /** Constant-time token check; `?token=` first, then `Bearer`. */
  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const fromQuery = url.searchParams.get(DASHBOARD_TOKEN_PARAM);
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
    // Length differences are not secret, but timingSafeEqual requires equal
    // lengths, so a mismatch short-circuits before the comparison.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  private handleApi(url: URL, res: http.ServerResponse): void {
    // Route first, then validate the project parameter: an unknown route is a
    // 404 no matter what the query says, and a known one needs `project`.
    const isNode = url.pathname.startsWith(`${DASHBOARD_NODE_PATH}/`);
    const isKnown =
      isNode ||
      url.pathname === DASHBOARD_TREE_PATH ||
      url.pathname === DASHBOARD_STATS_PATH ||
      url.pathname === DASHBOARD_SEARCH_PATH;
    if (!isKnown) {
      this.sendJson(res, 404, { error: "not found" });
      return;
    }

    const project = url.searchParams.get(DASHBOARD_PROJECT_PARAM);
    if (project === null || project.length === 0) {
      this.sendJson(res, 400, {
        error: `the "${DASHBOARD_PROJECT_PARAM}" query parameter is required`,
      });
      return;
    }
    const projectKey = project;

    try {
      if (url.pathname === DASHBOARD_TREE_PATH) {
        this.sendJson(res, 200, buildTreeResponse(this.store, projectKey));
        return;
      }
      if (url.pathname === DASHBOARD_STATS_PATH) {
        const body: StatsResponse = this.store.stats(projectKey);
        this.sendJson(res, 200, body);
        return;
      }
      if (url.pathname === DASHBOARD_SEARCH_PATH) {
        const options = parseSearchOptions(url.searchParams);
        const hits = this.store.search(options.query, {
          projectKey,
          kinds: options.kind,
          statuses: options.status,
          includeArchived: url.searchParams.get("includeArchived") === "1",
          limit: options.limit,
        });
        const body: SearchResponse = {
          matches: hits.length,
          results: hits.map((hit) => ({
            node: hit.node,
            score: hit.score,
            snippet: hit.snippet,
          })),
        };
        this.sendJson(res, 200, body);
        return;
      }
      if (isNode) {
        const encoded = url.pathname.slice(DASHBOARD_NODE_PATH.length + 1);
        let nodeId: string;
        try {
          nodeId = decodeURIComponent(encoded);
        } catch {
          this.sendJson(res, 400, { error: "malformed node id" });
          return;
        }
        if (nodeId.length === 0) {
          this.sendJson(res, 400, { error: "a node id is required" });
          return;
        }
        const body = buildNodeResponse(this.store, projectKey, nodeId);
        if (body === null) {
          this.sendJson(res, 404, { error: "not found" });
          return;
        }
        this.sendJson(res, 200, body);
        return;
      }
    } catch (cause) {
      // A store rejection (bad filter value, malformed project key) is a
      // client error, not a crash: the server never dies on bad input.
      this.sendJson(res, 400, {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Static SPA
  // -------------------------------------------------------------------------

  private serveStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      this.sendJson(res, 400, { error: "malformed path" });
      return;
    }

    const indexFile = path.join(this.dashboardDir, "index.html");
    if (!fs.existsSync(indexFile)) {
      // Nothing built yet (stage G1) — a truthful placeholder, not a 404.
      this.sendHtml(res, 200, PLACEHOLDER_HTML, req.method === "HEAD");
      return;
    }

    const root = path.resolve(this.dashboardDir);
    const relative = decoded.replace(/^\/+/, "");
    const candidate = path.resolve(root, relative);
    const inside = candidate === root || candidate.startsWith(`${root}${path.sep}`);

    if (
      relative.length > 0 &&
      inside &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      this.sendFile(res, candidate, req.method === "HEAD");
      return;
    }

    // SPA fallback: an extensionless route is a client-side path, not a
    // missing asset, so it gets index.html. A path that escaped the root
    // never reaches here as a file (it is either extensionless → index.html,
    // or has an extension → 404), so traversal cannot read anything.
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

  private sendHtml(
    res: http.ServerResponse,
    status: number,
    html: string,
    headOnly: boolean,
  ): void {
    const body = Buffer.from(html, "utf8");
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.byteLength,
      "Cache-Control": "no-store",
    });
    if (headOnly) res.end();
    else res.end(body);
  }

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------

  private openSseStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // A stream may narrow itself to one project (`?project=`, the way the
    // dashboard opens it); without it, the client filters the payloads.
    const requested = url.searchParams.get(DASHBOARD_PROJECT_PARAM);
    const projectKey = requested !== null && requested.length > 0 ? requested : null;
    // Reconnect delay and an immediate `ready` carrying the version and the
    // audit watermark, so the dashboard knows the stream is live before the
    // first mutation ever happens (stage F1/H1) and can tell a reconnect from
    // a first connect.
    const ready: ReadyEvent = { version: this.version, watermark: this.watermark() };
    res.write("retry: 3000\n\n");
    res.write(`event: ${DASHBOARD_EVENT_READY}\ndata: ${JSON.stringify(ready)}\n\n`);
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        this.closeSseClient(res);
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    this.sseClients.set(res, { heartbeat, projectKey });

    const cleanup = (): void => this.closeSseClient(res);
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  private closeSseClient(res: http.ServerResponse): void {
    const client = this.sseClients.get(res);
    if (client === undefined) return;
    clearInterval(client.heartbeat);
    this.sseClients.delete(res);
    try {
      res.end();
    } catch {
      // The socket may already be gone; nothing left to close.
    }
  }

  private closeSseClients(): void {
    for (const res of [...this.sseClients.keys()]) this.closeSseClient(res);
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
