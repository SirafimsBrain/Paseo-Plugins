import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import type { BunnySearchSettings } from "./settings";

/**
 * Shared contracts for the bunny-search plugin: the plugin RPC surface
 * (Paseo UI ↔ plugin server) and the value types shared with tests.
 */

/** Search service ids, mirroring the settings enum. */
export const searchServiceSchema = z.enum([
  "duckduckjs",
  "ddgs",
  "searxng",
  "duckduckgo",
  "brave",
  "custom-json",
  "tavily",
  "exa",
  "kagi",
  "perplexity",
]);

export type SearchService = z.infer<typeof searchServiceSchema>;

/** Human-readable labels for the settings screen dropdown. */
export const SEARCH_SERVICE_LABELS: Record<SearchService, string> = {
  duckduckjs: "DuckDuckJS (multi-engine, no key)",
  ddgs: "DDGS Python (user-installed library)",
  searxng: "SearXNG (self-hosted JSON API)",
  duckduckgo: "DuckDuckGo (HTML, no key)",
  brave: "Brave Search (API key)",
  "custom-json": "Custom JSON endpoint",
  tavily: "Tavily (API key)",
  exa: "Exa (API key, neural search)",
  kagi: "Kagi Search (API key)",
  perplexity: "Perplexity (API key, answer + citations)",
};

/** Services that need an API key before they can answer anything. */
export const API_KEY_SERVICES: readonly SearchService[] = [
  "brave",
  "tavily",
  "exa",
  "kagi",
  "perplexity",
];

/** DuckDuckJS engine ids, mirroring the settings enum. */
export type DuckduckjsEngine = BunnySearchSettings["duckduckjsEngine"];

/** Human-readable labels for the DuckDuckJS engine dropdown. */
export const DUCKDUCKJS_ENGINE_LABELS: Record<DuckduckjsEngine, string> = {
  auto: "Auto (try engines in order)",
  duckduckgo: "DuckDuckGo",
  brave: "Brave",
  google: "Google",
  mojeek: "Mojeek",
  yahoo: "Yahoo",
};

/** One formatted web result, as returned by every provider adapter. */
export interface WebResult {
  title: string;
  url: string;
  content: string;
  /** Engines/sites that produced the result (SearXNG reports them). */
  engines?: string[];
}

/** Normalized search response from a provider adapter. */
export interface SearchResponse {
  query: string;
  results: WebResult[];
  /** Instant answers (SearXNG `answers`, Perplexity answer). */
  answers?: string[];
  /** Did-you-mean suggestion. */
  suggestion?: string;
  /**
   * Served from the in-process response cache instead of a new upstream request
   * (0.7.5). The formatted text marks it, so an agent can tell a fresh answer
   * from a reused one.
   */
  cached?: boolean;
}

/** Request handed to a provider adapter. */
export interface SearchRequest {
  query: string;
  maxResults: number;
  /** SearXNG categories; ignored by providers that don't support them. */
  categories?: string;
  /** Language code; "" means auto-detect. */
  language?: string;
}

/** Runtime view of the settings the MCP server process actually uses. */
export interface RuntimeSettings {
  searchService: BunnySearchSettings["searchService"];
  duckduckjsEngine: BunnySearchSettings["duckduckjsEngine"];
  proxyUrl: string;
  ddgsPythonPath: string;
  searxngBaseUrl: string;
  customBaseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResults: number;
  categories: string;
  language: string;
  /** Seconds an identical search is reused; 0 disables the cache (0.7.5). */
  cacheTtlSeconds: number;
}

/** Result of one connection test (the settings-screen button). */
export const connectionTestResultSchema = z.object({
  /** Overall verdict: the search service answered a real probe request. */
  ok: z.boolean(),
  provider: z.string(),
  /** "ok" when the probe request succeeded, "error" otherwise. */
  status: z.enum(["ok", "error"]),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  /** ISO timestamp of the check. */
  checkedAt: z.string(),
  /** Live MCP handshake check of the bundled server (spawn + initialize). */
  mcp: z
    .object({
      ok: z.boolean(),
      error: z.string().nullable(),
    })
    .nullable(),
});

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;

/**
 * One provisioning decision, as recorded for the status stream (0.7.5).
 *
 * `mcp` — the launch-only MCP server was contributed; `tool` — only the attached
 * `bunny_web_search` tool was; `skipped` — the gates excluded the agent.
 */
export const provisioningEventSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  mode: z.enum(["mcp", "tool", "skipped"]),
  reason: z.string(),
  background: z.boolean(),
  at: z.string(),
});

export type ProvisioningEvent = z.infer<typeof provisioningEventSchema>;

/** Connection status snapshot shown in the settings screen. */
export const connectionStatusSchema = z.object({
  provider: z.string(),
  /** Settings summary without secrets. */
  baseUrl: z.string().nullable(),
  /**
   * Web interface URL of the search service (never a secret),
   * opened with the "Open search interface" action. Null when
   * it cannot be determined.
   */
  uiUrl: z.string().nullable(),
  /** Last probe result kept in plugin memory (null until the first check). */
  lastCheck: connectionTestResultSchema.nullable(),
});

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

// ---------------------------------------------------------------------------
// Plugin RPC surface (Paseo UI ↔ plugin server).
// ---------------------------------------------------------------------------

/**
 * Tests the connection to the configured search service: a real probe
 * request (with the configured timeout) plus a live MCP handshake check
 * of the bundled server. This backs the "Test connection" button.
 */
export const connectionTest = defineRpc({
  name: "bunny-search.connection-test",
  input: z.object({}),
  output: connectionTestResultSchema,
});

/** Connection status snapshot: current provider + last known probe result. */
export const connectionStatus = defineRpc({
  name: "bunny-search.status",
  input: z.object({}),
  output: connectionStatusSchema,
});

/**
 * Reopens the agent's provider session (`agents.ref(id).reload()`), which reruns
 * `addHook("agent.open.before")` and re-contributes the search server/tool. The
 * supported answer to an agent that lost its search tools after an idle runtime
 * release or an OpenCode location eviction, instead of recreating the agent.
 */
export const agentReload = defineRpc({
  name: "bunny-search.agent-reload",
  input: z.object({ agentId: z.string().trim().min(1) }),
  output: z.object({
    ok: z.boolean(),
    /** Set when the reload was refused (unknown agent, busy session, …). */
    error: z.string().nullable(),
  }),
});

/**
 * Live status stream (0.7.5, Paseo 0.16.0 `addSubscription`).
 *
 * The screen no longer needs a manual Test to learn two things that change on
 * their own: the last probe result / configured service, and which agents were
 * provisioned since it opened — including the ones that only got the attached tool.
 * Every event carries the whole current snapshot, so a subscriber that missed an
 * event is still correct after the next one.
 */
export const statusStream = defineSubscription({
  name: "bunny-search.status-stream",
  input: z.object({}),
  event: z.object({
    kind: z.enum(["status", "provisioning"]),
    at: z.string(),
    status: connectionStatusSchema.nullable(),
    /** The event that just happened, null for the initial snapshot. */
    provisioning: provisioningEventSchema.nullable(),
    /** Newest-first ring of recent decisions, at most 20. */
    recent: z.array(provisioningEventSchema),
  }),
});

/** Runs a search through the configured provider (UI-side quick check). */
export const runSearch = defineRpc({
  name: "bunny-search.search",
  input: z.object({
    query: z.string().trim().min(1).max(1000),
    maxResults: z.number().int().min(1).max(30).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    latencyMs: z.number().int().nullable(),
    /** Formatted text, exactly like the MCP tool output. */
    text: z.string().nullable(),
  }),
});
