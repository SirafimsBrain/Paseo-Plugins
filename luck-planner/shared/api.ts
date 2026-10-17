import { z } from "zod";
import { goalSchema } from "./goals";
import { growthSchema } from "./growth";
import { beeSchema, bugNodeSchema, bugSchema } from "./links";
import { nodeDetail, stats as statsRpc, treeSearch } from "./rpc";
import { nodeSchema, projectKeySchema, timestampSchema } from "./tree";

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
/** SSE channel: heartbeat today, `tree-changed` once stage H1 wires writes. */
export const DASHBOARD_EVENTS_PATH = "/api/events";

/** Query parameter carrying the per-installation access token. */
export const DASHBOARD_TOKEN_PARAM = "token";
/** Query parameter naming the project (canonical workspace path, ADR-2). */
export const DASHBOARD_PROJECT_PARAM = "project";

/** SSE event sent once when the stream opens. */
export const DASHBOARD_EVENT_READY = "ready";
/** SSE event sent after a mutation (wired in stage H1). */
export const DASHBOARD_EVENT_TREE_CHANGED = "tree-changed";

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
