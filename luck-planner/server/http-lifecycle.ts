import { DEFAULT_HTTP_PORT, generateAccessToken } from "../shared/settings";
import {
  DEFAULT_DASHBOARD_HOST,
  DashboardHttpServer,
  resolveDashboardDir,
  resolvePluginVersion,
} from "./http-server";
import type { LuckPlannerStore } from "./store";

/**
 * Owns the lifetime of the dashboard HTTP server (PLAN.md stage F1) and keeps
 * it in step with the plugin settings (`httpEnabled`, `httpPort`,
 * `accessToken`).
 *
 * Why a class instead of three lines inside `contribute` — the memory-flash
 * 0.5.2 lesson, applied from day one:
 *
 * - **Serialised and debounced.** Settings arrive per keystroke: typing
 *   `8899` emits `8`, `88`, `889`, `8899`, and each one would restart the
 *   listener. A 150 ms quiet period collapses that to one apply, and all work
 *   runs on a promise chain so two overlapping `stop()`/`start()` pairs can
 *   never interleave and leave a stale listener on the old port.
 * - **Truthful status.** The bound port and URL come from the running socket,
 *   not from the settings, so the screen cannot claim a port that failed to
 *   bind.
 * - **A real token.** `accessToken` empty (the default) means *auto*: a random
 *   per-plugin-session token is generated here, so the API is never exposed
 *   with a well-known value; a non-empty setting pins it verbatim.
 * - **Auto-fallback.** A busy configured port falls back to an ephemeral port
 *   (surfaced through `portFallback`) instead of leaving the dashboard down.
 */

/** Subset of the plugin settings the endpoint depends on. */
export interface DashboardEndpointConfig {
  /** `httpEnabled` — turn the whole endpoint off. */
  enabled: boolean;
  /** `httpPort` — `0` asks the OS for an ephemeral port. */
  port: number;
  /** `accessToken` — pinned value, or empty for an auto-generated token. */
  accessToken: string;
}

/** What a status screen renders about the endpoint. */
export interface DashboardEndpointStatus {
  /** Enabled in the settings, regardless of whether the socket came up. */
  enabled: boolean;
  /** A socket is bound right now. */
  listening: boolean;
  /** Bind address (always loopback, ADR-9). */
  host: string;
  /** Configured port. */
  port: number;
  /** Port the live socket is actually bound to; null when not listening. */
  boundPort: number | null;
  /** Browser URL including the token; null when not listening. */
  url: string | null;
  /** The active token (pinned or generated); null when not listening. */
  token: string | null;
  /** Start failure, or null. */
  error: string | null;
  /** True when the configured port was busy and an ephemeral one is used. */
  portFallback: boolean;
}

export interface DashboardEndpointOptions {
  store: LuckPlannerStore;
  /** Reported by `GET /health`; defaults to `package.json`. */
  version?: string;
  /** SPA root; defaults to `dist/dashboard`. */
  dashboardDir?: string;
  /** Bind address override; the loopback constant by default. */
  host?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

/**
 * Quiet period before a settings change is applied: long enough to swallow the
 * intermediate states of a typed port, short enough to feel immediate.
 */
const SETTLE_MS = 150;

export class DashboardEndpoint {
  /** Tail of the serialised work chain; every applied change chains onto it. */
  private queue: Promise<void> = Promise.resolve();
  /** Newest config awaiting application (a newer one replaces it). */
  private pending: DashboardEndpointConfig | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private server: DashboardHttpServer | null = null;
  /** Port + token of the live (or last attempted) server; drives restarts. */
  private bound: { port: number; token: string } | null = null;
  private error: string | null = null;
  private portFallback = false;
  private latest: DashboardEndpointConfig | null = null;
  /** Active token: pinned from settings, or generated once per session. */
  private token = "";
  private disposed = false;

  constructor(private readonly options: DashboardEndpointOptions) {}

  /**
   * Brings the endpoint in line with `config`. Never rejects and never blocks
   * the caller: settings changes are fire-and-forget, and start/stop failures
   * surface through {@link status} instead of being thrown.
   */
  sync(config: DashboardEndpointConfig): void {
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
  status(): DashboardEndpointStatus {
    const config = this.latest;
    const server = this.server;
    const listening = server?.listening ?? false;
    return {
      enabled: config?.enabled ?? false,
      listening,
      host: this.options.host ?? DEFAULT_DASHBOARD_HOST,
      port: config?.port ?? DEFAULT_HTTP_PORT,
      boundPort: listening ? server?.boundTcpPort ?? null : null,
      url: listening ? server?.url ?? null : null,
      token: listening ? this.token : null,
      error: this.error,
      portFallback: listening && this.portFallback,
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

  private async run(config: DashboardEndpointConfig): Promise<void> {
    if (this.disposed) return;

    // Resolve the token before any restart decision: a pinned value wins, and
    // an empty one keeps the auto-generated session token (or mints it now).
    const pinned = config.accessToken.trim();
    if (pinned.length > 0) this.token = pinned;
    else if (this.token.length === 0) this.token = generateAccessToken();

    if (!config.enabled) {
      await this.stopServer();
      this.bound = null;
      this.error = null;
      this.portFallback = false;
      return;
    }

    const unchanged =
      this.bound?.port === config.port &&
      this.bound.token === this.token &&
      (this.server?.listening ?? false);
    if (unchanged) return;

    await this.stopServer();
    this.bound = { port: config.port, token: this.token };
    await this.startServer(config.port);
  }

  /** Starts on `port`, falling back to an ephemeral one when it is busy. */
  private async startServer(port: number): Promise<void> {
    this.server = null;
    this.portFallback = false;

    const attempt = async (targetPort: number): Promise<DashboardHttpServer> => {
      const server = new DashboardHttpServer({
        store: this.options.store,
        host: this.options.host,
        port: targetPort,
        token: this.token,
        version: this.options.version ?? resolvePluginVersion(),
        dashboardDir: this.options.dashboardDir ?? resolveDashboardDir(),
      });
      await server.start();
      return server;
    };

    try {
      this.server = await attempt(port);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (port === 0) {
        this.error = message;
        this.options.logError?.(
          `[luck-planner] dashboard failed to start on ${this.hostLabel()}: ${message}`,
        );
        return;
      }
      this.options.logError?.(
        `[luck-planner] dashboard port ${port} unavailable (${message}); falling back to an ephemeral port`,
      );
      try {
        this.server = await attempt(0);
        this.portFallback = true;
      } catch (retryCause) {
        this.server = null;
        this.error = retryCause instanceof Error ? retryCause.message : String(retryCause);
        this.options.logError?.(
          `[luck-planner] dashboard failed to start on an ephemeral port: ${this.error}`,
        );
        return;
      }
    }

    this.error = null;
    this.options.log?.(`[luck-planner] dashboard listening on ${this.server?.url ?? "(unknown)"}`);
  }

  private hostLabel(): string {
    return `${this.options.host ?? DEFAULT_DASHBOARD_HOST}:${this.latest?.port ?? DEFAULT_HTTP_PORT}`;
  }

  /** Stops the listener; a socket that refuses to close never blocks a start. */
  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    try {
      await server.stop();
    } catch {
      // The reference is already dropped, so no stale server can be reported.
    }
  }
}
