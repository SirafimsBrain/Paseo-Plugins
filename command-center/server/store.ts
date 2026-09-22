import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";

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
