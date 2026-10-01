import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// server/providers.ts
var USER_AGENT = "bunny-search-mcp/1.0 (+searxng)";
var BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
var SearchServiceError = class extends Error {
};
function providerBaseUrl(settings) {
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
async function timedGet(url, settings, headers, serviceLabel2) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect: "follow"
    });
    const latencyMs = Date.now() - startedAt;
    return { ok: true, latencyMs, value: response, error: null };
  } catch (cause) {
    const latencyMs = Date.now() - startedAt;
    return {
      ok: false,
      latencyMs,
      value: null,
      error: friendlyNetworkError(cause, serviceLabel2, url)
    };
  } finally {
    clearTimeout(timer);
  }
}
function friendlyNetworkError(cause, serviceLabel2, url) {
  const reason = cause instanceof Error ? cause.code ?? cause.message : String(cause);
  if (reason === "ABORT_ERR" || reason === "This operation was aborted") {
    return `${serviceLabel2} did not respond within the configured timeout (see the timeout setting).`;
  }
  if (reason === "ECONNREFUSED") {
    return `Cannot connect to ${serviceLabel2} (${url}): connection refused. Check that the service is running.`;
  }
  if (reason === "ENOTFOUND" || reason === "EAI_AGAIN") {
    return `Cannot resolve the host of ${serviceLabel2} (${url}). Check the URL and your network.`;
  }
  return `Cannot connect to ${serviceLabel2} (${url}): ${reason}.`;
}
function serviceLabel(settings) {
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
function withQuery(base, params) {
  const search = new URLSearchParams(params).toString();
  if (search.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${search}`;
}
function clampMaxResults(value) {
  return Math.max(1, Math.min(30, Math.trunc(value) || 1));
}
function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string");
}
function searchSearxng(request, settings) {
  const params = {
    q: request.query,
    format: "json"
  };
  const categories = request.categories ?? settings.categories;
  if (categories.length > 0) params.categories = categories;
  const language = request.language ?? settings.language;
  if (language.length > 0) params.language = language;
  const url = withQuery(settings.searxngBaseUrl, params);
  return timedGet(url, settings, { "User-Agent": USER_AGENT }, serviceLabel(settings)).then(
    (outcome) => {
      if (!outcome.ok || outcome.value === null) {
        throw new SearchServiceError(outcome.error ?? "SearXNG request failed.");
      }
      const response = outcome.value;
      if (!response.ok) {
        throw new SearchServiceError(
          `SearXNG returned HTTP ${response.status} for query: ${request.query}`
        );
      }
      let raw;
      return response.json().then((parsed) => {
        raw = parsed;
        return normalizeSearxng(raw, request);
      }).catch((cause) => {
        throw new SearchServiceError(
          `SearXNG returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      });
    }
  );
}
function normalizeSearxng(raw, request) {
  const results = (Array.isArray(raw.results) ? raw.results : []).slice(0, clampMaxResults(request.maxResults)).map((entry) => ({
    title: typeof entry.title === "string" ? entry.title.trim() : "",
    url: typeof entry.url === "string" ? entry.url : "",
    content: typeof entry.content === "string" ? entry.content.trim().replace(/\s+/g, " ") : "",
    engines: asStringArray(entry.engines)
  }));
  const answers = asStringArray(raw.answers);
  const suggestion = typeof raw.suggestion === "string" && raw.suggestion.length > 0 ? raw.suggestion : asStringArray(raw.suggestions)[0] ?? asStringArray(raw.corrections)[0];
  return {
    query: typeof raw.query === "string" && raw.query.length > 0 ? raw.query : request.query,
    results,
    answers: answers.length > 0 ? answers : void 0,
    suggestion
  };
}
function checkSearxng(settings) {
  return searchSearxng({ query: "bunny-search connection test", maxResults: 1 }, settings).then(() => ({ ok: true, latencyMs: null, error: null })).catch((cause) => ({
    ok: false,
    latencyMs: null,
    error: cause instanceof Error ? cause.message : String(cause)
  }));
}
var DDG_RESULT_RE = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis;
var DDG_SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gis;
function decodeHtmlEntities(value) {
  return value.replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function stripTags(value) {
  return value.replace(/<[^>]*>/g, "").trim();
}
function unwrapDdgUrl(href) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return target;
    return url.href;
  } catch {
    return href;
  }
}
function parseDdgHtml(html, maxResults) {
  const links = [];
  for (const match of html.matchAll(DDG_RESULT_RE)) {
    links.push({
      url: unwrapDdgUrl(decodeHtmlEntities(match[1])),
      title: decodeHtmlEntities(stripTags(match[2]))
    });
  }
  const snippets = [];
  for (const match of html.matchAll(DDG_SNIPPET_RE)) {
    snippets.push(decodeHtmlEntities(stripTags(match[1])));
  }
  return links.slice(0, maxResults).map((link, index) => ({
    title: link.title.length > 0 ? link.title : "(no title)",
    url: link.url,
    content: snippets[index] ?? ""
  }));
}
function searchDuckDuckGo(request, settings) {
  const url = withQuery("https://html.duckduckgo.com/html/", {
    q: request.query
  });
  return timedGet(url, settings, { "User-Agent": BROWSER_UA }, serviceLabel(settings)).then(
    (outcome) => {
      if (!outcome.ok || outcome.value === null) {
        throw new SearchServiceError(outcome.error ?? "DuckDuckGo request failed.");
      }
      const response = outcome.value;
      if (!response.ok) {
        throw new SearchServiceError(
          `DuckDuckGo returned HTTP ${response.status} for query: ${request.query}`
        );
      }
      return response.text().then((html) => ({
        query: request.query,
        results: parseDdgHtml(html, clampMaxResults(request.maxResults))
      })).catch((cause) => {
        throw new SearchServiceError(
          `DuckDuckGo returned an unreadable page: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      });
    }
  );
}
function checkDuckDuckGo(settings) {
  return searchDuckDuckGo({ query: "bunny search connection test", maxResults: 1 }, settings).then(() => ({ ok: true, latencyMs: null, error: null })).catch((cause) => ({
    ok: false,
    latencyMs: null,
    error: cause instanceof Error ? cause.message : String(cause)
  }));
}
function searchBrave(request, settings) {
  if (settings.apiKey.length === 0) {
    return Promise.reject(
      new SearchServiceError(
        "Brave Search needs an API key \u2014 set it in Bunny Search settings (Settings \u2192 Plugins \u2192 Bunny Search)."
      )
    );
  }
  const params = {
    q: request.query,
    count: String(clampMaxResults(request.maxResults))
  };
  if ((request.language ?? settings.language).length > 0) {
    params.search_lang = request.language ?? settings.language;
  }
  const url = withQuery("https://api.search.brave.com/res/v1/web/search", params);
  return timedGet(
    url,
    settings,
    { "User-Agent": USER_AGENT, "X-Subscription-Token": settings.apiKey },
    serviceLabel(settings)
  ).then((outcome) => {
    if (!outcome.ok || outcome.value === null) {
      throw new SearchServiceError(outcome.error ?? "Brave Search request failed.");
    }
    const response = outcome.value;
    if (response.status === 401 || response.status === 403) {
      throw new SearchServiceError(
        `Brave Search rejected the API key (HTTP ${response.status}). Check the key in Bunny Search settings.`
      );
    }
    if (!response.ok) {
      throw new SearchServiceError(
        `Brave Search returned HTTP ${response.status} for query: ${request.query}`
      );
    }
    return response.json().then((parsed) => {
      const raw = parsed;
      return {
        query: request.query,
        results: (raw.web?.results ?? []).map((entry) => ({
          title: typeof entry.title === "string" ? entry.title : "(no title)",
          url: typeof entry.url === "string" ? entry.url : "",
          content: typeof entry.description === "string" ? entry.description : ""
        }))
      };
    }).catch((cause) => {
      throw new SearchServiceError(
        `Brave Search returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    });
  });
}
function checkBrave(settings) {
  return searchBrave({ query: "bunny search connection test", maxResults: 1 }, settings).then(() => ({ ok: true, latencyMs: null, error: null })).catch((cause) => ({
    ok: false,
    latencyMs: null,
    error: cause instanceof Error ? cause.message : String(cause)
  }));
}
function customUrl(settings, query) {
  const template = settings.customBaseUrl;
  if (template.includes("{query}")) {
    return template.replaceAll("{query}", encodeURIComponent(query));
  }
  return withQuery(template, { q: query });
}
function pickField(entry, keys) {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}
function extractResults(payload) {
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
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function searchCustomJson(request, settings) {
  if (settings.customBaseUrl.length === 0) {
    return Promise.reject(
      new SearchServiceError(
        "Custom search endpoint URL is empty \u2014 set it in Bunny Search settings."
      )
    );
  }
  const url = customUrl(settings, request.query);
  const headers = { "User-Agent": USER_AGENT };
  if (settings.apiKey.length > 0) headers.Authorization = `Bearer ${settings.apiKey}`;
  return timedGet(url, settings, headers, serviceLabel(settings)).then(
    (outcome) => {
      if (!outcome.ok || outcome.value === null) {
        throw new SearchServiceError(outcome.error ?? "Custom search endpoint request failed.");
      }
      const response = outcome.value;
      if (!response.ok) {
        throw new SearchServiceError(
          `Custom search endpoint returned HTTP ${response.status} for query: ${request.query}`
        );
      }
      return response.json().then((parsed) => ({
        query: request.query,
        results: extractResults(parsed).slice(0, clampMaxResults(request.maxResults)).map((entry) => ({
          title: pickField(entry, ["title", "name", "heading"]) || "(no title)",
          url: pickField(entry, ["url", "link", "href"]),
          content: pickField(entry, ["content", "snippet", "description", "body", "text"])
        }))
      })).catch((cause) => {
        throw new SearchServiceError(
          `Custom search endpoint returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      });
    }
  );
}
function checkCustomJson(settings) {
  return searchCustomJson({ query: "test", maxResults: 1 }, settings).then(() => ({ ok: true, latencyMs: null, error: null })).catch((cause) => ({
    ok: false,
    latencyMs: null,
    error: cause instanceof Error ? cause.message : String(cause)
  }));
}
var PROVIDERS = {
  searxng: { id: "searxng", search: searchSearxng, check: checkSearxng },
  duckduckgo: { id: "duckduckgo", search: searchDuckDuckGo, check: checkDuckDuckGo },
  brave: { id: "brave", search: searchBrave, check: checkBrave },
  "custom-json": { id: "custom-json", search: searchCustomJson, check: checkCustomJson }
};
function getProvider(settings) {
  return PROVIDERS[settings.searchService];
}
function searchWeb(request, settings) {
  return getProvider(settings).search(request, settings);
}
var SNIPPET_LIMIT = 300;
function truncateSnippet(value) {
  return value.length <= SNIPPET_LIMIT ? value : `${value.slice(0, SNIPPET_LIMIT)}\u2026`;
}
function formatSearchResponse(response) {
  const lines = [`Query: ${response.query}`];
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

// server/mcp-tools.ts
function str(description) {
  return { type: "string", description };
}
function num(description) {
  return { type: "number", description };
}
var MCP_TOOLS = [
  {
    name: "web_search",
    title: "Search the web",
    description: "Search the web through the configured search service (default: SearXNG). Returns formatted results: title, URL, content snippet and source engines. Use when you need current information, documentation, news or any content that is not in the local codebase.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search query."),
        max_results: num("Maximum number of results, 1\u201330 (default 10)."),
        categories: str(
          "SearXNG categories, comma-separated (e.g. 'general,web', 'news', 'science'). Ignored by other providers."
        ),
        language: str(
          "Language code ('ru', 'en', 'uk', \u2026) or empty for auto-detect."
        )
      },
      required: ["query"]
    }
  },
  {
    name: "search_status",
    title: "Search service status",
    description: "Reports which search service is configured (SearXNG by default), its base URL and the default result settings. Use to check that the web search MCP is connected before relying on it.",
    inputSchema: { type: "object", properties: {} }
  }
];
function text(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
function error(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function dispatchMcpTool(name, args, context) {
  const { settings } = context;
  const input = args ?? {};
  switch (name) {
    case "web_search": {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (query.length === 0) {
        return error("query is required and must be a non-empty string.");
      }
      const maxResults = typeof input.max_results === "number" && Number.isFinite(input.max_results) ? Math.max(1, Math.min(30, Math.trunc(input.max_results))) : settings.maxResults;
      const categories = typeof input.categories === "string" && input.categories.trim().length > 0 ? input.categories.trim() : settings.categories;
      const language = typeof input.language === "string" ? input.language.trim() : settings.language;
      return searchWeb(
        { query, maxResults, categories, language },
        settings
      ).then((response) => text({ text: formatSearchResponse(response) })).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        return error(message);
      });
    }
    case "search_status": {
      return text({
        provider: settings.searchService,
        baseUrl: providerBaseUrl(settings),
        defaults: {
          maxResults: settings.maxResults,
          categories: settings.categories,
          language: settings.language || "(auto)",
          timeoutMs: settings.timeoutMs
        }
      });
    }
    default:
      return error(`Unknown tool: ${name}`);
  }
}

// server/settings-file.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
var DEFAULTS = {
  searchService: "searxng",
  searxngBaseUrl: "http://127.0.0.1:8888/search",
  customBaseUrl: "",
  apiKey: "",
  timeoutMs: 2e4,
  maxResults: 10,
  categories: "general,web",
  language: ""
};
function settingsFilePath() {
  const configured = process.env.PASEO_HOME;
  const home = configured && configured.trim().length > 0 ? configured : path.join(os.homedir(), ".paseo");
  return path.join(home, "plugins", "bunny-search", "settings.json");
}
function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function optionalInt(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
function parseFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    const record = raw;
    const values = typeof record.values === "object" && record.values !== null ? record.values : record;
    const parsed = {};
    const searchService = optionalString(values.searchService);
    if (searchService === "searxng" || searchService === "duckduckgo" || searchService === "brave" || searchService === "custom-json") {
      parsed.searchService = searchService;
    }
    const searxngBaseUrl = optionalString(values.searxngBaseUrl);
    if (searxngBaseUrl) parsed.searxngBaseUrl = searxngBaseUrl.slice(0, 512);
    const customBaseUrl = optionalString(values.customBaseUrl);
    if (customBaseUrl) parsed.customBaseUrl = customBaseUrl.slice(0, 512);
    if (typeof values.apiKey === "string") parsed.apiKey = values.apiKey.slice(0, 512);
    const timeoutMs = optionalInt(values.timeoutMs, 1e3, 6e4);
    if (timeoutMs !== void 0) parsed.timeoutMs = timeoutMs;
    const maxResults = optionalInt(values.maxResults, 1, 30);
    if (maxResults !== void 0) parsed.maxResults = maxResults;
    const categories = optionalString(values.categories);
    if (categories) parsed.categories = categories.slice(0, 200);
    if (typeof values.language === "string") parsed.language = values.language.trim().slice(0, 20);
    return parsed;
  } catch {
    return {};
  }
}
function parseEnv() {
  const parsed = {};
  const baseUrl = optionalString(process.env.BUNNY_SEARCH_BASE_URL) ?? optionalString(process.env.SEARXNG_BASE_URL);
  if (baseUrl) parsed.searxngBaseUrl = baseUrl;
  const service = optionalString(process.env.BUNNY_SEARCH_PROVIDER);
  if (service === "searxng" || service === "duckduckgo" || service === "brave" || service === "custom-json") {
    parsed.searchService = service;
  }
  const customUrl2 = optionalString(process.env.BUNNY_SEARCH_CUSTOM_URL);
  if (customUrl2) parsed.customBaseUrl = customUrl2;
  const apiKey = optionalString(process.env.BUNNY_SEARCH_API_KEY);
  if (apiKey) parsed.apiKey = apiKey;
  const timeoutMs = process.env.BUNNY_SEARCH_TIMEOUT_MS ? optionalInt(Number(process.env.BUNNY_SEARCH_TIMEOUT_MS), 1e3, 6e4) : void 0;
  if (timeoutMs !== void 0) parsed.timeoutMs = timeoutMs;
  const maxResults = process.env.BUNNY_SEARCH_MAX_RESULTS ? optionalInt(Number(process.env.BUNNY_SEARCH_MAX_RESULTS), 1, 30) : void 0;
  if (maxResults !== void 0) parsed.maxResults = maxResults;
  const categories = optionalString(process.env.BUNNY_SEARCH_CATEGORIES);
  if (categories) parsed.categories = categories;
  const language = optionalString(process.env.BUNNY_SEARCH_LANGUAGE);
  if (language) parsed.language = language;
  return parsed;
}
function parseSettingsFile(filePath = settingsFilePath()) {
  return {
    ...DEFAULTS,
    ...parseFile(filePath),
    ...parseEnv()
  };
}

// server/mcp-server.ts
var PROTOCOL_VERSION = "2024-11-05";
var SERVER_VERSION = "0.2.0";
function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}
`);
}
function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}
function respondError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}
function main() {
  const settings = parseSettingsFile();
  const context = { settings };
  const serverInfo = { name: "bunny-search", version: SERVER_VERSION };
  process.stderr.write(
    `[bunny-search] MCP server ready (provider: ${settings.searchService})
`
  );
  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        respondError(null, -32700, "Parse error");
        continue;
      }
      handleRequest(request, context, serverInfo);
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
  const shutdown = () => {
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
function handleRequest(request, context, serverInfo) {
  const id = request.id ?? null;
  switch (request.method) {
    case "initialize": {
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return;
    // notification — no response
    case "ping":
      respond(id, {});
      return;
    case "tools/list": {
      respond(id, { tools: MCP_TOOLS });
      return;
    }
    case "tools/call": {
      const params = request.params ?? {};
      const name = String(params.name ?? "");
      void Promise.resolve(dispatchMcpTool(name, params.arguments ?? {}, context)).then((result) => {
        if (result.isError) {
          process.stderr.write(`[bunny-search] tool ${name} failed: ${result.content[0].text}
`);
        }
        respond(id, result);
      }).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`[bunny-search] tool ${name} failed: ${message}
`);
        respond(id, { content: [{ type: "text", text: message }], isError: true });
      });
      return;
    }
    default:
      if (request.method.startsWith("notifications/")) return;
      respondError(id, -32601, `Method not found: ${request.method}`);
  }
}
main();
