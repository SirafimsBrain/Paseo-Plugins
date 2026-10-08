import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

/**
 * Plugin settings (host-scoped, edited in Paseo Settings → Plugins →
 * Bunny Search).
 *
 * The same values are read by the spawned MCP server process from the
 * host-written `settings.json` (`server/settings-file.ts`), so the UI and
 * every agent see one configuration.
 */
export const bunnySearchSettings = defineSettings({
  id: "bunny-search",
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * Inject the bunny-search MCP server into every agent created through
     * Paseo (via the `agent.create` before-hook).
     */
    injectIntoAgents: z.boolean().default(true),
    /** Server name reported in the MCP `initialize` result. */
    mcpServerName: z.string().trim().min(1).max(60).default("bunny-search"),
    /**
     * Search service used by the MCP tools. "duckduckjs" (the default)
     * is the DuckDuckJS meta-search library (DuckDuckGo, Brave, Google,
     * Mojeek, Yahoo — no API key); "ddgs" runs the user-installed
     * PyPI `ddgs` library in a Python subprocess (availability is
     * checked, never installed); "searxng" talks to any SearXNG
     * instance's JSON API; "duckduckgo" and "brave" are built-in
     * single-engine alternatives; "custom-json" points at any JSON
     * search endpoint the user configures.
     */
    searchService: z
      .enum(["duckduckjs", "ddgs", "searxng", "duckduckgo", "brave", "custom-json"])
      .default("duckduckjs"),
    /**
     * Which DuckDuckJS engine the default provider queries. "auto"
     * tries DuckDuckGo, Brave, Google, Mojeek and Yahoo in order until
     * one returns results (resilient against per-engine rate limits);
     * a concrete id pins a single engine.
     */
    duckduckjsEngine: z
      .enum(["auto", "duckduckgo", "brave", "google", "mojeek", "yahoo"])
      .default("auto"),
    /**
     * Optional http(s) proxy for DuckDuckJS requests and http(s)/socks5
     * proxy for DDGS Python requests (e.g. "http://127.0.0.1:8080").
     * Empty means a direct connection. DuckDuckJS applies it through
     * undici's global dispatcher; DDGS Python receives it as the
     * library's `proxy` constructor argument.
     */
    proxyUrl: z.string().trim().max(512).default(""),
    /**
     * Explicit Python interpreter for the "ddgs" service (e.g.
     * "/home/user/venv/bin/python"). Empty = automatic discovery:
     * BUNNY_SEARCH_PYTHON, VIRTUAL_ENV, CONDA_PREFIX, PATH, then
     * ~/.venv, ~/venv and other well-known virtualenv locations.
     */
    ddgsPythonPath: z.string().trim().max(512).default(""),
    /** Base URL of the SearXNG instance (its `/search` endpoint). */
    searxngBaseUrl: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .default("http://127.0.0.1:8888/search"),
    /** Base URL template for the "custom-json" provider (`{query}` placeholder). */
    customBaseUrl: z.string().trim().max(512).default(""),
    /**
     * Web interface URL of the search service, opened by the
     * "Open search interface" action in the UI. Deliberately
     * separate from the API URLs above: an instance like
     * `http://omnirouter/search` serves its interface at
     * `http://omnirouter`. When empty, the API base URL's
     * origin is used (built-in providers use their front
     * pages).
     */
    searchUiUrl: z.string().trim().max(512).default(""),
    /** API key for providers that need one (brave: X-Subscription-Token; custom-json: Bearer). */
    apiKey: z.string().trim().max(512).default(""),
    /** Per-request timeout in milliseconds (1000–60000). */
    timeoutMs: z.number().int().min(1000).max(60000).default(20000),
    /** Default number of results per search (1–30, mirrors SearXNG MCP convention). */
    maxResults: z.number().int().min(1).max(30).default(10),
    /** Default SearXNG categories (comma-separated, e.g. "general,web"). */
    categories: z.string().trim().min(1).max(200).default("general,web"),
    /** Default language code ("ru", "en", …) or "" for auto-detect. */
    language: z.string().trim().max(20).default(""),
  }),
});

export type BunnySearchSettings = z.infer<(typeof bunnySearchSettings)["schema"]>;
