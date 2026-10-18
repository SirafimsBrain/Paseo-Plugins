/**
 * Browser-side client of the dashboard HTTP API (PLAN.md stage G1, built on
 * the F1 contracts in `shared/api.ts`).
 *
 * One class, one origin, one token: every request carries the per-installation
 * token as `?token=` (the same way the tab was opened, ADR-8) and scopes reads
 * to the project key resolved from the URL. Responses are parsed with the
 * **shared** zod schemas — the same objects the server validates with and the
 * native panel uses — so a shape drift breaks the dashboard at the first line
 * that touches the data, with a readable zod error, instead of deep in a
 * layout function.
 *
 * Failures surface as thrown `Error`s with a short human message; the app
 * renders them in the toolbar status line.
 */
import {
  healthResponseSchema,
  nodeResponseSchema,
  searchResponseSchema,
  statsResponseSchema,
  treeResponseSchema,
  DASHBOARD_HEALTH_PATH,
  DASHBOARD_NODE_PATH,
  DASHBOARD_PROJECT_PARAM,
  DASHBOARD_SEARCH_PATH,
  DASHBOARD_STATS_PATH,
  DASHBOARD_TOKEN_PARAM,
  DASHBOARD_TREE_PATH,
  type NodeResponse,
  type SearchResponse,
  type StatsResponse,
  type TreeResponse,
} from "../../shared/api";

/** Input of {@link DashboardApi.search}; all filters optional (FTS query). */
export interface DashboardSearchInput {
  readonly q: string;
  readonly kind?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly includeArchived?: boolean;
}

/** A typed, transport-free view of the read-only dashboard API. */
export interface DashboardClient {
  tree(): Promise<TreeResponse>;
  node(id: string): Promise<NodeResponse>;
  search(input: DashboardSearchInput): Promise<SearchResponse>;
  stats(): Promise<StatsResponse>;
}

/**
 * `fetch`-based implementation. Constructed once by the app from the URL
 * parameters; no global state, so a test can point it at a real loopback
 * server (the way `tests/http-server.test.ts` already drives the server).
 *
 * The implementation is always invoked with **`globalThis` as the receiver**
 * (`fetchImpl.call(globalThis, …)`): a browser's `window.fetch` throws
 * `TypeError: Illegal invocation` when called as a method of any other
 * object, and `this.fetchImpl(url)` would hand it the client instance. That
 * mistake is invisible in Node (its fetch ignores the receiver), which is
 * exactly why it survived until the first real tab — pinned by the
 * "global receiver" test in `tests/dashboard-build.test.ts`.
 */
export class DashboardApi implements DashboardClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly projectKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async tree(): Promise<TreeResponse> {
    return treeResponseSchema.parse(await this.get(DASHBOARD_TREE_PATH));
  }

  async node(id: string): Promise<NodeResponse> {
    const suffix = `/${encodeURIComponent(id)}`;
    return nodeResponseSchema.parse(await this.get(`${DASHBOARD_NODE_PATH}${suffix}`));
  }

  async search(input: DashboardSearchInput): Promise<SearchResponse> {
    const query = new URLSearchParams({ q: input.q });
    if (input.kind !== undefined) query.set("kind", input.kind);
    if (input.status !== undefined) query.set("status", input.status);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.includeArchived !== undefined) {
      query.set("includeArchived", String(input.includeArchived));
    }
    return searchResponseSchema.parse(
      await this.get(`${DASHBOARD_SEARCH_PATH}?${query.toString()}`),
    );
  }

  async stats(): Promise<StatsResponse> {
    return statsResponseSchema.parse(await this.get(DASHBOARD_STATS_PATH));
  }

  /**
   * Liveness probe without the token (`/health` is public, ADR-9). Used by the
   * app to detect a stale tab whose server has been restarted on another port.
   */
  async health(): Promise<{ version: string }> {
    const body = healthResponseSchema.parse(
      await this.raw(`${DASHBOARD_HEALTH_PATH}?cacheBust=${Date.now()}`),
    );
    return { version: body.version };
  }

  private async get(pathWithQuery: string): Promise<unknown> {
    const sep = pathWithQuery.includes("?") ? "&" : "?";
    return this.raw(
      `${pathWithQuery}${sep}${DASHBOARD_TOKEN_PARAM}=${encodeURIComponent(this.token)}&${DASHBOARD_PROJECT_PARAM}=${encodeURIComponent(this.projectKey)}`,
    );
  }

  private async raw(pathWithQuery: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl.call(
        globalThis,
        `${this.origin}${pathWithQuery}`,
      );
    } catch (cause) {
      throw new Error(
        `The plugin server is not reachable at ${this.origin} (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "The access token was rejected. Re-open the dashboard from Paseo."
          : `The dashboard API answered ${response.status} for ${pathWithQuery}.`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`The dashboard API returned a non-JSON body for ${pathWithQuery}.`);
    }
  }
}

/**
 * Origin of the dashboard API for a tab opened with `?token=…`: the tab's own
 * origin, because the SPA is served by the very same loopback socket that
 * answers `/api/*`. Falls back to the plugin's default loopback origin so a
 * file:// or test render still names a sane base.
 */
export function resolveApiOrigin(locationHref: string): string {
  try {
    const url = new URL(locationHref);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.origin;
    }
  } catch {
    // Not an absolute URL (unit tests, odd embeds): fall through.
  }
  return "http://127.0.0.1:8899";
}
