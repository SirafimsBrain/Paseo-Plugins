import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeSettings } from "../shared/contracts";

/**
 * Reads the plugin's persisted settings for the MCP server process.
 *
 * The MCP server is spawned by agent providers (outside the plugin
 * host), so it cannot receive settings through the SDK. It therefore
 * reads the same JSON file the host writes for `registerSettings`:
 * `$PASEO_HOME/plugins/bunny-search/settings.json`. Missing or invalid
 * files fall back to the schema defaults.
 *
 * Environment variables override the file, so the server also works
 * standalone (outside Paseo) — the same mechanism the reference
 * SearXNG MCP uses (`SEARXNG_BASE_URL` is honored for drop-in
 * compatibility).
 */

const DEFAULTS: RuntimeSettings = {
  searchService: "duckduckjs",
  duckduckjsEngine: "auto",
  proxyUrl: "",
  searxngBaseUrl: "http://127.0.0.1:8888/search",
  customBaseUrl: "",
  apiKey: "",
  timeoutMs: 20000,
  maxResults: 10,
  categories: "general,web",
  language: "",
};

/** The search service ids accepted in the file and in the environment. */
const SERVICES = ["duckduckjs", "searxng", "duckduckgo", "brave", "custom-json"] as const;

/** The DuckDuckJS engine ids accepted in the file and in the environment. */
const DUCKDUCKJS_ENGINES = ["auto", "duckduckgo", "brave", "google", "mojeek", "yahoo"] as const;

function parseService(value: unknown): RuntimeSettings["searchService"] | undefined {
  return SERVICES.find((service) => service === value);
}

function parseEngine(value: unknown): RuntimeSettings["duckduckjsEngine"] | undefined {
  return DUCKDUCKJS_ENGINES.find((engine) => engine === value);
}

function settingsFilePath(): string {
  const configured = process.env.PASEO_HOME;
  const home =
    configured && configured.trim().length > 0 ? configured : path.join(os.homedir(), ".paseo");
  return path.join(home, "plugins", "bunny-search", "settings.json");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseFile(filePath: string): Partial<RuntimeSettings> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    const record = raw as Record<string, unknown>;
    // Accept both the host layout `{revision, values}` and a flat object.
    const values =
      typeof record.values === "object" && record.values !== null
        ? (record.values as Record<string, unknown>)
        : record;
    const parsed: Partial<RuntimeSettings> = {};
    const searchService = parseService(values.searchService);
    if (searchService) parsed.searchService = searchService;
    const duckduckjsEngine = parseEngine(values.duckduckjsEngine);
    if (duckduckjsEngine) parsed.duckduckjsEngine = duckduckjsEngine;
    if (typeof values.proxyUrl === "string") parsed.proxyUrl = values.proxyUrl.trim().slice(0, 512);
    const searxngBaseUrl = optionalString(values.searxngBaseUrl);
    if (searxngBaseUrl) parsed.searxngBaseUrl = searxngBaseUrl.slice(0, 512);
    const customBaseUrl = optionalString(values.customBaseUrl);
    if (customBaseUrl) parsed.customBaseUrl = customBaseUrl.slice(0, 512);
    if (typeof values.apiKey === "string") parsed.apiKey = values.apiKey.slice(0, 512);
    const timeoutMs = optionalInt(values.timeoutMs, 1000, 60000);
    if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
    const maxResults = optionalInt(values.maxResults, 1, 30);
    if (maxResults !== undefined) parsed.maxResults = maxResults;
    const categories = optionalString(values.categories);
    if (categories) parsed.categories = categories.slice(0, 200);
    if (typeof values.language === "string") parsed.language = values.language.trim().slice(0, 20);
    return parsed;
  } catch {
    return {};
  }
}

/** Environment overrides (standalone use outside Paseo). */
function parseEnv(): Partial<RuntimeSettings> {
  const parsed: Partial<RuntimeSettings> = {};
  // `SEARXNG_BASE_URL` is honored for compatibility with the reference MCP.
  const baseUrl = optionalString(process.env.BUNNY_SEARCH_BASE_URL) ?? optionalString(process.env.SEARXNG_BASE_URL);
  if (baseUrl) parsed.searxngBaseUrl = baseUrl;
  const service = optionalString(process.env.BUNNY_SEARCH_PROVIDER);
  const parsedService = parseService(service);
  if (parsedService) parsed.searchService = parsedService;
  const engine = optionalString(process.env.BUNNY_SEARCH_DUCKDUCKJS_ENGINE);
  const parsedEngine = parseEngine(engine);
  if (parsedEngine) parsed.duckduckjsEngine = parsedEngine;
  const proxyUrl = optionalString(process.env.BUNNY_SEARCH_PROXY_URL);
  if (proxyUrl) parsed.proxyUrl = proxyUrl.slice(0, 512);
  const customUrl = optionalString(process.env.BUNNY_SEARCH_CUSTOM_URL);
  if (customUrl) parsed.customBaseUrl = customUrl;
  const apiKey = optionalString(process.env.BUNNY_SEARCH_API_KEY);
  if (apiKey) parsed.apiKey = apiKey;
  const timeoutMs = process.env.BUNNY_SEARCH_TIMEOUT_MS
    ? optionalInt(Number(process.env.BUNNY_SEARCH_TIMEOUT_MS), 1000, 60000)
    : undefined;
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  const maxResults = process.env.BUNNY_SEARCH_MAX_RESULTS
    ? optionalInt(Number(process.env.BUNNY_SEARCH_MAX_RESULTS), 1, 30)
    : undefined;
  if (maxResults !== undefined) parsed.maxResults = maxResults;
  const categories = optionalString(process.env.BUNNY_SEARCH_CATEGORIES);
  if (categories) parsed.categories = categories;
  const language = optionalString(process.env.BUNNY_SEARCH_LANGUAGE);
  if (language) parsed.language = language;
  return parsed;
}

/** Settings the MCP server process runs with: defaults ← file ← env. */
export function parseSettingsFile(filePath: string = settingsFilePath()): RuntimeSettings {
  return {
    ...DEFAULTS,
    ...parseFile(filePath),
    ...parseEnv(),
  };
}
