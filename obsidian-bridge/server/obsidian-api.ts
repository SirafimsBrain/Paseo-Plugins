import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

/**
 * Client for the optional Obsidian Local REST API plugin
 * (`coddingtonbear/obsidian-local-rest-api`).
 *
 * Enrichment is never required for correctness: every method answers with an
 * error instead of throwing, and callers keep the index-only behaviour when the
 * app is closed, the plugin is missing or the key is wrong. Nothing here is
 * called from `agent.open.before`; only an explicit search, status, indexer or
 * panel action touches it.
 *
 * The default endpoint uses the plugin's self-signed certificate, so TLS
 * verification is relaxed **only for loopback hosts**. A remote URL keeps
 * normal certificate validation.
 */

export interface ObsidianApiOptions {
  /** Base URL, e.g. `https://127.0.0.1:27124`. */
  url: string;
  /** Bearer token from Obsidian → Settings → Local REST API. */
  apiKey: string;
  /** Per-request timeout; the app must be running for any call to succeed. */
  timeoutMs?: number;
}

export interface EnrichmentProbe {
  ok: boolean;
  authenticated: boolean;
  /** Plugin/API version reported by `GET /`, when it answers one. */
  version: string | null;
  error: string | null;
}

export interface FuzzyHit {
  path: string;
  /** 0-based position in Obsidian's own ranking (best first). */
  rank: number;
  snippet: string;
}

export interface NoteLinks {
  links: string[];
  backlinks: string[];
  unresolvedLinks: string[];
  tags: string[];
}

export interface VaultEvent {
  /** `create`, `modify`, `delete` or `rename`. */
  type: string;
  path: string | null;
  oldPath: string | null;
}

export interface EventSubscription {
  stop(): void;
}

interface ApiResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 1500;

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function timeoutOf(options: ObsidianApiOptions): number {
  return options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function authHeaders(options: ObsidianApiOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  }
  return headers;
}

function request(
  url: string,
  options: ObsidianApiOptions,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid Obsidian API URL: ${url}`));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error("The Obsidian API URL must be http:// or https://."));
      return;
    }
    const secure = parsed.protocol === "https:";
    const transport = secure ? https : http;
    const requestOptions: https.RequestOptions = {
      method: init.method ?? "GET",
      headers: { ...authHeaders(options), ...init.headers },
      timeout: timeoutOf(options),
      // The Local REST API plugin generates its own CA; trusting loopback
      // self-signed certificates is the documented way to reach it.
      ...(secure ? { rejectUnauthorized: !isLoopback(parsed.hostname) } : {}),
    };
    const req = transport.request(parsed, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        }),
      );
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Obsidian did not answer within ${timeoutOf(options)} ms.`));
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function explain(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/ECONNREFUSED/i.test(message)) {
    return "Obsidian is not listening at this URL (connection refused). Start Obsidian and enable the Local REST API plugin.";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return `The Obsidian API host could not be resolved (${message}).`;
  }
  if (/certificate|self.signed|SELF_SIGNED/i.test(message)) {
    return "The Obsidian API certificate was rejected. Use the loopback HTTPS URL (127.0.0.1) or enable its insecure HTTP server.";
  }
  return message;
}

function versionOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const versions = record.versions;
  if (typeof versions === "string") return versions;
  if (typeof versions === "object" && versions !== null) {
    const entries = Object.values(versions as Record<string, unknown>);
    const flat = entries.find((entry) => typeof entry === "string");
    if (typeof flat === "string") return flat;
  }
  for (const key of ["version", "pluginVersion", "service"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return null;
}

function encodeVaultPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function notePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\/+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Extracts paths from Obsidian's link arrays (strings or `{path}` objects). */
function pathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const path = notePath(entry);
      if (path) paths.push(path);
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      const path = notePath(record.path) ?? notePath(record.link);
      if (path) paths.push(path);
    }
  }
  return paths;
}

export class ObsidianApi {
  constructor(private readonly options: ObsidianApiOptions) {}

  get baseUrl(): string {
    return this.options.url.replace(/\/+$/, "");
  }

  /** `GET /`: reachability and authentication, the cheapest probe. */
  async probe(): Promise<EnrichmentProbe> {
    try {
      const response = await request(`${this.baseUrl}/`, this.options);
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          authenticated: false,
          version: null,
          error:
            "The Local REST API key was rejected. Copy it from Obsidian → Settings → Local REST API with MCP.",
        };
      }
      if (response.status !== 200) {
        return {
          ok: false,
          authenticated: false,
          version: null,
          error: `Obsidian answered HTTP ${response.status} on GET /.`,
        };
      }
      const data = parseJson(response.body);
      const authenticated =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>).authenticated !== false
          : true;
      return {
        ok: authenticated,
        authenticated,
        version: versionOf(data),
        error: authenticated ? null : "The Local REST API answered without authentication.",
      };
    } catch (cause) {
      return { ok: false, authenticated: false, version: null, error: explain(cause) };
    }
  }

  /** Obsidian's own fuzzy search, as an extra (lower-weighted) RRF signal. */
  async simpleSearch(
    query: string,
    limit = 20,
  ): Promise<{ hits: FuzzyHit[]; error: string | null }> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { hits: [], error: null };
    const capped = Math.max(1, Math.min(50, Math.trunc(limit)));
    const url = `${this.baseUrl}/search/simple/?query=${encodeURIComponent(trimmed)}&maxResults=${capped}`;
    try {
      const response = await request(url, this.options, { method: "POST" });
      if (response.status === 401 || response.status === 403) {
        return { hits: [], error: "The Local REST API key was rejected (HTTP 401)." };
      }
      if (response.status !== 200) {
        return { hits: [], error: `Obsidian search answered HTTP ${response.status}.` };
      }
      const data = parseJson(response.body);
      if (!Array.isArray(data)) {
        return { hits: [], error: "Obsidian search returned an unexpected response." };
      }
      const hits: FuzzyHit[] = [];
      const seen = new Set<string>();
      data.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null) return;
        const record = entry as Record<string, unknown>;
        const path = notePath(record.filename) ?? notePath(record.path);
        if (!path || seen.has(path)) return;
        seen.add(path);
        const matches = Array.isArray(record.matches) ? record.matches : [];
        const first = matches.find(
          (match): match is Record<string, unknown> =>
            typeof match === "object" && match !== null && typeof match.context === "string",
        );
        const snippet =
          typeof first?.context === "string"
            ? first.context.replace(/\s+/g, " ").trim().slice(0, 400)
            : "";
        hits.push({ path, rank: index, snippet });
      });
      return { hits, error: null };
    } catch (cause) {
      return { hits: [], error: explain(cause) };
    }
  }

  /** `POST /open/{path}`: bring a note to the foreground in Obsidian. */
  async openNote(path: string): Promise<{ ok: boolean; error: string | null }> {
    const rel = notePath(path);
    if (!rel) return { ok: false, error: "A note path is required." };
    try {
      const response = await request(`${this.baseUrl}/open/${encodeVaultPath(rel)}`, this.options, {
        method: "POST",
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "The Local REST API key was rejected (HTTP 401)." };
      }
      if (response.status === 404) {
        return { ok: false, error: `Obsidian does not know the note '${rel}'.` };
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: `Obsidian answered HTTP ${response.status} while opening the note.` };
      }
      return { ok: true, error: null };
    } catch (cause) {
      return { ok: false, error: explain(cause) };
    }
  }

  /** Note JSON from Obsidian's metadata cache: authoritative links/backlinks. */
  async noteLinks(path: string): Promise<{ links: NoteLinks | null; error: string | null }> {
    const rel = notePath(path);
    if (!rel) return { links: null, error: "A note path is required." };
    try {
      const response = await request(
        `${this.baseUrl}/vault/${encodeVaultPath(rel)}`,
        this.options,
        { headers: { Accept: "application/vnd.olrapi.note+json" } },
      );
      if (response.status === 401 || response.status === 403) {
        return { links: null, error: "The Local REST API key was rejected (HTTP 401)." };
      }
      if (response.status !== 200) {
        return { links: null, error: `Obsidian answered HTTP ${response.status} for note metadata.` };
      }
      const data = parseJson(response.body);
      if (typeof data !== "object" || data === null) {
        return { links: null, error: "Obsidian returned an unexpected note document." };
      }
      const record = data as Record<string, unknown>;
      return {
        links: {
          links: pathList(record.links),
          backlinks: pathList(record.backlinks),
          unresolvedLinks: pathList(record.unresolvedLinks),
          tags: Array.isArray(record.tags)
            ? record.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
        },
        error: null,
      };
    } catch (cause) {
      return { links: null, error: explain(cause) };
    }
  }

  /**
   * Subscribes to Obsidian's vault events. Each stream is registered with
   * `POST /events/vault/{event}/`, then followed as SSE; a dropped stream is
   * re-registered with backoff. Failures are reported, never thrown: the
   * filesystem watcher remains the primary mechanism.
   */
  async subscribeEvents(
    handler: (event: VaultEvent) => void,
    events: Array<"create" | "modify" | "delete" | "rename"> = [
      "create",
      "modify",
      "delete",
      "rename",
    ],
  ): Promise<{ subscription: EventSubscription | null; error: string | null }> {
    let stopped = false;
    const active = new Set<http.ClientRequest>();
    const timers = new Set<NodeJS.Timeout>();
    let firstError: string | null = null;

    const stop = () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const req of active) req.destroy();
      active.clear();
    };

    const follow = (streamUrl: string, type: string): void => {
      if (stopped) return;
      let parsed: URL;
      try {
        parsed = new URL(streamUrl);
      } catch {
        firstError = firstError ?? "Obsidian returned an invalid event stream URL.";
        return;
      }
      const secure = parsed.protocol === "https:";
      const transport = secure ? https : http;
      const req = transport.get(
        parsed,
        {
          headers: { ...authHeaders(this.options), Accept: "text/event-stream" },
          timeout: 0,
          ...(secure ? { rejectUnauthorized: !isLoopback(parsed.hostname) } : {}),
        },
        (res) => {
          if (res.statusCode !== 200) {
            firstError = firstError ?? `Event stream answered HTTP ${res.statusCode}.`;
            res.resume();
            res.on("end", () => scheduleReconnect(type));
            return;
          }
          res.setEncoding("utf-8");
          let buffer = "";
          res.on("data", (chunk: string) => {
            buffer += chunk;
            let separator: number;
            while ((separator = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              const data = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
              if (data.length === 0) continue;
              const payload = parseJson(data);
              if (typeof payload !== "object" || payload === null) continue;
              const record = payload as Record<string, unknown>;
              const file =
                typeof record.file === "object" && record.file !== null
                  ? (record.file as Record<string, unknown>)
                  : null;
              handler({
                type,
                path: notePath(record.path) ?? notePath(file?.path),
                oldPath: notePath(record.oldPath),
              });
            }
          });
          res.on("end", () => scheduleReconnect(type));
          res.on("error", () => scheduleReconnect(type));
        },
      );
      active.add(req);
      req.on("error", () => {
        active.delete(req);
        scheduleReconnect(type);
      });
      req.on("close", () => {
        active.delete(req);
      });
    };

    const scheduleReconnect = (type: string): void => {
      if (stopped) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void register(type);
      }, 5000);
      timer.unref?.();
      timers.add(timer);
    };

    const register = async (type: string): Promise<void> => {
      if (stopped) return;
      try {
        const response = await request(`${this.baseUrl}/events/vault/${type}/`, this.options, {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.olrapi.jsonlogic+json",
            Accept: "application/json",
          },
          body: "{}",
        });
        if (response.status < 200 || response.status >= 300) {
          firstError =
            firstError ??
            `Obsidian refused the '${type}' event subscription (HTTP ${response.status}).`;
          scheduleReconnect(type);
          return;
        }
        const data = parseJson(response.body);
        const streamUrl =
          typeof data === "object" && data !== null
            ? (data as Record<string, unknown>).url
            : null;
        if (typeof streamUrl !== "string" || streamUrl.length === 0) {
          firstError = firstError ?? "Obsidian did not return an event stream URL.";
          scheduleReconnect(type);
          return;
        }
        follow(streamUrl, type);
      } catch (cause) {
        firstError = firstError ?? explain(cause);
        scheduleReconnect(type);
      }
    };

    for (const type of events) {
      await register(type);
    }
    if (stopped) return { subscription: null, error: firstError };
    return { subscription: { stop }, error: firstError };
  }
}

/** Builds a client from runtime settings, or `null` when enrichment is off. */
export function createObsidianApi(options: {
  obsidianApiEnabled: boolean;
  obsidianApiUrl: string;
  obsidianApiKey: string;
}): ObsidianApi | null {
  if (!options.obsidianApiEnabled) return null;
  const url = options.obsidianApiUrl.trim();
  if (url.length === 0) return null;
  return new ObsidianApi({ url, apiKey: options.obsidianApiKey });
}
