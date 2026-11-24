import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import { mcpServerCommand } from "./mcp-launch";
import { isPluginOwnedLaunch } from "./owned-entry";

/**
 * Direct MCP registration for Cline.
 *
 * Cline takes the session's `mcpServers` payload but never spawns a stdio
 * server from it; stdio servers come from its own settings file,
 * `~/.cline/data/settings/cline_mcp_settings.json` (shape
 * `{ mcpServers: { <name>: { transport: { type, command, args } } } }`).
 * Measured on Paseo 0.15.4 with this plugin: a Cline agent saw the skill and
 * listed no `obsidian_*` tool at all until the entry existed here, so this is
 * the same class of gap that made the OpenCode config registration necessary
 * (0.5.4).
 *
 * The file is written atomically, every other server is preserved, and a file
 * that does not parse is never overwritten — the plugin reports it instead.
 */

export const CLINE_MCP_SERVER_NAME = "obsidian-bridge";

/** Absolute path of Cline's MCP settings file. */
export function clineSettingsPath(): string {
  return path.join(os.homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
}

/** Cline's user directory; resolved per call so tests and `$HOME` changes work. */
function clineHome(): string {
  return path.join(os.homedir(), ".cline");
}

export interface ClineMcpStatus {
  path: string;
  /** Cline's home directory exists on this machine. */
  detected: boolean;
  installed: boolean;
  upToDate: boolean | null;
  command: string | null;
  args: string[] | null;
  /** Why the file could not be read, when it is present but unparseable. */
  error: string | null;
}

interface ClineTransport {
  type?: unknown;
  command?: unknown;
  args?: unknown;
}

interface ClineEntry {
  transport?: ClineTransport;
}

interface ClineDocument {
  mcpServers?: Record<string, unknown>;
}

function readDocument(target: string): { ok: true; document: ClineDocument; exists: boolean } | { ok: false; error: string } {
  if (!fs.existsSync(target)) return { ok: true, document: {}, exists: false };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("file is not a JSON object");
    }
    return { ok: true, document: parsed as ClineDocument, exists: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function writeDocument(target: string, document: ClineDocument): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode : undefined;
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  if (mode !== undefined) fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
}

function toEntry(launch: { command: string; args: string[] }): ClineEntry {
  return { transport: { type: "stdio", command: launch.command, args: launch.args } };
}

function fromEntry(entry: unknown): { command: string; args: string[] } | null {
  const transport = (entry as ClineEntry | undefined)?.transport;
  if (typeof transport?.command !== "string" || !Array.isArray(transport.args)) return null;
  return { command: transport.command, args: (transport.args as unknown[]).map(String) };
}

export function clineMcpStatus(): ClineMcpStatus {
  const launch = mcpServerCommand();
  const target = clineSettingsPath();
  const detected = fs.existsSync(clineHome());
  const loaded = readDocument(target);
  if (!loaded.ok) {
    return { path: target, detected, installed: false, upToDate: null, command: null, args: null, error: loaded.error };
  }
  const entry = loaded.document.mcpServers?.[CLINE_MCP_SERVER_NAME];
  const registered = entry === undefined ? null : fromEntry(entry);
  return {
    path: target,
    detected,
    installed: registered !== null,
    upToDate:
      registered === null
        ? null
        : registered.command === launch.command &&
          registered.args.length === launch.args.length &&
          registered.args.every((value, index) => value === launch.args[index]) &&
          fs.existsSync(registered.args[0] ?? ""),
    command: registered?.command ?? null,
    args: registered?.args ?? null,
    error: null,
  };
}

/** Adds (or refreshes) the entry, preserving every other server. */
export function registerClineMcp(): { ok: boolean; error: string | null } {
  const target = clineSettingsPath();
  if (!fs.existsSync(clineHome())) {
    return { ok: false, error: `Cline is not installed (${clineHome()} is missing)` };
  }
  const loaded = readDocument(target);
  if (!loaded.ok) {
    return { ok: false, error: `${target}: ${loaded.error}; the file is left untouched` };
  }
  try {
    const servers = { ...(loaded.document.mcpServers ?? {}), [CLINE_MCP_SERVER_NAME]: toEntry(mcpServerCommand()) };
    writeDocument(target, { ...loaded.document, mcpServers: servers });
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface ClineRemoval {
  /** One human-readable line per removed registration. */
  removed: string[];
  error: string | null;
}

/** Removes every server `shouldRemove` selects; other servers are left untouched. */
function removeEntries(
  shouldRemove: (name: string, entry: unknown) => boolean,
): ClineRemoval {
  const target = clineSettingsPath();
  const loaded = readDocument(target);
  if (!loaded.ok) return { removed: [], error: `${target}: ${loaded.error}` };
  if (!loaded.exists) return { removed: [], error: null };
  const servers = loaded.document.mcpServers;
  if (!servers) return { removed: [], error: null };
  const names = Object.keys(servers).filter((name) => shouldRemove(name, servers[name]));
  if (names.length === 0) return { removed: [], error: null };
  try {
    const remaining = { ...servers };
    for (const name of names) delete remaining[name];
    const next: ClineDocument = { ...loaded.document };
    if (Object.keys(remaining).length > 0) next.mcpServers = remaining;
    else delete next.mcpServers;
    writeDocument(target, next);
    return {
      removed: names.map((name) => `Cline mcpServers.${name}: ${target}`),
      error: null,
    };
  } catch (cause) {
    return { removed: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Removes the entry by name; other servers are left untouched. */
export function unregisterClineMcp(): { ok: boolean; error: string | null } {
  const result = removeEntries((name) => name === CLINE_MCP_SERVER_NAME);
  return { ok: result.error === null, error: result.error };
}

/**
 * Removes this plugin's registrations by name or by launch path — the path test
 * catches an entry a renamed version left under its old name.
 */
export function pruneClineMcp(): ClineRemoval {
  return removeEntries((name, entry) => {
    if (name === CLINE_MCP_SERVER_NAME) return true;
    const launch = fromEntry(entry);
    return launch !== null && isPluginOwnedLaunch(launch.command, launch.args);
  });
}
