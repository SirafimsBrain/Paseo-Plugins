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
  indexingEnabled: true,
  includeFolders: "",
  excludeGlobs: ".obsidian/**, .trash/**, .git/**, .smart-env/**",
  ftsStemming: false,
  reconcileMinutes: 10,
  maxResults: 10,
  searchBudgetChars: 8000,
  snippetChars: 600,
  readOnly: true,
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
    return parsed;
  } catch {
    return {};
  }
}

function parseEnv(): Partial<RuntimeSettings> {
  const parsed: Partial<RuntimeSettings> = {};
  const vaultPath = optionalString(process.env.OBSIDIAN_VAULT_PATH);
  if (vaultPath) parsed.vaultPath = vaultPath.slice(0, 1024);
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
