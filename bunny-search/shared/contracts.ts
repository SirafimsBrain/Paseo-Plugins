import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { BunnySearchSettings } from "./settings";

/**
 * Shared contracts for the bunny-search plugin: the plugin RPC surface
 * (Paseo UI ↔ plugin server) and the value types shared with tests.
 */

/** Search service ids, mirroring the settings enum. */
export const searchServiceSchema = z.enum(["searxng", "duckduckgo", "brave", "custom-json"]);

export type SearchService = z.infer<typeof searchServiceSchema>;

/** Human-readable labels for the settings screen dropdown. */
export const SEARCH_SERVICE_LABELS: Record<SearchService, string> = {
  searxng: "SearXNG (self-hosted JSON API)",
  duckduckgo: "DuckDuckGo (HTML, no key)",
  brave: "Brave Search (API key)",
  "custom-json": "Custom JSON endpoint",
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
  /** Instant answers (SearXNG `answers`). */
  answers?: string[];
  /** Did-you-mean suggestion. */
  suggestion?: string;
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
  searxngBaseUrl: string;
  customBaseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResults: number;
  categories: string;
  language: string;
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
