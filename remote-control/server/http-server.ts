import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { resolveConsoleDir, resolvePluginVersion } from "./paths";
import type { TerminalService } from "./terminals";
import {
  applyGhosttySettings,
  loadGhosttySettings,
  previewGhosttyImport,
} from "./ghostty-config";
import { bundleHasSecrets, buildExportBundle, importBundle, openBundle } from "./transfer";
import { testSshConnection } from "./probe";
import type { SshProbe } from "./probe";
import { nextCopyName } from "../shared/naming";

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
  /** Workspace terminals: create/list/kill through the Paseo SDK. */
  terminals?: TerminalService;
  /** Store for connection lookups. */
  store?: import("./store").Store;
  /** Vault service: status route + connection-password storage. */
  vault?: import("./vault").VaultService;
  /** Connection test (0.21.10): key-first probe, injectable in tests. */
  sshProbe?: SshProbe;
}

export class ConsoleHttpServer {
  private readonly token: string;
  private readonly host: string;
  private readonly version: string;
  private readonly consoleDir: string;
  private readonly terminals: TerminalService | null;
  private readonly store: import("./store").Store | null;
  private readonly vault: import("./vault").VaultService | null;
  private readonly sshProbe: SshProbe;
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
    this.terminals = options.terminals ?? null;
    this.store = options.store ?? null;
    this.vault = options.vault ?? null;
    this.sshProbe =
      options.sshProbe ?? ((connection, vault) => testSshConnection(connection, { vault }));
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
      this.eventClients.clear();
      if (this.eventTicker !== null) {
        clearInterval(this.eventTicker);
        this.eventTicker = null;
      }
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

      // /api/state
      if (url.pathname === "/api/state") {
        if (req.method !== "GET") { this.sendJson(res, 405, { error: "method not allowed" }); return; }
        this.sendJson(res, 200, { ok: true, listening: true });
        return;
      }
      // /api/events (SSE)
      if (url.pathname === "/api/events") {
        if (req.method !== "GET") { this.sendJson(res, 405, { error: "method not allowed" }); return; }
        this.serveEvents(req, res);
        return;
      }
      // /api/vault/*
      if (url.pathname === "/api/vault/status") {
        if (req.method !== "GET") { this.sendJson(res, 405, { error: "method not allowed" }); return; }
        if (!this.vault) { this.sendJson(res, 503, { error: "vault unavailable" }); return; }
        this.sendJson(res, 200, this.vault.status());
        return;
      }
      // Vault setup/unlock/lock and the raw /api/secrets routes are gone by
      // design (0.19.10): initialization and unlock happen once, in the
      // Remote Control panel, and secrets exist only inside connections.
      // Only GET /api/vault/status remains, for the Settings screen.
      if (
        url.pathname === "/api/vault/setup" ||
        url.pathname === "/api/vault/unlock" ||
        url.pathname === "/api/vault/lock" ||
        url.pathname.startsWith("/api/secrets")
      ) {
        this.sendJson(res, 404, {
          error: "removed: set up and unlock the storage in the Remote Control panel; secrets are managed only through connections",
        });
        return;
      }
      // /api/terminals — Paseo workspace terminals. Creating one makes the
      // Paseo app open it as a workspace tab; the console never renders it.
      if (url.pathname === "/api/terminals") {
        if (!this.terminals) { this.sendJson(res, 503, { error: "terminals unavailable" }); return; }
        if (req.method === "GET") {
          const workspaceId = url.searchParams.get("workspaceId");
          void this.terminals.list(workspaceId).then((terminals) => {
            this.sendJson(res, 200, { terminals });
          }).catch((cause) => {
            this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
          });
          return;
        }
        if (req.method === "POST") {
          void this.readJsonBody(req).then(async (body) => {
            const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
            const terminal = await this.terminals!.open({
              workspaceId: b.workspaceId ? String(b.workspaceId) : null,
              connectionId: b.connectionId ? String(b.connectionId) : null,
              cwd: b.cwd ? String(b.cwd) : null,
              name: b.name ? String(b.name) : null,
            });
            this.sendJson(res, 201, { terminal });
          }).catch((cause) => {
            this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
          });
          return;
        }
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const terminalKillMatch = /^\/api\/terminals\/(.+)\/kill$/.exec(url.pathname);
      if (terminalKillMatch && this.terminals) {
        if (req.method !== "POST") {
          this.sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const terminalId = decodeURIComponent(terminalKillMatch[1]);
        void this.terminals.kill(terminalId).then((ok) => {
          this.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" });
        }).catch((cause) => {
          this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
        });
        return;
      }
      // /api/groups
      if (url.pathname === "/api/groups") {
        if (!this.store) { this.sendJson(res, 503, { error: "store unavailable" }); return; }
        if (req.method === "GET") {
          this.sendJson(res, 200, { groups: this.store.listGroups() });
          return;
        }
        if (req.method === "POST") {
          void this.readJsonBody(req).then((body) => {
            const name = body && typeof body === "object" && "name" in body ? String((body as { name: unknown }).name) : "";
            const parentId = body && typeof body === "object" && "parentId" in body
              ? ((body as { parentId: unknown }).parentId === null ? null : String((body as { parentId: unknown }).parentId))
              : null;
            const id = `grp_${Math.random().toString(36).slice(2)}`;
            const group = this.store!.createGroup({ id, parentId, name });
            this.sendJson(res, 201, { group });
          }).catch((cause) => {
            this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
          });
          return;
        }
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const groupMatch = /^\/api\/groups\/(.+)$/.exec(url.pathname);
      if (groupMatch && this.store) {
        const id = decodeURIComponent(groupMatch[1]);
        if (req.method === "PATCH") {
          void this.readJsonBody(req).then((body) => {
            const patch: { name?: string; parentId?: string | null } = {};
            if (body && typeof body === "object" && "name" in body) patch.name = String((body as { name: unknown }).name);
            if (body && typeof body === "object" && "parentId" in body) {
              patch.parentId = (body as { parentId: unknown }).parentId === null ? null : String((body as { parentId: unknown }).parentId);
            }
            const group = this.store!.updateGroup(id, patch);
            if (!group) { this.sendJson(res, 404, { error: "not found" }); return; }
            this.sendJson(res, 200, { group });
          }).catch((cause) => {
            this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
          });
          return;
        }
        if (req.method === "DELETE") {
          const ok = this.store.deleteGroup(id);
          this.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" });
          return;
        }
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      // /api/connections
      if (url.pathname === "/api/connections") {
        if (!this.store) { this.sendJson(res, 503, { error: "store unavailable" }); return; }
        if (req.method === "GET") {
          const groupId = url.searchParams.has("groupId") ? url.searchParams.get("groupId") : undefined;
          const resolved = groupId === null ? null : (groupId === undefined ? undefined : groupId);
          this.sendJson(res, 200, { connections: this.store.listConnections(resolved as string | null | undefined) });
          return;
        }
        if (req.method === "POST") {
          void this.readJsonBody(req).then(async (body) => {
            const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
            // `duplicateOf` (0.21.10) copies a connection: fields absent from
            // the body fall back to the source, the stored secrets are
            // re-encrypted under the new id, and an unnamed copy gets the next
            // free `…_copy<n>` name (the console computes it too, so the modal
            // shows it before the user confirms).
            const duplicateOf =
              typeof b.duplicateOf === "string" && b.duplicateOf.length > 0 ? b.duplicateOf : null;
            const source = duplicateOf ? this.store!.getConnection(duplicateOf) : null;
            if (duplicateOf && !source) {
              this.sendJson(res, 404, { error: `source connection not found: ${duplicateOf}` });
              return;
            }
            const name =
              b.name && String(b.name).length > 0
                ? String(b.name)
                : source
                  ? nextCopyName(source.name, this.store!.listConnections().map((c) => c.name))
                  : "";
            const host = b.host ? String(b.host) : (source?.host ?? "");
            const protocol = b.protocol ? String(b.protocol) : (source?.protocol ?? "ssh");
            const groupId = b.groupId
              ? String(b.groupId)
              : b.groupId === null
                ? null
                : (source ? source.groupId : null);
            const port =
              b.port === undefined
                ? (source ? source.port : null)
                : b.port === null
                  ? null
                  : Number(b.port);
            const username = b.username ? String(b.username) : (source?.username ?? "");
            const id = `conn_${Math.random().toString(36).slice(2)}`;
            let secretRefs: Record<string, string> = {
              ...((source?.secretRefs ?? {}) as Record<string, string>),
              ...((b.secretRefs as Record<string, string>) ?? {}),
            };
            const password = typeof b.password === "string" ? b.password : "";
            // Duplicate: copy every stored secret under the new id (a password
            // given in the body replaces the copied one instead).
            if (source && Object.keys(source.secretRefs ?? {}).length > 0) {
              this.requireOpenVault();
              for (const [key, oldName] of Object.entries(source.secretRefs ?? {})) {
                const isPassword = key === "passwordSecret" || key === "password";
                if (isPassword && password.length > 0) {
                  delete secretRefs[key];
                  continue;
                }
                let value: string;
                try {
                  value = await this.vault!.get(oldName);
                } catch (cause) {
                  throw new Error(
                    `cannot copy the ${key} of the source connection: ${cause instanceof Error ? cause.message : String(cause)}`,
                  );
                }
                const prefix = `connections/${source.id}/`;
                const suffix = oldName.startsWith(prefix)
                  ? oldName.slice(prefix.length)
                  : (oldName.split("/").pop() ?? oldName);
                const secretName = `connections/${id}/${suffix}`;
                await this.vault!.set(secretName, value);
                secretRefs[key] = secretName;
              }
            }
            // Storing the password IS the point of the vault: the value goes
            // into the pass store and the database only gets the secret name.
            if (password.length > 0) {
              this.requireOpenVault();
              const secretName = `connections/${id}/password`;
              await this.vault!.set(secretName, password);
              secretRefs = { ...secretRefs, passwordSecret: secretName };
            }
            const conn = this.store!.createConnection({
              id, groupId, name, protocol, host, port, username,
              payload:
                (b.payload as Record<string, unknown>) ??
                (source ? { ...source.payload } : {}),
              secretRefs,
            });
            this.sendJson(res, 201, { connection: conn });
          }).catch((cause) => {
            this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
          });
          return;
        }
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      // /api/connections/:id/test — probe the host (0.21.10): public key
      // first (BatchMode), then the stored password; success records
      // payload.auth ("key"/"password"), a failure leaves the flag as it is.
      const connectionTestMatch = /^\/api\/connections\/(.+)\/test$/.exec(url.pathname);
      if (connectionTestMatch && this.store) {
        if (req.method !== "POST") { this.sendJson(res, 405, { error: "method not allowed" }); return; }
        const testId = decodeURIComponent(connectionTestMatch[1]);
        const testConn = this.store.getConnection(testId);
        if (!testConn) { this.sendJson(res, 404, { error: "not found" }); return; }
        if (testConn.protocol !== "ssh") {
          this.sendJson(res, 400, { error: "the connection test supports ssh only" });
          return;
        }
        void this.sshProbe(testConn, this.vault ?? null).then((result) => {
          let connection = testConn;
          if (result.ok && (result.auth === "key" || result.auth === "password")) {
            const payload = { ...(testConn.payload ?? {}) };
            payload.auth = result.auth;
            connection = this.store!.updateConnection(testId, { payload }) ?? testConn;
          }
          this.sendJson(res, 200, {
            ok: result.ok,
            auth: result.auth,
            message: result.message,
            connection,
          });
        }).catch((cause) => {
          this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
        });
        return;
      }
      const connectionMatch = /^\/api\/connections\/(.+)$/.exec(url.pathname);
      if (connectionMatch && this.store) {
        const id = decodeURIComponent(connectionMatch[1]);
        if (req.method === "GET") {
          const conn = this.store.getConnection(id);
          if (!conn) { this.sendJson(res, 404, { error: "not found" }); return; }
          this.sendJson(res, 200, { connection: conn });
          return;
        }
        if (req.method === "PATCH") {
          void this.readJsonBody(req).then(async (body) => {
            const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
            const existing = this.store!.getConnection(id);
            if (!existing) { this.sendJson(res, 404, { error: "not found" }); return; }
            const patch: { groupId?: string | null; name?: string; protocol?: string; host?: string; port?: number | null; username?: string; payload?: Record<string, unknown>; secretRefs?: Record<string, string> } = {};
            if ("groupId" in b) patch.groupId = b.groupId === null ? null : String(b.groupId);
            if ("name" in b) patch.name = String(b.name);
            if ("protocol" in b) patch.protocol = String(b.protocol);
            if ("host" in b) patch.host = String(b.host);
            if ("port" in b) patch.port = b.port === null ? null : Number(b.port);
            if ("username" in b) patch.username = String(b.username);
            if ("payload" in b) patch.payload = b.payload as Record<string, unknown>;
            if ("secretRefs" in b) patch.secretRefs = b.secretRefs as Record<string, string>;
            // A changed target invalidates the recorded auth method (0.21.10):
            // back to "unknown" until the next successful test. An explicit
            // payload in the patch wins.
            if (!("payload" in b)) {
              const targetChanged =
                ("host" in b && String(b.host) !== existing.host) ||
                ("port" in b && (b.port === null || b.port === undefined ? null : Number(b.port)) !== existing.port) ||
                ("username" in b && String(b.username ?? "") !== existing.username) ||
                ("protocol" in b && String(b.protocol) !== existing.protocol);
              if (targetChanged && existing.payload && existing.payload.auth !== undefined) {
                const payload = { ...existing.payload };
                delete payload.auth;
                patch.payload = payload;
              }
            }
            // Password edits: a non-empty value stores/updates the secret, an
            // empty one clears it, an absent field leaves it untouched.
            if ("password" in b) {
              const refs = existing.secretRefs ?? {};
              const value = b.password === null || b.password === undefined ? "" : String(b.password);
              if (value.length > 0) {
                this.requireOpenVault();
                const secretName = refs.passwordSecret ?? refs.password ?? `connections/${id}/password`;
                await this.vault!.set(secretName, value);
                const next: Record<string, string> = {};
                for (const [key, entryValue] of Object.entries(refs)) {
                  if (key !== "password") next[key] = entryValue;
                }
                next.passwordSecret = secretName;
                patch.secretRefs = next;
              } else {
                const secretName = refs.passwordSecret ?? refs.password;
                if (secretName && this.vault) {
                  try { await this.vault.delete(secretName); } catch { /* already gone */ }
                }
                const next: Record<string, string> = {};
                for (const [key, entryValue] of Object.entries(refs)) {
                  if (key !== "password" && key !== "passwordSecret") next[key] = entryValue;
                }
                patch.secretRefs = next;
              }
            }
            const conn = this.store!.updateConnection(id, patch);
            if (!conn) { this.sendJson(res, 404, { error: "not found" }); return; }
            this.sendJson(res, 200, { connection: conn });
          }).catch((cause) => {
            this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
          });
          return;
        }
        if (req.method === "DELETE") {
          const ok = this.store.deleteConnection(id);
          this.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" });
          return;
        }
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      // /api/export — full copy of groups + connections + their secrets
      // (0.20.10): one JSON file, optionally sealed with a passphrase,
      // importable on another machine (sshpilot-style backup).
      if (url.pathname === "/api/export") {
        if (req.method !== "POST") { this.sendJson(res, 405, { error: "method not allowed" }); return; }
        if (!this.store) { this.sendJson(res, 503, { error: "store unavailable" }); return; }
        void this.readJsonBody(req).then(async (body) => {
          const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
          const result = await buildExportBundle(this.store!, this.vault, {
            passphrase: typeof b.passphrase === "string" ? b.passphrase : "",
            pluginVersion: this.version,
          });
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${result.filename}"`,
            "Cache-Control": "no-store",
          });
          res.end(result.content);
        }).catch((cause) => {
          this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
        });
        return;
      }
      // /api/import — restore a bundle; mode "merge" (default) keeps what is
      // there and updates matching connections, "replace" wipes first.
      if (url.pathname === "/api/import") {
        if (req.method !== "POST") { this.sendJson(res, 405, { error: "method not allowed" }); return; }
        if (!this.store) { this.sendJson(res, 503, { error: "store unavailable" }); return; }
        void this.readJsonBody(req).then(async (body) => {
          const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
          const file = typeof b.file === "string" ? b.file : "";
          const mode = b.mode === "replace" ? ("replace" as const) : ("merge" as const);
          const bundle = openBundle(file, typeof b.passphrase === "string" ? b.passphrase : undefined);
          if (bundleHasSecrets(bundle)) this.requireOpenVault();
          const report = await importBundle(this.store!, this.vault, bundle, { mode });
          this.sendJson(res, 200, { ok: true, ...report });
        }).catch((cause) => {
          this.sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
        });
        return;
      }
      // /api/ghostty/import
      if (url.pathname === "/api/ghostty/import") {
        if (req.method === "GET") {
          this.sendJson(res, 200, previewGhosttyImport());
          return;
        }
        if (req.method === "POST") {
          void this.readJsonBody(req).then((body) => {
            const settings = (body && typeof body === "object" && "settings" in body)
              ? (body as { settings: unknown }).settings
              : body;
            applyGhosttySettings(settings as never);
            this.sendJson(res, 200, { ok: true, settings: loadGhosttySettings() });
          }).catch((cause) => {
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

  /**
   * Connection passwords can only be stored in an open storage (0.19.10):
   * setup and unlock happen once, in the Remote Control panel, so by the time
   * a password arrives here the vault must already be unlocked. Throws a
   * user-readable message pointing at the panel when it is not.
   */
  private requireOpenVault(): void {
    if (!this.vault) throw new Error("vault unavailable");
    const status = this.vault.status();
    if (!status.initialized) {
      throw new Error(
        "secret storage is not initialized: open the Remote Control panel and create the master password first",
      );
    }
    if (!status.unlocked) {
      throw new Error("vault is locked: unlock it with the master password in the Remote Control panel");
    }
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
