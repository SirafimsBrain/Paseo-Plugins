import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import { sameStringArray } from "./agent-mcp-json";
import { mcpServerCommand } from "./mcp-launch";

/**
 * Direct MCP registration for OpenCode and Kilo (agent-config files).
 *
 * Why this exists (0.8.0): Paseo injects MCP servers into an OpenCode
 * session through OpenCode's runtime API (`PUT /api/experimental/mcp/:server`),
 * and that registration lives in OpenCode's in-memory per-directory
 * "location services". OpenCode evicts an idle location (observed TTL:
 * tens of minutes), which drops the runtime-registered server together
 * with its tools; Paseo only re-registers while a session is being
 * created, so a long-lived agent that keeps working across an eviction
 * loses every `memory-flash_*` tool for the rest of its life. The next
 * tool call then fails with the client-side error
 *
 *   No tool named "memory-flash_memory_save" is currently available.
 *
 * A server that lives in OpenCode's *config file* is not affected: the
 * config is re-read every time a location boots, so the server and its
 * tools come back by themselves after an eviction. Registering here
 * therefore makes the shared memory work in every OpenCode and Kilo
 * session on the machine — including the long-lived ones Paseo cannot
 * repair — and it heals the failure the runtime injection leaves behind.
 *
 * The two agents share the format (`mcp: { <name>: { type: "local",
 * command: [<node>, <entry>], enabled: true } }`), so one implementation
 * serves both; only the config directory and file names differ. Every
 * other key in the file is preserved and the write is atomic (temp file
 * + rename). A config file that is not plain JSON (e.g. one carrying
 * `//` comments) is never rewritten, because comments cannot be
 * round-tripped by a JSON writer; the plugin reports that instead.
 */

export const OPENCODE_MCP_SERVER_NAME = "memory-flash";

/**
 * Tool-fetch timeout written into the entry. OpenCode's default is 5 s,
 * which a slow start (SQLite contention on a busy machine) can exceed —
 * a timeout there costs the agent all of its memory tools for the rest
 * of the server's life, so the plugin asks for a more forgiving window.
 */
const TOOL_TIMEOUT_MS = 15000;

export interface OpencodeMcpStatus {
  /** Absolute path of the config file the plugin would write. */
  path: string;
  /** Whether the config file or its directory exists on this machine. */
  detected: boolean;
  /** Whether memory-flash is registered in the file. */
  installed: boolean;
  /** True when the registered entry matches the current launch command. */
  upToDate: boolean | null;
  /** Registered command, when installed. */
  command: string | null;
  /** Registered args, when installed. */
  args: string[] | null;
}

interface McpEntry {
  type?: unknown;
  command?: unknown;
  enabled?: unknown;
  timeout?: unknown;
}

interface ConfigDocument {
  mcp?: Record<string, unknown>;
}

interface AgentTarget {
  /** Display label, used in error messages. */
  label: string;
  /** Config directory (`~/.config/<app>` or `$XDG_CONFIG_HOME/<app>`). */
  configDir(): string;
  /** Candidate config file names, preferred order. */
  fileNames: string[];
}

function configDir(app: string): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? "").trim();
  const base = xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, app);
}

const OPENCODE: AgentTarget = {
  label: "OpenCode",
  configDir: () => configDir("opencode"),
  // `opencode.json` first: it is the file the plugin creates when neither
  // exists, and OpenCode's config discovery looks for both names.
  fileNames: ["opencode.json", "opencode.jsonc"],
};

const KILO: AgentTarget = {
  label: "Kilo",
  configDir: () => configDir("kilo"),
  // Kilo ships `kilo.jsonc` by convention, so an existing one is found
  // before the plugin would create a plain `kilo.json`.
  fileNames: ["kilo.jsonc", "kilo.json"],
};

type LoadResult =
  | { ok: true; target: string; document: ConfigDocument; exists: boolean }
  | { ok: false; target: string; error: string };

function readDocument(target: string): { ok: true; document: ConfigDocument } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("file is not a JSON object");
    }
    return { ok: true, document: parsed as ConfigDocument };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/**
 * Picks the file to read and write.
 *
 * An existing file that parses as plain JSON wins. A file that exists but
 * cannot be parsed as JSON (comments, syntax error) is skipped rather than
 * overwritten — losing a hand-written comment is worse than landing in the
 * sibling file. When no candidate exists, the first name is created.
 */
function resolveTarget(agent: AgentTarget): LoadResult {
  const dir = agent.configDir();
  const candidates = agent.fileNames.map((name) => path.join(dir, name));
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const loaded = readDocument(candidate);
    if (loaded.ok) return { ok: true, target: candidate, document: loaded.document, exists: true };
    failures.push(`${candidate} (${loaded.error})`);
  }
  if (failures.length > 0) {
    return {
      ok: false,
      target: candidates[0]!,
      error: `${failures.join("; ")} cannot be parsed and is left untouched — edit it manually or fix the syntax`,
    };
  }
  return { ok: true, target: candidates[0]!, document: {}, exists: false };
}

function writeDocument(target: string, document: ConfigDocument): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode : undefined;
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  if (mode !== undefined) fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
}

function isEntry(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && typeof (entry as McpEntry).type === "string";
}

function fromEntry(entry: unknown): { command: string; args: string[] } | null {
  const candidate = entry as McpEntry | undefined;
  if (candidate?.type !== "local" || !Array.isArray(candidate.command) || candidate.command.length === 0) {
    return null;
  }
  const [command, ...args] = (candidate.command as unknown[]).map(String);
  return { command: command ?? "", args };
}

function toEntry(launch: { command: string; args: string[] }): McpEntry {
  return {
    type: "local",
    command: [launch.command, ...launch.args],
    enabled: true,
    timeout: TOOL_TIMEOUT_MS,
  };
}

/** Current registration state of memory-flash in the agent's config file. */
export function opencodeConfigStatus(agent: AgentTarget): OpencodeMcpStatus {
  const launch = mcpServerCommand();
  const resolved = resolveTarget(agent);
  const target = resolved.target;
  const detected = fs.existsSync(target) || fs.existsSync(agent.configDir());
  if (!resolved.ok) {
    return { path: target, detected, installed: false, upToDate: null, command: null, args: null };
  }
  const entry = resolved.document.mcp?.[OPENCODE_MCP_SERVER_NAME];
  const installed = isEntry(entry);
  const registered = installed ? fromEntry(entry) : null;
  const upToDate = registered
    ? registered.command === launch.command && sameStringArray(registered.args, launch.args)
    : null;
  return {
    path: target,
    detected,
    installed,
    upToDate,
    command: registered?.command ?? null,
    args: registered?.args ?? null,
  };
}

/** Adds (or refreshes) the memory-flash entry, preserving every other key. */
export function registerOpencodeConfig(agent: AgentTarget): { ok: boolean; error: string | null } {
  const resolved = resolveTarget(agent);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const entry = toEntry(mcpServerCommand());
    const mcp = { ...(resolved.document.mcp ?? {}), [OPENCODE_MCP_SERVER_NAME]: entry };
    writeDocument(resolved.target, { ...resolved.document, mcp });
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/** Removes the memory-flash entry; every other key is left untouched. */
export function unregisterOpencodeConfig(agent: AgentTarget): { ok: boolean; error: string | null } {
  const resolved = resolveTarget(agent);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const mcp = resolved.document.mcp;
    if (!mcp || !(OPENCODE_MCP_SERVER_NAME in mcp)) {
      // Nothing registered — already in the desired state.
      return { ok: true, error: null };
    }
    if (!resolved.exists) return { ok: true, error: null };
    const remaining = { ...mcp };
    delete remaining[OPENCODE_MCP_SERVER_NAME];
    const next: ConfigDocument = { ...resolved.document };
    if (Object.keys(remaining).length > 0) next.mcp = remaining;
    else delete next.mcp;
    writeDocument(resolved.target, next);
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/** Absolute path of the OpenCode config file the plugin writes. */
export function opencodeConfigPath(): string {
  return resolveTarget(OPENCODE).target;
}

/** Absolute path of the Kilo config file the plugin writes. */
export function kiloConfigPath(): string {
  return resolveTarget(KILO).target;
}

/** Current registration state of memory-flash in OpenCode's config. */
export function opencodeMcpStatus(): OpencodeMcpStatus {
  return opencodeConfigStatus(OPENCODE);
}

/** Adds (or refreshes) the memory-flash entry in OpenCode's config. */
export function registerOpencodeMcp(): { ok: boolean; error: string | null } {
  return registerOpencodeConfig(OPENCODE);
}

/** Removes the memory-flash entry from OpenCode's config. */
export function unregisterOpencodeMcp(): { ok: boolean; error: string | null } {
  return unregisterOpencodeConfig(OPENCODE);
}

/** Current registration state of memory-flash in Kilo's config. */
export function kiloMcpStatus(): OpencodeMcpStatus {
  return opencodeConfigStatus(KILO);
}

/** Adds (or refreshes) the memory-flash entry in Kilo's config. */
export function registerKiloMcp(): { ok: boolean; error: string | null } {
  return registerOpencodeConfig(KILO);
}

/** Removes the memory-flash entry from Kilo's config. */
export function unregisterKiloMcp(): { ok: boolean; error: string | null } {
  return unregisterOpencodeConfig(KILO);
}
