import { z } from "zod";
import { goalSchema } from "./goals";
import { growthSchema } from "./growth";
import { beeSchema, bugNodeSchema, bugSchema } from "./links";
import { nodeDetail, stats as statsRpc, treeSearch } from "./rpc";
import { themeCatalogSchema } from "./themes";
import {
  historyEntrySchema,
  idSchema,
  leafStatusSchema,
  nodeSchema,
  projectKeySchema,
  timestampSchema,
  type HistoryEntry,
} from "./tree";

/**
 * Read-only dashboard HTTP API (PLAN.md stage F1, `__doc.md` §6).
 *
 * The 2D/3D dashboards are a separate web app (ADR-1) built by a later stage
 * and *served* by the plugin's loopback HTTP server. These contracts are the
 * JSON it consumes; they are client/server neutral like every `shared/`
 * module (no Node, no React, no DOM).
 *
 * Two of the endpoint shapes deliberately **reuse the plugin RPC output
 * schemas** (`nodeDetail`, `treeSearch`, `stats`): the HTTP API and the native
 * panel must answer with one shape, so the HTTP suite validates every response
 * against the very schema the panel validates. Only the composite
 * `/api/tree` graph is new here — it is the "one query, full graph" response
 * the layout (G2/I2) needs, so the dashboard never walks the tree itself.
 */

/** Unauthenticated liveness probe (ADR-9). */
export const DASHBOARD_HEALTH_PATH = "/health";
/** Nodes + bees + bugs + goals + growth in one graph-ready response. */
export const DASHBOARD_TREE_PATH = "/api/tree";
/** One node with its path, children, links, history and growth. */
export const DASHBOARD_NODE_PATH = "/api/node";
/** FTS5 search within one project. */
export const DASHBOARD_SEARCH_PATH = "/api/search";
/** Panel counters (the toolbar figures). */
export const DASHBOARD_STATS_PATH = "/api/stats";
/** SSE channel: `ready` + `tree-changed` per poll (stage H1). */
export const DASHBOARD_EVENTS_PATH = "/api/events";
/** The project as a portable `.json.zip` (stage L2) — a download, not JSON. */
export const DASHBOARD_EXPORT_PATH = "/api/export";
/**
 * The theme catalog (stage L7): the shipped palettes plus the ones a person
 * put in the plugin's `themes/` directory. Project-independent on purpose — a
 * theme belongs to the tab, not to a workspace.
 */
export const DASHBOARD_THEMES_PATH = "/api/themes";

/**
 * `POST /api/node/:id/status` — move a leaf through its state machine (L8).
 *
 * The first write path the dashboard has. It is deliberately **not** a generic
 * "patch a node": the browser gets exactly the two decisions a person makes
 * while reading the diagram — the status of a leaf and the approval of a goal
 * — and nothing else that the MCP tools can do.
 */
export function nodeStatusPath(nodeId: string): string {
  return `${DASHBOARD_NODE_PATH}/${encodeURIComponent(nodeId)}/status`;
}

/** `POST /api/goal/:id/approve` — cross the approval gate (L8). */
export function goalApprovePath(goalId: string): string {
  return `/api/goal/${encodeURIComponent(goalId)}/approve`;
}

/** `POST /api/goal` route prefix (the id follows it). */
export const DASHBOARD_GOAL_PATH = "/api/goal";

/** Query parameter carrying the per-installation access token. */
export const DASHBOARD_TOKEN_PARAM = "token";
/** `/api/export?history=0` drops the audit trail from the archive. */
export const DASHBOARD_EXPORT_HISTORY_PARAM = "history";
/** Query parameter naming the project (canonical workspace path, ADR-2). */
export const DASHBOARD_PROJECT_PARAM = "project";
/**
 * Appearance hint the plugin derives from Paseo's own colours (stage L7), so a
 * tab opened from a light host starts light instead of guessing from the OS.
 */
export const DASHBOARD_APPEARANCE_PARAM = "appearance";

/**
 * Builds the browser URL the dashboard is opened with (stage F2).
 *
 * The token travels in the query string because a browser tab cannot attach an
 * `Authorization` header to its very first navigation (ADR-8), and `projectKey`
 * travels with it so a tab opened from a *different* workspace shows that
 * workspace instead of reusing whatever the first tab was pointed at. `origin`
 * is `http://127.0.0.1:<port>` of the live socket — never the configured port,
 * which may have fallen back to an ephemeral one. A missing/empty `projectKey`
 * yields the bare dashboard URL (the SPA then asks which project to show).
 */
export function dashboardUrl(
  origin: string,
  token: string,
  projectKey?: string,
): string {
  const params = new URLSearchParams();
  params.set(DASHBOARD_TOKEN_PARAM, token);
  if (projectKey !== undefined && projectKey.length > 0) {
    params.set(DASHBOARD_PROJECT_PARAM, projectKey);
  }
  return `${origin.replace(/\/+$/, "")}/?${params.toString()}`;
}

/**
 * `GET /api/themes` — the catalog, parsed by the tab.
 *
 * Relative like {@link exportUrl}: the tab that got the HTML is the server to
 * ask. The token rides in the query string for the same reason it does in
 * {@link dashboardUrl}.
 */
export function themesUrl(token: string): string {
  const params = new URLSearchParams();
  params.set(DASHBOARD_TOKEN_PARAM, token);
  return `${DASHBOARD_THEMES_PATH}?${params.toString()}`;
}

/**
 * Appends the appearance hint to an already-built dashboard URL (stage L7).
 *
 * The address is built by the server (`dashboardUrl`) and handed to the opener
 * by the `dashboard-status` RPC, which knows nothing about the client's colours
 * — so the hint is added here, where the host theme is in hand. A `null` hint
 * leaves the URL untouched: the tab then follows the OS preference, exactly as
 * it did before this stage.
 */
export function withAppearance(
  url: string,
  appearance: string | null,
): string {
  if (appearance !== "light" && appearance !== "dark") return url;
  const parsed = new URL(url);
  parsed.searchParams.set(DASHBOARD_APPEARANCE_PARAM, appearance);
  return parsed.toString();
}

/**
 * Relative download URL of one project's export (stage L2).
 *
 * Relative on purpose: the toolbar renders it as a plain `<a download>`, and
 * a tab opened from any origin (loopback today, a tunnel tomorrow) downloads
 * from the server that served it. The token rides in the query string for the
 * same reason it does in {@link dashboardUrl} — a navigation cannot carry an
 * `Authorization` header — and the endpoint is read-only, so a token that
 * already sits in this tab's URL gains nothing new by appearing in an href.
 *
 * An empty `projectKey` still names the endpoint (the server answers 400):
 * the toolbar only builds this URL when it has a project, and a disabled
 * button is clearer than a link that guesses.
 */
export function exportUrl(
  token: string,
  projectKey: string,
  includeHistory = true,
): string {
  const params = new URLSearchParams();
  params.set(DASHBOARD_TOKEN_PARAM, token);
  params.set(DASHBOARD_PROJECT_PARAM, projectKey);
  if (!includeHistory) params.set(DASHBOARD_EXPORT_HISTORY_PARAM, "0");
  return `${DASHBOARD_EXPORT_PATH}?${params.toString()}`;
}

/** SSE event sent once when the stream opens. */
export const DASHBOARD_EVENT_READY = "ready";
/** SSE event sent after a mutation (wired in stage H1). */
export const DASHBOARD_EVENT_TREE_CHANGED = "tree-changed";

/**
 * Payload of the SSE `ready` event (stage H1): the version answering the
 * stream and the audit watermark it is about to continue from. A reopening
 * tab compares the version with the one it booted with (a plugin update
 * means "reload the page") and uses the watermark as the baseline for the
 * `tree-changed` events that follow.
 */
export const readyEventSchema = z.object({
  version: z.string().min(1),
  watermark: z.number().int().nonnegative(),
});

/**
 * Payload of the SSE `tree-changed` event (stage H1): the audit rows written
 * since the client's watermark, **grouped per project**.
 *
 * One event per project per poll, never one per row: a burst of agent writes
 * (a goal materializing a subtree) costs the dashboard a single refetch, and
 * the row list still tells it *which* entity moved, so an open details panel
 * can refresh just that node. `changes` carries the same
 * {@link historyEntrySchema} rows `/api/node/:id` returns — one shape for
 * "what happened", read live or read from the trail.
 */
export const treeChangedEventSchema = z.object({
  projectKey: projectKeySchema,
  /** Highest audit row id included in this event. */
  watermark: z.number().int().nonnegative(),
  changes: z.array(historyEntrySchema).min(1),
});

export type ReadyEvent = z.infer<typeof readyEventSchema>;
export type TreeChangedEvent = z.infer<typeof treeChangedEventSchema>;

/**
 * Whether a change batch makes a view of `nodeId` stale (stage H1).
 *
 * Both live consumers — the dashboard tab and the native panel — need exactly
 * this decision, so it lives beside the event contract instead of being written
 * twice. A **node** row is matched by id, so an unrelated node moving costs a
 * refetch of nothing; every other entity (bee, bug, goal, growth) is *linked*
 * to nodes rather than being one, so its rows always count: the link sections
 * a node view renders may now be wrong.
 */
export function changesTouchNode(
  changes: ReadonlyArray<Pick<HistoryEntry, "entityId" | "entityType">>,
  nodeId: string,
): boolean {
  return changes.some(
    (change) => change.entityId === nodeId || change.entityType !== "node",
  );
}

/**
 * `GET /health` — public liveness probe. No database details (ADR-9); the
 * version line exists so a stale tab can be told apart from a fresh server.
 */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  server: z.literal("luck-planner"),
  version: z.string().min(1),
});

/**
 * `GET /api/tree?project=` — the whole graph of one project in a single
 * response: nodes (adjacency list), influence bees, incidents and their
 * leaf attachments, high goals and growth records. Read-only; archived
 * nodes are excluded so the graph is "what can be worked on".
 */
export const treeResponseSchema = z.object({
  projectKey: projectKeySchema,
  generatedAt: timestampSchema,
  nodes: z.array(nodeSchema),
  bees: z.array(beeSchema),
  bugs: z.array(bugSchema),
  bugAttachments: z.array(bugNodeSchema),
  goals: z.array(goalSchema),
  growth: z.array(growthSchema),
});

/**
 * Body of the two writes (stage L8). `expectedRevision` is optional, so a
 * script that does not care can write blind — but the dashboard always sends
 * it: it renders one revision and must not overwrite another.
 */
export const leafStatusRequestSchema = z.object({
  status: leafStatusSchema,
  expectedRevision: z.number().int().positive().optional(),
});
export type LeafStatusRequest = z.infer<typeof leafStatusRequestSchema>;

export const goalApproveRequestSchema = z.object({
  /**
   * The branch the goal grows under. Omitted (stage L10) means the server's
   * policy picks the only tree's default branch — and refuses in a forest,
   * where guessing would put the plan in the wrong tree.
   */
  parentBranchId: idSchema.nullable().optional(),
  expectedRevision: z.number().int().positive().optional(),
});
export type GoalApproveRequest = z.infer<typeof goalApproveRequestSchema>;

/** `POST /api/node/:id/status` answer: the node after the move. */
export const leafStatusResponseSchema = z.object({
  ok: z.literal(true),
  node: nodeSchema,
});
export type LeafStatusResponse = z.infer<typeof leafStatusResponseSchema>;

/** `POST /api/goal/:id/approve` answer: the goal after the gate crossing. */
export const goalApproveResponseSchema = z.object({
  ok: z.literal(true),
  goal: goalSchema,
});
export type GoalApproveResponse = z.infer<typeof goalApproveResponseSchema>;

/**
 * A refused write: the message, plus the revision that is current now when the
 * refusal was a stale one (HTTP 409). The tab refetches on a 409 instead of
 * asking the user to try again — the change is already on disk.
 */
export const writeErrorSchema = z.object({
  error: z.string().min(1),
  currentRevision: z.number().int().nonnegative().optional(),
});
export type WriteError = z.infer<typeof writeErrorSchema>;

/**
 * `GET /api/themes` — the theme catalog, in the shared schema the dashboard
 * parses (stage L7). Arbitrary JSON files, so the loader's report about the
 * files it refused travels with it.
 */
export const themesResponseSchema = themeCatalogSchema;
export type { ThemeCatalog, ThemeCatalogEntry } from "./themes";

/** `GET /api/node/:id` — the same shape the `node-detail` RPC returns. */
export const nodeResponseSchema = nodeDetail.output;
/** `GET /api/search` — the same shape the `tree-search` RPC returns. */
export const searchResponseSchema = treeSearch.output;
/** `GET /api/stats` — the same shape the `stats` RPC returns. */
export const statsResponseSchema = statsRpc.output;

/** Every non-200 body is `{ error }` with a deliberately generic message. */
export const errorResponseSchema = z.object({ error: z.string() });

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type TreeResponse = z.infer<typeof treeResponseSchema>;
export type NodeResponse = z.infer<typeof nodeResponseSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
