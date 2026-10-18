import { z } from "zod";
import { goalSchema } from "./goals";
import { growthSchema } from "./growth";
import { beeSchema, bugNodeSchema, bugSchema } from "./links";
import { nodeDetail, stats as statsRpc, treeSearch } from "./rpc";
import {
  historyEntrySchema,
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

/** Query parameter carrying the per-installation access token. */
export const DASHBOARD_TOKEN_PARAM = "token";
/** Query parameter naming the project (canonical workspace path, ADR-2). */
export const DASHBOARD_PROJECT_PARAM = "project";

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
