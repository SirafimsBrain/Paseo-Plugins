import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandCategory, CommandDefinition, HistoryEntry } from "../shared/commands";

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured
    : path.join(os.homedir(), ".paseo");
}

/** `$PASEO_HOME/plugins/command-center` — created lazily on first write. */
export function storeRoot(): string {
  return path.join(paseoHome(), "plugins", "command-center");
}

function commandsFile(): string {
  return path.join(storeRoot(), "commands.json");
}

function historyFile(): string {
  return path.join(storeRoot(), "history.json");
}

function categoriesFile(): string {
  return path.join(storeRoot(), "categories.json");
}

function writeJsonAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, target);
}

function readJsonArray<T>(target: string): T[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function loadCommands(): CommandDefinition[] {
  return readJsonArray<CommandDefinition>(commandsFile());
}

export function saveCommands(commands: CommandDefinition[]): void {
  writeJsonAtomic(commandsFile(), commands);
}

export function loadHistory(): HistoryEntry[] {
  return readJsonArray<HistoryEntry>(historyFile());
}

export function appendHistory(entries: HistoryEntry[], entry: HistoryEntry, limit = 50): HistoryEntry[] {
  const next = [entry, ...entries].slice(0, limit);
  writeJsonAtomic(historyFile(), next);
  return next;
}

export function clearHistoryStore(): void {
  try {
    fs.rmSync(historyFile(), { force: true });
  } catch {
    // Already gone.
  }
}

/**
 * Category labels live in their own file so a command keep no stale labels:
 * the stored list is the single source of truth for the picker, and command
 * `category` values that are not in the list are surfaced as "orphan" via
 * `collectImplicitCategories` (e.g. after a manual edit of commands.json).
 */
export function loadCategories(): CommandCategory[] {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(fs.readFileSync(categoriesFile(), "utf-8"));
    } catch {
      return [];
    }
  })();
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const categories: CommandCategory[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    if (name.length === 0 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    categories.push({
      name,
      sortKey: typeof record["sortKey"] === "string" ? record["sortKey"] : name.toLowerCase(),
    });
  }
  return categories;
}

export function saveCategories(categories: CommandCategory[]): void {
  writeJsonAtomic(categoriesFile(), categories);
}

/** Lowercased category names referenced by commands but missing from the store. */
export function collectImplicitCategories(commands: CommandDefinition[]): string[] {
  const stored = new Set(loadCategories().map((category) => category.sortKey));
  const implicit = new Set<string>();
  for (const command of commands) {
    const value = typeof command.category === "string" ? command.category.trim() : "";
    if (value.length > 0 && !stored.has(value.toLowerCase())) implicit.add(value.toLowerCase());
  }
  return [...implicit].sort();
}
