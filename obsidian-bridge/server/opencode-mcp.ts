import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import { mcpServerCommand } from "./mcp-launch";

/**
 * Direct MCP registration in the agent's own config file (OpenCode, Kilo).
 *
 * Why this exists (0.5.4): Paseo 0.15.x refuses to open an OpenCode agent that
 * carries custom MCP servers when a shared OpenCode service is registered
 * ("Custom OpenCode MCP servers or process environment require an isolated
 * server…"), so the daemon reports `supportsMcpServers: false` for that agent,
 * `agent.create.before` cannot save a server, and the launch-only contribution
 * is refused. The attached-tools fallback is not surfaced by OpenCode either,
 * so the agent saw no Obsidian tools at all.
 *
 * A server in the agent's *config file* is unaffected: OpenCode re-reads it
 * whenever a location boots, so the tools exist without any Paseo-side
 * injection, survive the idle-runtime release, and reach sessions Paseo never
 * re-opens. Every other key in the file is preserved and the write is atomic
 * (temp file + rename). A file that is not plain JSON (comments) is never
 * rewritten — comments cannot be round-tripped by a JSON writer, so the plugin
 * reports that instead of damaging the file.
 */

export const CONFIG_MCP_SERVER_NAME = "obsidian-bridge";

/** Tool-fetch window: a cold MCP start can exceed OpenCode's 5 s default. */
const TOOL_TIMEOUT_MS = 20000;

export interface ConfigMcpStatus {
  /** Absolute path of the config file the plugin would write. */
  path: string;
  /** Whether the config file or its directory exists on this machine. */
  detected: boolean;
  /** Whether the plugin's server is registered in the file. */
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
  label: string;
  configDir(): string;
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
  fileNames: ["opencode.json", "opencode.jsonc"],
};

const KILO: AgentTarget = {
  label: "Kilo",
  configDir: () => configDir("kilo"),
  fileNames: ["kilo.jsonc", "kilo.json"],
};

type Resolved =
  | { ok: true; target: string; document: ConfigDocument; exists: boolean }
  | { ok: false; target: string; error: string };

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function readDocument(target: string): { ok: true; document: ConfigDocument } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("file is not a JSON object");
    }
    return { ok: true, document: parsed as ConfigDocument };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Picks the file to read and write: an existing file that parses as plain JSON
 * wins; a file that cannot be parsed (comments, syntax error) is left untouched
 * rather than overwritten; with no candidates the first name is created.
 */
function resolveTarget(agent: AgentTarget): Resolved {
  const candidates = agent.fileNames.map((name) => path.join(agent.configDir(), name));
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
      error: `${failures.join("; ")} cannot be parsed and is left untouched — fix its syntax or remove it`,
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

/** Registration state of this plugin in one agent's config file. */
export function configStatus(agent: AgentTarget): ConfigMcpStatus {
  const launch = mcpServerCommand();
  const resolved = resolveTarget(agent);
  const target = resolved.target;
  const detected = fs.existsSync(target) || fs.existsSync(agent.configDir());
  if (!resolved.ok) {
    return { path: target, detected, installed: false, upToDate: null, command: null, args: null };
  }
  const entry = resolved.document.mcp?.[CONFIG_MCP_SERVER_NAME];
  const installed = isEntry(entry);
  const registered = installed ? fromEntry(entry) : null;
  const upToDate = registered
    ? registered.command === launch.command && sameStrings(registered.args, launch.args)
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

/** Adds (or refreshes) the entry, preserving every other key. */
export function registerConfig(agent: AgentTarget): { ok: boolean; error: string | null } {
  const resolved = resolveTarget(agent);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const mcp = { ...(resolved.document.mcp ?? {}), [CONFIG_MCP_SERVER_NAME]: toEntry(mcpServerCommand()) };
    writeDocument(resolved.target, { ...resolved.document, mcp });
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Removes the entry; every other key is left untouched. */
export function unregisterConfig(agent: AgentTarget): { ok: boolean; error: string | null } {
  const resolved = resolveTarget(agent);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const mcp = resolved.document.mcp;
    if (!mcp || !(CONFIG_MCP_SERVER_NAME in mcp)) return { ok: true, error: null };
    if (!resolved.exists) return { ok: true, error: null };
    const remaining = { ...mcp };
    delete remaining[CONFIG_MCP_SERVER_NAME];
    const next: ConfigDocument = { ...resolved.document };
    if (Object.keys(remaining).length > 0) next.mcp = remaining;
    else delete next.mcp;
    writeDocument(resolved.target, next);
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function opencodeMcpStatus(): ConfigMcpStatus {
  return configStatus(OPENCODE);
}

export function registerOpencodeMcp(): { ok: boolean; error: string | null } {
  return registerConfig(OPENCODE);
}

export function unregisterOpencodeMcp(): { ok: boolean; error: string | null } {
  return unregisterConfig(OPENCODE);
}

export function kiloMcpStatus(): ConfigMcpStatus {
  return configStatus(KILO);
}

export function registerKiloMcp(): { ok: boolean; error: string | null } {
  return registerConfig(KILO);
}

export function unregisterKiloMcp(): { ok: boolean; error: string | null } {
  return unregisterConfig(KILO);
}

/** Absolute path of the OpenCode config file the plugin writes. */
export function opencodeConfigPath(): string {
  return resolveTarget(OPENCODE).target;
}

/**
 * Whether the config-file registration already covers an agent of this
 * provider, which makes the launch-only contribution unnecessary (and harmful:
 * it is refused by the shared-service check in Paseo 0.15.x).
 */
export function agentConfigCoversProvider(provider: string): { covered: boolean; path: string | null } {
  const base = provider.split("/")[0] ?? provider;
  const status = base === "opencode" ? opencodeMcpStatus() : base === "kilo" ? kiloMcpStatus() : null;
  if (!status) return { covered: false, path: null };
  return { covered: status.installed && status.upToDate === true, path: status.path };
}
