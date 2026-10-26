import * as crypto from "node:crypto";
import { ConsoleHttpServer, DEFAULT_CONSOLE_HOST } from "./http-server";
import { WebSocketTransport } from "./transport";

export interface ConsoleEndpointConfig {
  enabled: boolean;
  port: number;
  accessToken: string;
}

export interface ConsoleEndpointStatus {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  boundPort: number | null;
  url: string | null;
  token: string | null;
  error: string | null;
  portFallback: boolean;
  transport: "ws" | "sse-post" | null;
  transportConnections: number;
  sseSubscribers: number;
}

export interface ConsoleEndpointOptions {
  host?: string;
  version?: string;
  consoleDir?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  resolveSession?: (id: string) => import("./pty").PtyHandle | null;
  sessions?: import("./sessions").SessionRegistry;
  store?: import("./store").Store;
  vault?: import("./vault").VaultService;
  onServerStarted?: (server: ConsoleHttpServer) => void;
}

const SETTLE_MS = 150;

export class ConsoleEndpoint {
  private queue: Promise<void> = Promise.resolve();
  private pending: ConsoleEndpointConfig | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private server: ConsoleHttpServer | null = null;
  private bound: { port: number; token: string } | null = null;
  private error: string | null = null;
  private portFallback = false;
  private latest: ConsoleEndpointConfig | null = null;
  private token = "";
  private disposed = false;

  constructor(private readonly options: ConsoleEndpointOptions = {}) {}

  sync(config: ConsoleEndpointConfig): void {
    if (this.disposed) return;
    this.latest = config;
    this.pending = config;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SETTLE_MS);
  }

  async settled(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.flush();
    }
    await this.queue;
  }

  status(): ConsoleEndpointStatus {
    const config = this.latest;
    const server = this.server;
    const listening = server?.listening ?? false;
    return {
      enabled: config?.enabled ?? false,
      listening,
      host: this.options.host ?? DEFAULT_CONSOLE_HOST,
      port: config?.port ?? 0,
      boundPort: listening ? server?.boundTcpPort ?? null : null,
      url: listening ? server?.url ?? null : null,
      token: listening ? this.token : null,
      error: this.error,
      portFallback: listening && this.portFallback,
      transport: listening ? "ws" : null,
      transportConnections: listening ? server?.transportConnections ?? 0 : 0,
      sseSubscribers: listening ? server?.sseSubscribers ?? 0 : 0,
    };
  }

  url(): string | null {
    return this.server?.url ?? null;
  }

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

  private flush(): void {
    const config = this.pending;
    this.pending = null;
    if (config === null) return;
    this.queue = this.queue.then(() => this.run(config));
  }

  private async run(config: ConsoleEndpointConfig): Promise<void> {
    if (this.disposed) return;
    const pinned = config.accessToken.trim();
    if (pinned.length > 0) this.token = pinned;
    else if (this.token.length === 0) this.token = `rc_${crypto.randomBytes(16).toString("hex")}`;

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

  private async startServer(port: number): Promise<void> {
    this.server = null;
    this.portFallback = false;
    const attempt = async (targetPort: number): Promise<ConsoleHttpServer> => {
      const transport = new WebSocketTransport({
        token: this.token,
        log: this.options.log,
        resolveSession: this.options.resolveSession,
      });
      try {
        const server = new ConsoleHttpServer({
          host: this.options.host,
          port: targetPort,
          token: this.token,
          version: this.options.version,
          consoleDir: this.options.consoleDir,
          transport,
          sessions: this.options.sessions,
          store: this.options.store,
          vault: this.options.vault,
        });
        await server.start();
        this.options.onServerStarted?.(server);
        return server;
      } catch (cause) {
        transport.dispose();
        throw cause;
      }
    };
    try {
      this.server = await attempt(port);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (port === 0) {
        this.error = message;
        this.options.logError?.(`[remote-control] console failed to start: ${message}`);
        return;
      }
      this.options.logError?.(`[remote-control] console port ${port} unavailable (${message}); falling back`);
      try {
        this.server = await attempt(0);
        this.portFallback = true;
      } catch (retryCause) {
        this.server = null;
        this.error = retryCause instanceof Error ? retryCause.message : String(retryCause);
        this.options.logError?.(`[remote-control] console failed to start on ephemeral port: ${this.error}`);
        return;
      }
    }
    this.error = null;
    this.options.log?.(`[remote-control] console listening on ${this.server?.url ?? "(unknown)"}`);
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    try {
      await server.stop();
    } catch {
      // ignore
    }
  }
}
