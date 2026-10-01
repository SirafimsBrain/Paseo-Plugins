import type { RuntimeSettings, SearchRequest, SearchResponse, WebResult } from "../shared/contracts";

/**
 * Search provider adapters for the bunny-search MCP server.
 *
 * Every adapter implements one interface: `search()` performs a real
 * web search and returns normalized results, `check()` answers "is
 * this service reachable and working right now" (the connection
 * test button). The default provider is SearXNG (ported from the
 * reference `searxng_mcp_server.py`); the other adapters make the
 * service selectable, per the plugin requirements.
 *
 * All HTTP goes through the global `fetch` (Node ≥ 18) with an
 * `AbortController` timeout — no runtime dependencies.
 */

/** User-Agent sent to search services (mirrors the reference MCP). */
export const USER_AGENT = "bunny-search-mcp/1.0 (+searxng)";

/** Browser-like UA for services that reject tool user-agents. */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Error thrown on any provider failure; `.message` is user/agent-friendly. */
export class SearchServiceError extends Error {}

/** Absolute URL of the service the adapter talks to (for status display). */
export function providerBaseUrl(settings: RuntimeSettings): string | null {
  switch (settings.searchService) {
    case "searxng":
      return settings.searxngBaseUrl;
    case "duckduckgo":
      return "https://html.duckduckgo.com/html/";
    case "brave":
      return "https://api.search.brave.com/res/v1/web/search";
    case "custom-json":
      return settings.customBaseUrl.length > 0 ? settings.customBaseUrl : null;
  }
}

/** The adapter interface shared by every provider. */
export interface SearchProvider {
  readonly id: RuntimeSettings["searchService"];
  search(request: SearchRequest, settings: RuntimeSettings): Promise<SearchResponse>;
  check(settings: RuntimeSettings): Promise<CheckResult>;
}

export interface CheckResult {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Shared HTTP helpers
// ---------------------------------------------------------------------------

interface FetchOutcome<T> {
  ok: boolean;
  latencyMs: number;
  value: T | null;
  error: string | null;
}

/**
 * GET with the configured timeout. Maps failures to friendly
 * messages the way the reference MCP does: HTTP status codes,
 * connection failures (refused / DNS) and invalid JSON each get
 * a distinct, actionable message.
 */
async function timedGet(
  url: string,
  settings: RuntimeSettings,
  headers: Record<string, string>,
  serviceLabel: string,
): Promise<FetchOutcome<Response>> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect: "follow",
    });
    const latencyMs = Date.now() - startedAt;
    return { ok: true, latencyMs, value: response, error: null };
  } catch (cause) {
    const latencyMs = Date.now() - startedAt;
    return {
      ok: false,
      latencyMs,
      value: null,
      error: friendlyNetworkError(cause, serviceLabel, url),
    };
  } finally {
    clearTimeout(timer);
  }
}

function friendlyNetworkError(cause: unknown, serviceLabel: string, url: string): string {
  const reason =
    cause instanceof Error
      ? (cause as Error & { code?: string }).code ?? cause.message
      : String(cause);
  if (reason === "ABORT_ERR" || reason === "This operation was aborted") {
    return `${serviceLabel} did not respond within the configured timeout (see the timeout setting).`;
  }
  if (reason === "ECONNREFUSED") {
    return `Cannot connect to ${serviceLabel} (${url}): connection refused. Check that the service is running.`;
  }
  if (reason === "ENOTFOUND" || reason === "EAI_AGAIN") {
    return `Cannot resolve the host of ${serviceLabel} (${url}). Check the URL and your network.`;
  }
  return `Cannot connect to ${serviceLabel} (${url}): ${reason}.`;
}

function serviceLabel(settings: RuntimeSettings): string {
  switch (settings.searchService) {
    case "searxng":
      return "SearXNG";
    case "duckduckgo":
      return "DuckDuckGo";
    case "brave":
      return "Brave Search";
    case "custom-json":
      return "the custom search endpoint";
  }
}

/** Appends query parameters to a base URL that may already carry a query string. */
function withQuery(base: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString();
  if (search.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${search}`;
}

/** Clamps the requested result count to the 1–30 band (SearXNG MCP convention). */
export function clampMaxResults(value: number): number {
  return Math.max(1, Math.min(30, Math.trunc(value) || 1));
}

// ---------------------------------------------------------------------------
// SearXNG (default provider — ported from searxng_mcp_server.py)
// ---------------------------------------------------------------------------

interface SearxngRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engines?: unknown;
}

interface SearxngRawResponse {
  query?: unknown;
  results?: unknown;
  answers?: unknown;
  suggestion?: unknown;
  suggestions?: unknown;
  corrections?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function searchSearxng(request: SearchRequest, settings: RuntimeSettings): Promise<SearchResponse> {
  const params: Record<string, string> = {
    q: request.query,
    format: "json",
  };
  const categories = request.categories ?? settings.categories;
  if (categories.length > 0) params.categories = categories;
  const language = request.language ?? settings.language;
  if (language.length > 0) params.language = language;
  const url = withQuery(settings.searxngBaseUrl, params);

  return timedGet(url, settings, { "User-Agent": USER_AGENT }, serviceLabel(settings)).then(
    (outcome): Promise<SearchResponse> => {
      if (!outcome.ok || outcome.value === null) {
        throw new SearchServiceError(outcome.error ?? "SearXNG request failed.");
      }
      const response = outcome.value;
      if (!response.ok) {
        throw new SearchServiceError(
          `SearXNG returned HTTP ${response.status} for query: ${request.query}`,
        );
      }
      let raw: SearxngRawResponse;
      return response
        .json()
        .then((parsed: unknown) => {
          raw = parsed as SearxngRawResponse;
          return normalizeSearxng(raw, request);
        })
        .catch((cause: unknown) => {
          throw new SearchServiceError(
            `SearXNG returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        });
    },
  );
}

function normalizeSearxng(raw: SearxngRawResponse, request: SearchRequest): SearchResponse {
  const results: WebResult[] = (Array.isArray(raw.results) ? (raw.results as SearxngRawResult[]) : [])
    .slice(0, clampMaxResults(request.maxResults))
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title.trim() : "",
      url: typeof entry.url === "string" ? entry.url : "",
      content: typeof entry.content === "string" ? entry.content.trim().replace(/\s+/g, " ") : "",
      engines: asStringArray(entry.engines),
    }));
  const answers = asStringArray(raw.answers);
  // The reference MCP reads `suggestion` / `corrections`; live SearXNG
  // instances return `suggestions` (array) — accept all three.
  const suggestion =
    typeof raw.suggestion === "string" && raw.suggestion.length > 0
      ? raw.suggestion
      : (asStringArray(raw.suggestions)[0] ?? asStringArray(raw.corrections)[0]);
  return {
    query: typeof raw.query === "string" && raw.query.length > 0 ? raw.query : request.query,
    results,
    answers: answers.length > 0 ? answers : undefined,
    suggestion,
  };
}

function checkSearxng(settings: RuntimeSettings): Promise<CheckResult> {
  return searchSearxng({ query: "bunny-search connection test", maxResults: 1 }, settings)
    .then(() => ({ ok: true, latencyMs: null, error: null }))
    .catch((cause: unknown) => ({
      ok: false,
      latencyMs: null,
      error: cause instanceof Error ? cause.message : String(cause),
    }));
}

// ---------------------------------------------------------------------------
// DuckDuckGo (HTML endpoint, no API key)
// ---------------------------------------------------------------------------

const DDG_RESULT_RE =
  /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis;
const DDG_SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gis;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

/** Extracts the real target URL from a DuckDuckGo redirect link. */
function unwrapDdgUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return target;
    return url.href;
  } catch {
    return href;
  }
}

function parseDdgHtml(html: string, maxResults: number): WebResult[] {
  const links: Array<{ url: string; title: string }> = [];
  for (const match of html.matchAll(DDG_RESULT_RE)) {
    links.push({
      url: unwrapDdgUrl(decodeHtmlEntities(match[1])),
      title: decodeHtmlEntities(stripTags(match[2])),
    });
  }
  const snippets: string[] = [];
  for (const match of html.matchAll(DDG_SNIPPET_RE)) {
    snippets.push(decodeHtmlEntities(stripTags(match[1])));
  }
  return links.slice(0, maxResults).map((link, index) => ({
    title: link.title.length > 0 ? link.title : "(no title)",
    url: link.url,
    content: snippets[index] ?? "",
  }));
}

function searchDuckDuckGo(request: SearchRequest, settings: RuntimeSettings): Promise<SearchResponse> {
  const url = withQuery("https://html.duckduckgo.com/html/", {
    q: request.query,
  });
  return timedGet(url, settings, { "User-Agent": BROWSER_UA }, serviceLabel(settings)).then(
    (outcome): Promise<SearchResponse> => {
      if (!outcome.ok || outcome.value === null) {
        throw new SearchServiceError(outcome.error ?? "DuckDuckGo request failed.");
      }
      const response = outcome.value;
      if (!response.ok) {
        throw new SearchServiceError(
          `DuckDuckGo returned HTTP ${response.status} for query: ${request.query}`,
        );
      }
      return response
        .text()
        .then((html) => ({
          query: request.query,
          results: parseDdgHtml(html, clampMaxResults(request.maxResults)),
        }))
        .catch((cause: unknown) => {
          throw new SearchServiceError(
            `DuckDuckGo returned an unreadable page: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        });
    },
  );
}

function checkDuckDuckGo(settings: RuntimeSettings): Promise<CheckResult> {
  return searchDuckDuckGo({ query: "bunny search connection test", maxResults: 1 }, settings)
    .then(() => ({ ok: true, latencyMs: null, error: null }))
    .catch((cause: unknown) => ({
      ok: false,
      latencyMs: null,
      error: cause instanceof Error ? cause.message : String(cause),
    }));
}

// ---------------------------------------------------------------------------
// Brave Search (API key)
// ---------------------------------------------------------------------------

interface BraveRawResponse {
  web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
}

function searchBrave(request: SearchRequest, settings: RuntimeSettings): Promise<SearchResponse> {
  if (settings.apiKey.length === 0) {
    return Promise.reject(
      new SearchServiceError(
        "Brave Search needs an API key — set it in Bunny Search settings (Settings → Plugins → Bunny Search).",
      ),
    );
  }
  const params: Record<string, string> = {
    q: request.query,
    count: String(clampMaxResults(request.maxResults)),
  };
  if ((request.language ?? settings.language).length > 0) {
    params.search_lang = request.language ?? settings.language;
  }
  const url = withQuery("https://api.search.brave.com/res/v1/web/search", params);
  return timedGet(
    url,
    settings,
    { "User-Agent": USER_AGENT, "X-Subscription-Token": settings.apiKey },
    serviceLabel(settings),
  ).then((outcome): Promise<SearchResponse> => {
    if (!outcome.ok || outcome.value === null) {
      throw new SearchServiceError(outcome.error ?? "Brave Search request failed.");
    }
    const response = outcome.value;
    if (response.status === 401 || response.status === 403) {
      throw new SearchServiceError(
        `Brave Search rejected the API key (HTTP ${response.status}). Check the key in Bunny Search settings.`,
      );
    }
    if (!response.ok) {
      throw new SearchServiceError(
        `Brave Search returned HTTP ${response.status} for query: ${request.query}`,
      );
    }
    return response
      .json()
      .then((parsed: unknown) => {
        const raw = parsed as BraveRawResponse;
        return {
          query: request.query,
          results: (raw.web?.results ?? []).map((entry) => ({
            title: typeof entry.title === "string" ? entry.title : "(no title)",
            url: typeof entry.url === "string" ? entry.url : "",
            content: typeof entry.description === "string" ? entry.description : "",
          })),
        };
      })
      .catch((cause: unknown) => {
        throw new SearchServiceError(
          `Brave Search returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
  });
}

function checkBrave(settings: RuntimeSettings): Promise<CheckResult> {
  return searchBrave({ query: "bunny search connection test", maxResults: 1 }, settings)
    .then(() => ({ ok: true, latencyMs: null, error: null }))
    .catch((cause: unknown) => ({
      ok: false,
      latencyMs: null,
      error: cause instanceof Error ? cause.message : String(cause),
    }));
}

// ---------------------------------------------------------------------------
// Custom JSON endpoint (any JSON search API)
// ---------------------------------------------------------------------------

/**
 * Builds the request URL for the custom-json provider: `{query}`
 * placeholders in the configured URL are replaced (URL-encoded);
 * without a placeholder the query is appended as `q`.
 */
function customUrl(settings: RuntimeSettings, query: string): string {
  const template = settings.customBaseUrl;
  if (template.includes("{query}")) {
    return template.replaceAll("{query}", encodeURIComponent(query));
  }
  return withQuery(template, { q: query });
}

/** Heuristic field mapping: accepts the common key spellings of JSON search APIs. */
function pickField(entry: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function extractResults(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (isRecord(payload)) {
    for (const key of ["results", "data", "items", "web"]) {
      const value = payload[key];
      if (Array.isArray(value)) return value.filter(isRecord);
      if (isRecord(value)) {
        for (const nested of ["results", "data", "items"]) {
          if (Array.isArray(value[nested])) return value[nested].filter(isRecord);
        }
      }
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchCustomJson(request: SearchRequest, settings: RuntimeSettings): Promise<SearchResponse> {
  if (settings.customBaseUrl.length === 0) {
    return Promise.reject(
      new SearchServiceError(
        "Custom search endpoint URL is empty — set it in Bunny Search settings.",
      ),
    );
  }
  const url = customUrl(settings, request.query);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (settings.apiKey.length > 0) headers.Authorization = `Bearer ${settings.apiKey}`;
  return timedGet(url, settings, headers, serviceLabel(settings)).then(
    (outcome): Promise<SearchResponse> => {
      if (!outcome.ok || outcome.value === null) {
        throw new SearchServiceError(outcome.error ?? "Custom search endpoint request failed.");
      }
      const response = outcome.value;
      if (!response.ok) {
        throw new SearchServiceError(
          `Custom search endpoint returned HTTP ${response.status} for query: ${request.query}`,
        );
      }
      return response
        .json()
        .then((parsed: unknown) => ({
          query: request.query,
          results: extractResults(parsed)
            .slice(0, clampMaxResults(request.maxResults))
            .map((entry) => ({
              title: pickField(entry, ["title", "name", "heading"]) || "(no title)",
              url: pickField(entry, ["url", "link", "href"]),
              content: pickField(entry, ["content", "snippet", "description", "body", "text"]),
            })),
        }))
        .catch((cause: unknown) => {
          throw new SearchServiceError(
            `Custom search endpoint returned invalid JSON: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        });
    },
  );
}

function checkCustomJson(settings: RuntimeSettings): Promise<CheckResult> {
  return searchCustomJson({ query: "test", maxResults: 1 }, settings)
    .then(() => ({ ok: true, latencyMs: null, error: null }))
    .catch((cause: unknown) => ({
      ok: false,
      latencyMs: null,
      error: cause instanceof Error ? cause.message : String(cause),
    }));
}

// ---------------------------------------------------------------------------
// Registry + result formatting
// ---------------------------------------------------------------------------

const PROVIDERS: Record<RuntimeSettings["searchService"], SearchProvider> = {
  searxng: { id: "searxng", search: searchSearxng, check: checkSearxng },
  duckduckgo: { id: "duckduckgo", search: searchDuckDuckGo, check: checkDuckDuckGo },
  brave: { id: "brave", search: searchBrave, check: checkBrave },
  "custom-json": { id: "custom-json", search: searchCustomJson, check: checkCustomJson },
};

/** Resolves the adapter for the configured service. */
export function getProvider(settings: RuntimeSettings): SearchProvider {
  return PROVIDERS[settings.searchService];
}

/** Runs a search through the configured provider. */
export function searchWeb(request: SearchRequest, settings: RuntimeSettings): Promise<SearchResponse> {
  return getProvider(settings).search(request, settings);
}

/** Checks the configured provider — the backend of the connection test. */
export async function checkSearchService(settings: RuntimeSettings): Promise<CheckResult> {
  const startedAt = Date.now();
  const result = await getProvider(settings).check(settings);
  return result.latencyMs === null
    ? { ...result, latencyMs: result.ok ? Date.now() - startedAt : null }
    : result;
}

/** Snippet cap from the reference MCP (300 chars, ellipsis). */
const SNIPPET_LIMIT = 300;

function truncateSnippet(value: string): string {
  return value.length <= SNIPPET_LIMIT ? value : `${value.slice(0, SNIPPET_LIMIT)}…`;
}

/**
 * Formats a search response as plain text for agents — the same
 * layout the reference SearXNG MCP produces (query line, optional
 * instant answer, numbered results with title/url/snippet/engines,
 * optional suggestion).
 */
export function formatSearchResponse(response: SearchResponse): string {
  const lines: string[] = [`Query: ${response.query}`];
  const answer = response.answers?.[0];
  if (answer) lines.push(`Answer: ${answer}`);
  lines.push("");

  if (response.results.length === 0) {
    lines.push("No results found.");
    if (response.suggestion) lines.push(`Did you mean: ${response.suggestion}`);
    return lines.join("\n");
  }

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || "(no title)"}`);
    lines.push(`   ${result.url}`);
    if (result.content.length > 0) lines.push(`   ${truncateSnippet(result.content)}`);
    if (result.engines && result.engines.length > 0) {
      lines.push(`   Engines: ${result.engines.join(", ")}`);
    }
    lines.push("");
  });

  if (response.suggestion) lines.push(`Did you mean: ${response.suggestion}`);
  return lines.join("\n").trimEnd();
}
