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
  bugStatusRequestSchema,
  bugStatusResponseSchema,
  goalApproveRequestSchema,
  goalApproveResponseSchema,
  goalStatusRequestSchema,
  goalStatusResponseSchema,
  healthResponseSchema,
  leafStatusResponseSchema,
  nodeResponseSchema,
  searchResponseSchema,
  statsResponseSchema,
  treeResponseSchema,
  DASHBOARD_EVENTS_PATH,
  DASHBOARD_HEALTH_PATH,
  DASHBOARD_NODE_PATH,
  DASHBOARD_PROJECT_PARAM,
  DASHBOARD_SEARCH_PATH,
  DASHBOARD_STATS_PATH,
  DASHBOARD_TOKEN_PARAM,
  DASHBOARD_THEMES_PATH,
  DASHBOARD_TREE_PATH,
  bugStatusPath,
  goalApprovePath,
  goalStatusPath,
  nodeStatusPath,
  themesResponseSchema,
  type BugStatusRequest,
  type BugStatusResponse,
  type GoalApproveRequest,
  type GoalApproveResponse,
  type GoalStatusRequest,
  type GoalStatusResponse,
  type LeafStatusRequest,
  type LeafStatusResponse,
  type NodeResponse,
  type SearchResponse,
  type StatsResponse,
  type ThemeCatalog,
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

/**
 * A write lost a race (stage L8): the row moved to a revision this tab never
 * rendered. Not a failure the user can fix by pressing again — the change is
 * already on disk — so the app refetches instead of reporting an error.
 */
export class DashboardWriteConflict extends Error {
  constructor(
    message: string,
    /** The revision that is current now, when the server named one. */
    readonly currentRevision: number | null,
  ) {
    super(message);
    this.name = "DashboardWriteConflict";
  }
}

/** A typed, transport-free view of the dashboard API. */
export interface DashboardClient {
  tree(): Promise<TreeResponse>;
  node(id: string): Promise<NodeResponse>;
  search(input: DashboardSearchInput): Promise<SearchResponse>;
  stats(): Promise<StatsResponse>;
  themes(): Promise<ThemeCatalog>;
  /** Moves a leaf through its state machine (stage L8). */
  setLeafStatus(
    nodeId: string,
    input: LeafStatusRequest,
  ): Promise<LeafStatusResponse>;
  /** Crosses a goal's approval gate (stage L8). */
  approveGoal(
    goalId: string,
    input: GoalApproveRequest,
  ): Promise<GoalApproveResponse>;
  /** Moves a goal through its lifecycle, short of the gate (0.51.1). */
  setGoalStatus(
    goalId: string,
    input: GoalStatusRequest,
  ): Promise<GoalStatusResponse>;
  /** Moves an incident through its lifecycle (0.51.1). */
  setBugStatus(
    bugId: string,
    input: BugStatusRequest,
  ): Promise<BugStatusResponse>;
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
   * The theme catalog (stage L7). Project-independent — the server answers it
   * before the project parameter is even looked at — but it rides the same
   * `get` path, so the token and the project travel as usual.
   */
  async themes(): Promise<ThemeCatalog> {
    return themesResponseSchema.parse(await this.get(DASHBOARD_THEMES_PATH));
  }

  /**
   * The two writes (stage L8). Both carry the token in the **header** — a URL
   * is a screenshot — and the project in the query string, the way the reads
   * are scoped. A 409 becomes {@link DashboardWriteConflict} so the app can
   * tell "someone else moved it" apart from "the server said no".
   */
  async setLeafStatus(
    nodeId: string,
    input: LeafStatusRequest,
  ): Promise<LeafStatusResponse> {
    return leafStatusResponseSchema.parse(
      await this.post(`${nodeStatusPath(nodeId)}?${this.writeQuery()}`, input),
    );
  }

  async approveGoal(
    goalId: string,
    input: GoalApproveRequest,
  ): Promise<GoalApproveResponse> {
    const body = goalApproveRequestSchema.parse(input);
    return goalApproveResponseSchema.parse(
      await this.post(`${goalApprovePath(goalId)}?${this.writeQuery()}`, body),
    );
  }

  async setGoalStatus(
    goalId: string,
    input: GoalStatusRequest,
  ): Promise<GoalStatusResponse> {
    const body = goalStatusRequestSchema.parse(input);
    return goalStatusResponseSchema.parse(
      await this.post(`${goalStatusPath(goalId)}?${this.writeQuery()}`, body),
    );
  }

  async setBugStatus(
    bugId: string,
    input: BugStatusRequest,
  ): Promise<BugStatusResponse> {
    const body = bugStatusRequestSchema.parse(input);
    return bugStatusResponseSchema.parse(
      await this.post(`${bugStatusPath(bugId)}?${this.writeQuery()}`, body),
    );
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

  /**
   * URL of the SSE channel for this tab (stage H1). Carries the token like
   * every other request — `EventSource` cannot set headers (ADR-8) — and the
   * project, so the server only pushes this project's changes to this stream.
   */
  eventsUrl(): string {
    const query = new URLSearchParams({
      [DASHBOARD_TOKEN_PARAM]: this.token,
      [DASHBOARD_PROJECT_PARAM]: this.projectKey,
    });
    return `${this.origin}${DASHBOARD_EVENTS_PATH}?${query.toString()}`;
  }

  /** `project=…` for a write: the scope of the tab, not a secret. */
  private writeQuery(): string {
    return `${DASHBOARD_PROJECT_PARAM}=${encodeURIComponent(this.projectKey)}`;
  }

  /**
   * One write request. Headers, not the query: the token cannot leak through
   * the address bar, and `Content-Type: application/json` is what the server
   * requires to rule out a form post from another page.
   */
  private async post(pathWithQuery: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl.call(
        globalThis,
        `${this.origin}${pathWithQuery}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    } catch (cause) {
      throw new Error(
        `The plugin server is not reachable at ${this.origin} (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    }
    const text = await response.text();
    const parsed = parseJsonBody(text);
    if (!response.ok) {
      const message =
        parsed !== null && typeof parsed.error === "string"
          ? parsed.error
          : response.status === 401
            ? "The access token was rejected. Re-open the dashboard from Paseo."
            : `The dashboard API answered ${response.status}.`;
      if (response.status === 409) {
        throw new DashboardWriteConflict(
          message,
          parsed !== null && typeof parsed.currentRevision === "number"
            ? parsed.currentRevision
            : null,
        );
      }
      throw new Error(message);
    }
    if (parsed === null) {
      throw new Error(
        `The dashboard API returned a non-JSON body for ${pathWithQuery}.`,
      );
    }
    return parsed;
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

/** The parsed JSON body, or `null` when the body was not JSON at all. */
function parseJsonBody(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
