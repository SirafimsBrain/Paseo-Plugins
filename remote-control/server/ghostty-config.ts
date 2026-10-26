// Ghostty config import (stage B1, orca PR #1001 scheme).
//
// discovery → parser → mapper → preview → apply. Pure Node module so it can be
// unit-tested without a daemon and reused by the console REST routes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ghosttyImportPreviewSchema, ghosttySettingsSchema } from "../shared/ghostty-settings";
import type { GhosttyImportPreview, GhosttySettings } from "../shared/ghostty-settings";

export interface GhosttyConfigEntry {
  /** Raw key as written in the file (lower-cased, trimmed). */
  key: string;
  /** Raw value (trimmed, includes everything after the first '='). */
  value: string;
  /** 1-based source line number for diagnostics. */
  line: number;
  /** Source file the entry came from. */
  source: string;
}

export interface ParsedGhosttyConfig {
  entries: GhosttyConfigEntry[];
  errors: string[];
  /** Files actually read, in order. */
  files: string[];
}

export interface GhosttyDiscoveryOptions {
  /** Override the home directory (tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Override XDG_CONFIG_HOME. */
  xdgConfigHome?: string;
  /** Override platform. */
  platform?: NodeJS.Platform;
}

/**
 * Candidate config paths in priority order. The first one that exists wins;
 * `config-file` directives inside the file pull in further files.
 */
export function discoverGhosttyConfigPaths(options: GhosttyDiscoveryOptions = {}): string[] {
  const home = options.homeDir ?? os.homedir();
  const xdg = options.xdgConfigHome ?? (options.homeDir ? undefined : process.env.XDG_CONFIG_HOME);
  const platform = options.platform ?? process.platform;
  const candidates: string[] = [];
  if (xdg && xdg.length > 0) {
    candidates.push(path.join(xdg, "ghostty", "config"));
  }
  candidates.push(path.join(home, ".config", "ghostty", "config"));
  if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
    );
  }
  candidates.push(path.join(home, ".ghostty", "config"));
  // De-duplicate while preserving order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

export function findGhosttyConfigPath(options: GhosttyDiscoveryOptions = {}): string | null {
  for (const candidate of discoverGhosttyConfigPaths(options)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not present — try next
    }
  }
  return null;
}

/**
 * Parse a Ghostty config file. Supports:
 * - `#` and `//` comments (to end of line)
 * - blank lines
 * - `key = value` and `key=value`
 * - `config-file = <path>` includes (relative to the including file's dir)
 *
 * Repeated keys are preserved (e.g. `palette = 0=...`).
 */
export function parseGhosttyConfig(
  filePath: string,
  options: { visited?: Set<string>; maxDepth?: number } = {},
): ParsedGhosttyConfig {
  const visited = options.visited ?? new Set<string>();
  const maxDepth = options.maxDepth ?? 8;
  const resolved = path.resolve(filePath);
  const result: ParsedGhosttyConfig = { entries: [], errors: [], files: [] };
  if (visited.has(resolved)) {
    result.errors.push(`config include cycle detected at ${resolved}`);
    return result;
  }
  if (maxDepth <= 0) {
    result.errors.push(`config include depth exceeded at ${resolved}`);
    return result;
  }
  let text: string;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (cause) {
    result.errors.push(`cannot read ${resolved}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return result;
  }
  visited.add(resolved);
  result.files.push(resolved);
  const baseDir = path.dirname(resolved);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const stripped = stripComment(raw).trim();
    if (stripped.length === 0) continue;
    const eq = stripped.indexOf("=");
    if (eq < 0) {
      result.errors.push(`${resolved}:${i + 1}: expected 'key = value', got '${stripped}'`);
      continue;
    }
    const key = stripped.slice(0, eq).trim().toLowerCase();
    const value = stripped.slice(eq + 1).trim();
    if (key.length === 0) {
      result.errors.push(`${resolved}:${i + 1}: empty key`);
      continue;
    }
    if (key === "config-file") {
      const includePath = path.isAbsolute(value) ? value : path.join(baseDir, value);
      const nested = parseGhosttyConfig(includePath, {
        visited: new Set(visited),
        maxDepth: maxDepth - 1,
      });
      result.entries.push(...nested.entries);
      result.errors.push(...nested.errors);
      result.files.push(...nested.files.filter((f) => !result.files.includes(f)));
      continue;
    }
    result.entries.push({ key, value, line: i + 1, source: resolved });
  }
  return result;
}

function stripComment(line: string): string {
  // Ghostty uses '#' for comments, but '#' also appears inside hex colour
  // values (e.g. `background = #1e1e2e`). A '#' starts a comment only when
  // it is not immediately followed by a hex colour (3/6/8 hex digits).
  let cut = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "#" && !isHexColour(line, i + 1)) {
      // also require preceding whitespace or start-of-line to avoid cutting
      // into the middle of a token
      if (i === 0 || /\s/.test(line[i - 1])) {
        cut = i;
        break;
      }
    }
    if (ch === "/" && line[i + 1] === "/" && (i === 0 || /\s/.test(line[i - 1]))) {
      cut = i;
      break;
    }
  }
  return cut >= 0 ? line.slice(0, cut) : line;
}

function isHexColour(text: string, start: number): boolean {
  let j = start;
  while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j += 1;
  const len = j - start;
  if (len !== 3 && len !== 6 && len !== 8) return false;
  // must be terminated by whitespace or end-of-line
  return j === text.length || /\s/.test(text[j]);
}

/**
 * Map raw config entries onto the typed settings object. Unknown keys are
 * collected (de-duplicated, in first-seen order) into `ignored`.
 */
export function mapGhosttySettings(entries: GhosttyConfigEntry[]): {
  settings: GhosttySettings;
  ignored: string[];
} {
  const settings: Record<string, unknown> = {};
  const ignoredSet = new Set<string>();
  const palette: string[] = [];
  const padding: { top?: number; right?: number; bottom?: number; left?: number } = {};

  const markIgnored = (key: string): void => {
    ignoredSet.add(key);
  };

  for (const entry of entries) {
    const { key, value } = entry;
    switch (key) {
      case "font-family":
        settings.fontFamily = value;
        break;
      case "font-size": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) settings.fontSize = n;
        else markIgnored(key);
        break;
      }
      case "theme":
        settings.theme = value;
        break;
      case "background":
        settings.background = value;
        break;
      case "foreground":
        settings.foreground = value;
        break;
      case "palette": {
        // Ghostty: `palette = N=RRGGBB` (or `N=#RRGGBB`).
        palette.push(value);
        break;
      }
      case "cursor-style": {
        const normalized = value.toLowerCase();
        if (normalized === "block" || normalized === "bar" || normalized === "underline" || normalized === "underline-block") {
          settings.cursorStyle = normalized === "underline-block" ? "underline" : normalized;
        } else {
          markIgnored(key);
        }
        break;
      }
      case "cursor-blink":
        if (value === "true" || value === "1") settings.cursorBlink = true;
        else if (value === "false" || value === "0") settings.cursorBlink = false;
        else markIgnored(key);
        break;
      case "cursor-color":
        settings.cursorColor = value;
        break;
      case "scrollback-limit": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) settings.scrollback = Math.trunc(n);
        else markIgnored(key);
        break;
      }
      case "window-padding-x": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) {
          padding.left = n;
          padding.right = n;
        } else markIgnored(key);
        break;
      }
      case "window-padding-y": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) {
          padding.top = n;
          padding.bottom = n;
        } else markIgnored(key);
        break;
      }
      case "window-padding": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) {
          padding.top = n;
          padding.right = n;
          padding.bottom = n;
          padding.left = n;
        } else markIgnored(key);
        break;
      }
      case "window-padding-color":
      case "window-padding-balance":
      case "selection-word-chars":
        // Explicitly dropped by orca's review; reported as ignored.
        markIgnored(key);
        break;
      default:
        markIgnored(key);
        break;
    }
  }

  if (palette.length > 0) settings.palette = palette;
  if (Object.keys(padding).length > 0) settings.windowPadding = padding;

  // Validate against the schema; drop invalid fields rather than throwing.
  const parsed = ghosttySettingsSchema.safeParse(settings);
  const validated = parsed.success ? parsed.data : {};
  // Track which keys ended up dropped by validation as ignored too.
  for (const k of Object.keys(settings)) {
    if (!(k in validated)) markIgnored(k);
  }

  return {
    settings: validated,
    ignored: [...ignoredSet],
  };
}

export interface GhosttyImportPreviewResult {
  found: boolean;
  path: string | null;
  settings: GhosttySettings;
  ignored: string[];
  errors: string[];
}

export function previewGhosttyImport(options: GhosttyDiscoveryOptions = {}): GhosttyImportPreviewResult {
  const foundPath = findGhosttyConfigPath(options);
  if (foundPath === null) {
    return { found: false, path: null, settings: {}, ignored: [], errors: [] };
  }
  const parsed = parseGhosttyConfig(foundPath);
  const mapped = mapGhosttySettings(parsed.entries);
  return {
    found: true,
    path: foundPath,
    settings: mapped.settings,
    ignored: mapped.ignored,
    errors: parsed.errors,
  };
}

// Persistence (minimal, file-based; replaced by SQLite settings in stage D1).
function dataDir(): string {
  const home = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
  const dir = path.join(home, "plugins", "remote-control");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

export function settingsFilePath(): string {
  return path.join(dataDir(), "ghostty-settings.json");
}

export function loadGhosttySettings(): GhosttySettings {
  try {
    const raw = fs.readFileSync(settingsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = ghosttySettingsSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

export function applyGhosttySettings(settings: GhosttySettings): void {
  const validated = ghosttySettingsSchema.parse(settings);
  fs.writeFileSync(settingsFilePath(), JSON.stringify(validated, null, 2), "utf8");
}

export function ghosttySettingsToPreview(settings: GhosttySettings): GhosttyImportPreview {
  return ghosttyImportPreviewSchema.parse({
    found: true,
    path: null,
    settings,
    ignored: [],
    errors: [],
  });
}
