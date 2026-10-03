import { McpHttpServer } from "./http-server";
import type { McpDispatchContext } from "./mcp-tools";
import type { MemoryStore } from "./store";

/**
 * Owns the lifetime of the HTTP MCP endpoint and keeps it in step with the
 * plugin settings (0.5.2).
 *
 * Why this is a class and not three lines inside `contribute`:
 *
 * - **Serialised.** Settings arrive per keystroke — typing `0.0.0.0` emits
 *   `0`, `0.`, `0.0`, `0.0.`, … and each one triggers a restart. Two syncs
 *   that overlap (the subscribe callback is fire-and-forget) used to interleave
 *   `await server.stop()` / `await server.start()`: the second sync saw
 *   `httpServer === null`, started its own listener, and the slower first sync
 *   then overwrote the reference — leaving the *old* port still listening
 *   forever while the status reported the new one. All work now runs on a
 *   promise chain, so a restart always finishes before the next one starts.
 * - **Truthful status.** The reported host/port come from the running socket,
 *   not from the settings, so the screen cannot claim `127.0.0.1:8787` while a
 *   wildcard bind is live on another port.
 * - **Live dispatch context.** `defaultAgentId` is written into the shared
 *   context object on every sync, so changing it takes effect without a
 *   restart (the stdio server reads it per call).
 */

/** Subset of the plugin settings the endpoint depends on. */
export interface HttpEndpointConfig {
  httpEnabled: boolean;
  httpHost: string;
  httpPort: number;
  defaultAgentId: string;
  serverName: string;
}

/** What the settings screen renders below the host/port inputs. */
export interface HttpEndpointStatus {
  /** Enabled in the settings, regardless of whether the socket came up. */
  enabled: boolean;
  /** A socket is bound right now. */
  listening: boolean;
  /** Configured bind address (what the user typed). */
  host: string;
  /** Configured port (what the user typed). */
  port: number;
  /** Interface the live socket is actually bound to; null when not listening. */
  boundHost: string | null;
  /** Port the live socket is actually bound to; null when not listening. */
  boundPort: number | null;
  /** True when the live bind is a wildcard (`0.0.0.0` / `::`). */
  wildcard: boolean;
  /** Verbatim bound URL for the status line — may be a wildcard address. */
  bindUrl: string | null;
  /** Dialable URL for the copy block; wildcard replaced with a real address. */
  url: string | null;
  /** Start/stop failure, or null. */
  error: string | null;
}

export interface HttpEndpointOptions {
  store: MemoryStore;
  serverInfo: { name: string; version: string };
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

/**
 * Quiet period before a settings change is applied. Long enough to swallow the
 * intermediate states of a typed address, short enough to feel immediate.
 */
const SETTLE_MS = 150;

export class HttpEndpoint {
  /** Tail of the serialised work chain; every applied change chains onto it. */
  private queue: Promise<void> = Promise.resolve();
  /** Newest config awaiting application (a newer one replaces it). */
  private pending: HttpEndpointConfig | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private server: McpHttpServer | null = null;
  /** Host/port of the live (or last attempted) server; drives restarts. */
  private bound: { host: string; port: number } | null = null;
  private error: string | null = null;
  private latest: HttpEndpointConfig | null = null;
  private disposed = false;
  /**
   * Shared with the running server. Mutated in place so a `defaultAgentId`
   * change applies to live requests without a restart.
   */
  private readonly context: McpDispatchContext;
  /** Mutable so a renamed MCP server takes effect without a restart. */
  private readonly serverInfo: { name: string; version: string };

  constructor(private readonly options: HttpEndpointOptions) {
    this.context = { store: options.store, defaultAgentId: undefined };
    this.serverInfo = { ...options.serverInfo };
  }

  /**
   * Brings the endpoint in line with `config`. Never rejects and never blocks
   * the caller: settings changes are fire-and-forget, and start/stop failures
   * are surfaced through `status` instead of thrown.
   *
   * The work is debounced by `SETTLE_MS` and serialised. Both matter while a
   * bind address is typed one character at a time: only the final value is
   * applied (no seven restarts, and no window where a half-typed address like
   * `0.0.` has the endpoint down), and two changes can never interleave their
   * `stop()`/`start()` calls.
   */
  sync(config: HttpEndpointConfig): void {
    if (this.disposed) return;
    this.latest = config;
    this.pending = config;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SETTLE_MS);
  }

  /**
   * Applies any pending change immediately and waits for the queue to drain.
   * Used by `dispose` and by tests; production code has no need to wait.
   */
  async settled(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.flush();
    }
    await this.queue;
  }

  /** Status of the endpoint right now, including a not-yet-applied change. */
  status(): HttpEndpointStatus {
    const config = this.latest;
    const listening = this.server?.listening ?? false;
    return {
      enabled: config?.httpEnabled ?? false,
      listening,
      host: config?.httpHost ?? "127.0.0.1",
      port: config?.httpPort ?? 8787,
      boundHost: listening ? (this.server?.boundHost ?? null) : null,
      boundPort: listening ? (this.server?.boundTcpPort ?? null) : null,
      wildcard: listening ? (this.server?.wildcardBound ?? false) : false,
      bindUrl: this.server?.bindUrl ?? null,
      url: this.server?.url ?? null,
      error: this.error,
    };
  }

  /** Stops the endpoint and refuses further syncs. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.queue;
    await this.stopServer();
    this.bound = null;
  }

  /** Chains the newest pending config onto the serialised queue. */
  private flush(): void {
    const config = this.pending;
    this.pending = null;
    if (config === null) return;
    this.queue = this.queue.then(() => this.run(config));
  }

  private async run(config: HttpEndpointConfig): Promise<void> {
    if (this.disposed) return;
    // Applied before the restart check so a live server picks up the new
    // default agent id without waiting for its host/port to change.
    this.context.defaultAgentId = config.defaultAgentId || undefined;
    if (config.serverName.trim().length > 0) this.serverInfo.name = config.serverName;

    if (!config.httpEnabled) {
      if (this.server) await this.stopServer();
      this.bound = null;
      this.error = null;
      return;
    }

    const changed =
      this.bound === null ||
      this.bound.host !== config.httpHost ||
      this.bound.port !== config.httpPort;
    if (!changed && this.server?.listening) return;

    await this.stopServer();
    this.bound = { host: config.httpHost, port: config.httpPort };
    const server = new McpHttpServer({
      host: config.httpHost,
      port: config.httpPort,
      context: this.context,
      serverInfo: this.serverInfo,
    });
    try {
      await server.start();
      this.server = server;
      this.error = null;
      this.options.log?.(
        `[memory-flash] HTTP MCP endpoint listening on ${server.bindUrl} ` +
          `(dial ${server.url})`,
      );
    } catch (cause) {
      this.server = null;
      this.error = cause instanceof Error ? cause.message : String(cause);
      this.options.logError?.(
        `[memory-flash] HTTP MCP endpoint failed to start on ${config.httpHost}:${config.httpPort}: ${this.error}`,
      );
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    try {
      await server.stop();
    } catch {
      // A socket that refuses to close must not block the next start; the
      // reference is already dropped so no stale server can be reported.
    }
  }
}
