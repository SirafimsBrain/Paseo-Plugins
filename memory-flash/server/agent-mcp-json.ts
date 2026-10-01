import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { mcpServerCommand } from "./mcp-launch";

/**
 * Shared implementation for agents that keep stdio MCP servers in a
 * JSON file with a top-level `mcpServers` object (Cline, Cursor, …).
 *
 * The file format is identical for every such agent; only the entry
 * shape differs — Cline nests the launch config under `transport`,
 * Cursor keeps it flat. Callers provide the shape adapters; everything
 * else (atomic write, preservation of foreign servers, refusal to
 * overwrite a corrupted file) is shared.
 */

export interface JsonMcpLaunch {
  command: string;
  args: string[];
}

export interface JsonMcpShape {
  /** Absolute path of the agent's MCP settings file. */
  path(): string;
  /** Server name under `mcpServers`. */
  serverName: string;
  /** True when the entry object represents a (possibly incomplete) registration. */
  isEntry: (entry: unknown) => boolean;
  /** Reads the launch config back from an entry, or null when unparseable. */
  fromEntry: (entry: unknown) => JsonMcpLaunch | null;
  /** Wraps the launch config into the agent's entry shape. */
  toEntry: (launch: JsonMcpLaunch) => unknown;
}

export interface JsonMcpStatus {
  /** Absolute path of the agent's MCP settings file. */
  path: string;
  /** Whether the settings file exists on this machine. */
  detected: boolean;
  /** Whether memory-flash is registered in the file. */
  installed: boolean;
  /** True when the registered entry matches the current launch command. */
  upToDate: boolean | null;
  /** Registered command, when parseable. */
  command: string | null;
  /** Registered args, when parseable. */
  args: string[] | null;
}

type LoadResult =
  | { ok: true; settings: { mcpServers?: Record<string, unknown> } }
  | { ok: false; error: string };

function loadSettings(target: string): LoadResult {
  if (!fs.existsSync(target)) return { ok: true, settings: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("file is not a JSON object");
    }
    return { ok: true, settings: parsed as { mcpServers?: Record<string, unknown> } };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `${target} exists but cannot be parsed (${message}); fix or remove it manually` };
  }
}

function writeSettings(target: string, settings: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, target);
}

export function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Current registration state of memory-flash in the agent's settings file. */
export function jsonMcpStatus(shape: JsonMcpShape): JsonMcpStatus {
  const launch = mcpServerCommand();
  const target = shape.path();
  const loaded = loadSettings(target);
  const entry = loaded.ok ? loaded.settings.mcpServers?.[shape.serverName] : undefined;
  const installed = shape.isEntry(entry);
  const registered = installed ? shape.fromEntry(entry) : null;
  const upToDate = registered
    ? registered.command === launch.command && sameStringArray(registered.args, launch.args)
    : null;
  return {
    path: target,
    detected: fs.existsSync(target),
    installed,
    upToDate,
    command: registered?.command ?? null,
    args: registered?.args ?? null,
  };
}

/** Adds (or refreshes) the memory-flash entry, preserving other servers. */
export function registerJsonMcp(shape: JsonMcpShape): { ok: boolean; error: string | null } {
  const loaded = loadSettings(shape.path());
  if (!loaded.ok) return { ok: false, error: loaded.error };
  try {
    const launch = mcpServerCommand();
    const servers = { ...(loaded.settings.mcpServers ?? {}) };
    servers[shape.serverName] = shape.toEntry(launch);
    writeSettings(shape.path(), { ...loaded.settings, mcpServers: servers });
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/** Removes the memory-flash entry; other servers are left untouched. */
export function unregisterJsonMcp(shape: JsonMcpShape): { ok: boolean; error: string | null } {
  const loaded = loadSettings(shape.path());
  if (!loaded.ok) return { ok: false, error: loaded.error };
  try {
    const servers = loaded.settings.mcpServers;
    if (!servers || !(shape.serverName in servers)) {
      // Nothing registered — already in the desired state.
      return { ok: true, error: null };
    }
    const remaining = { ...servers };
    delete remaining[shape.serverName];
    writeSettings(shape.path(), { ...loaded.settings, mcpServers: remaining });
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}
