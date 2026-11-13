import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../shared/settings";
import { settingsMirrorPath } from "./paths";

/**
 * Reads the plugin's persisted settings for the MCP server process.
 *
 * The MCP server is spawned by agent providers, outside the plugin host, so it
 * cannot use the plugin API. It reads the JSON file the plugin mirrors:
 * `$PASEO_HOME/plugins/obsidian-bridge/settings.json`. Environment variables
 * override the file so the server also works standalone.
 */

const DEFAULTS: RuntimeSettings = {
  vaultPath: "",
  inboxDir: "Inbox",
  outDir: "Documentation",
  rawDir: "raw",
  indexingEnabled: true,
  includeFolders: "",
  excludeGlobs: ".obsidian/**, .trash/**, .git/**, .smart-env/**",
  ftsStemming: false,
  reconcileMinutes: 10,
  maxResults: 10,
  searchBudgetChars: 8000,
  snippetChars: 600,
  readOnly: false,
  maxWriteChars: 200_000,
  semanticSearch: true,
  embeddingModel: "Xenova/multilingual-e5-small",
  embeddingDtype: "q8",
  embeddingIdleMinutes: 10,
  obsidianApiEnabled: false,
  obsidianApiUrl: "https://127.0.0.1:27124",
  obsidianApiKey: "",
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function optionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
    if (typeof values.vaultPath === "string") {
      parsed.vaultPath = values.vaultPath.trim().slice(0, 1024);
    }
    for (const key of ["inboxDir", "outDir", "rawDir"] as const) {
      if (typeof values[key] === "string") parsed[key] = values[key].trim().slice(0, 512);
    }
    if (typeof values.indexingEnabled === "boolean") parsed.indexingEnabled = values.indexingEnabled;
    if (typeof values.includeFolders === "string") {
      parsed.includeFolders = values.includeFolders.trim().slice(0, 2000);
    }
    if (typeof values.excludeGlobs === "string") {
      parsed.excludeGlobs = values.excludeGlobs.trim().slice(0, 2000);
    }
    if (typeof values.ftsStemming === "boolean") parsed.ftsStemming = values.ftsStemming;
    const reconcile = optionalInt(values.reconcileMinutes, 1, 240);
    if (reconcile !== undefined) parsed.reconcileMinutes = reconcile;
    const maxResults = optionalInt(values.maxResults, 1, 50);
    if (maxResults !== undefined) parsed.maxResults = maxResults;
    const budget = optionalInt(values.searchBudgetChars, 500, 60000);
    if (budget !== undefined) parsed.searchBudgetChars = budget;
    const snippet = optionalInt(values.snippetChars, 120, 4000);
    if (snippet !== undefined) parsed.snippetChars = snippet;
    const readOnly = optionalBool(values.readOnly);
    if (readOnly !== undefined) parsed.readOnly = readOnly;
    const maxWrite = optionalInt(values.maxWriteChars, 1000, 400_000);
    if (maxWrite !== undefined) parsed.maxWriteChars = maxWrite;
    if (typeof values.semanticSearch === "boolean") {
      parsed.semanticSearch = values.semanticSearch;
    }
    if (typeof values.embeddingModel === "string" && values.embeddingModel.trim().length > 0) {
      parsed.embeddingModel = values.embeddingModel.trim().slice(0, 200);
    }
    if (typeof values.embeddingDtype === "string" && values.embeddingDtype.trim().length > 0) {
      parsed.embeddingDtype = values.embeddingDtype.trim().slice(0, 16);
    }
    const idle = optionalInt(values.embeddingIdleMinutes, 0, 240);
    if (idle !== undefined) parsed.embeddingIdleMinutes = idle;
    if (typeof values.obsidianApiEnabled === "boolean") {
      parsed.obsidianApiEnabled = values.obsidianApiEnabled;
    }
    if (typeof values.obsidianApiUrl === "string") {
      parsed.obsidianApiUrl = values.obsidianApiUrl.trim().slice(0, 512);
    }
    if (typeof values.obsidianApiKey === "string") {
      parsed.obsidianApiKey = values.obsidianApiKey.trim().slice(0, 512);
    }
    return parsed;
  } catch {
    return {};
  }
}

function parseEnv(): Partial<RuntimeSettings> {
  const parsed: Partial<RuntimeSettings> = {};
  const vaultPath = optionalString(process.env.OBSIDIAN_VAULT_PATH);
  if (vaultPath) parsed.vaultPath = vaultPath.slice(0, 1024);
  const inboxDir = optionalString(process.env.OBSIDIAN_INBOX_DIR);
  if (inboxDir) parsed.inboxDir = inboxDir.slice(0, 512);
  const outDir = optionalString(process.env.OBSIDIAN_OUT_DIR);
  if (outDir) parsed.outDir = outDir.slice(0, 512);
  const rawDir = optionalString(process.env.OBSIDIAN_RAW_DIR);
  if (rawDir) parsed.rawDir = rawDir.slice(0, 512);
  const includeFolders = optionalString(process.env.OBSIDIAN_INCLUDE_FOLDERS);
  if (includeFolders) parsed.includeFolders = includeFolders;
  const excludeGlobs = optionalString(process.env.OBSIDIAN_EXCLUDE_GLOBS);
  if (excludeGlobs) parsed.excludeGlobs = excludeGlobs;
  const maxResults = process.env.OBSIDIAN_MAX_RESULTS
    ? optionalInt(Number(process.env.OBSIDIAN_MAX_RESULTS), 1, 50)
    : undefined;
  if (maxResults !== undefined) parsed.maxResults = maxResults;
  const budget = process.env.OBSIDIAN_SEARCH_BUDGET_CHARS
    ? optionalInt(Number(process.env.OBSIDIAN_SEARCH_BUDGET_CHARS), 500, 60000)
    : undefined;
  if (budget !== undefined) parsed.searchBudgetChars = budget;
  if (process.env.OBSIDIAN_SEMANTIC_SEARCH === "0") parsed.semanticSearch = false;
  if (process.env.OBSIDIAN_SEMANTIC_SEARCH === "1") parsed.semanticSearch = true;
  const model = optionalString(process.env.OBSIDIAN_EMBEDDING_MODEL);
  if (model) parsed.embeddingModel = model.slice(0, 200);
  const dtype = optionalString(process.env.OBSIDIAN_EMBEDDING_DTYPE);
  if (dtype) parsed.embeddingDtype = dtype.slice(0, 16);
  const idle = process.env.OBSIDIAN_EMBEDDING_IDLE_MINUTES
    ? optionalInt(Number(process.env.OBSIDIAN_EMBEDDING_IDLE_MINUTES), 0, 240)
    : undefined;
  if (idle !== undefined) parsed.embeddingIdleMinutes = idle;
  const apiUrl = optionalString(process.env.OBSIDIAN_API_URL);
  if (apiUrl) parsed.obsidianApiUrl = apiUrl.slice(0, 512);
  const apiKey = optionalString(process.env.OBSIDIAN_API_KEY);
  if (apiKey) {
    parsed.obsidianApiKey = apiKey.slice(0, 512);
    parsed.obsidianApiEnabled = true;
  }
  if (process.env.OBSIDIAN_API_ENABLED === "0") parsed.obsidianApiEnabled = false;
  if (process.env.OBSIDIAN_API_ENABLED === "1") parsed.obsidianApiEnabled = true;
  return parsed;
}

/** Settings the MCP server process runs with: defaults ← file ← env. */
export function parseSettingsFile(filePath: string = settingsMirrorPath()): RuntimeSettings {
  return { ...DEFAULTS, ...parseFile(filePath), ...parseEnv() };
}

/** Path of the mirror, re-exported so callers log one canonical location. */
export function mirrorPath(): string {
  return settingsMirrorPath();
}

/** Absolute path of the mirror for a custom Paseo home (tests). */
export function mirrorPathIn(home: string): string {
  return path.join(home, "plugins", "obsidian-bridge", "settings.json");
}
