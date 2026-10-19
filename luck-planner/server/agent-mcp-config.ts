/**
 * Direct MCP registration in the agents' own config files (stage D4).
 *
 * Why this exists. Paseo injects the MCP server into an agent through the
 * `agent.create` hook, i.e. it lands in the *session* payload. Two provider
 * behaviours make that fragile:
 *
 * 1. **OpenCode and Kilo** keep their session registrations in memory, per
 *    directory ("location services"), and evict an idle location — which
 *    takes the server and all its tools with it. Paseo re-registers only
 *    while a session is being created, so a long-lived agent loses every
 *    `luck-planner_*` tool for the rest of its life, while the MCP server
 *    itself is perfectly healthy. A server that lives in the agent's *config
 *    file* is not affected: the config is re-read every time a location
 *    boots, so the tools come back by themselves.
 * 2. **Cline, Cursor and Codex CLI** are terminal agents that do not
 *    connect stdio MCP servers delivered through an orchestrator's session
 *    at all — for them a config-file entry is the only way in.
 *
 * A second, subtler reason (measured on OpenCode, the memory-flash lesson):
 * after an eviction the *dead* session entry still owns the server's name in
 * the session, so it shadows the healthy config-file server and every call
 * fails. So when a config file already carries a current registration, the
 * session-level injection is **skipped** — the config entry wins on every
 * dimension: it survives eviction, reconnects at every location boot, and
 * reaches the sessions Paseo never touches.
 *
 * The rules the writers follow, in every format:
 *
 * - **Explicit, per agent.** The plugin never writes these files by itself:
 *   they change the behaviour of *every* session of that agent on the
 *   machine, so it is a button in the settings screen, per target and one
 *   for all of them.
 * - **Foreign content is preserved.** Only the plugin's own entry is added,
 *   replaced or removed; every other key, server, table and comment stays.
 * - **A broken file is never rewritten.** A config that does not parse as
 *   plain JSON (a `//` comment, a syntax error) is reported, not
 *   overwritten — losing a hand-written comment is worse than not
 *   registering.
 * - **Atomic writes.** Temp file plus rename, so a reader never sees a
 *   half-written config, and the file's mode is kept.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import { mcpServerCommand } from "./mcp-launch";

/** The name the server is registered under — the tool-name prefix. */
export const AGENT_MCP_SERVER_NAME = "luck-planner";

/**
 * Tool-fetch timeout written into the OpenCode/Kilo entry. Their default is
 * 5 s, which a slow start (SQLite contention on a busy machine) can exceed —
 * and a timeout there costs the agent all of its tools for the rest of the
 * server's life.
 */
const TOOL_TIMEOUT_MS = 15000;

/** The agents this module can register with. */
export const AGENT_MCP_TARGETS = [
  "opencode",
  "kilo",
  "cline",
  "cursor",
  "codex",
] as const;
export type AgentMcpTargetId = (typeof AGENT_MCP_TARGETS)[number];

/** The launch of the MCP server: the command and its arguments. */
export interface AgentMcpLaunch {
  readonly command: string;
  readonly args: string[];
}

/** The registration state of one target. */
export interface AgentMcpStatus {
  readonly id: AgentMcpTargetId;
  /** Display label, used in the settings screen. */
  readonly label: string;
  /** Absolute path of the config file the plugin would write. */
  readonly path: string;
  /** Whether the agent is present on this machine. */
  readonly detected: boolean;
  /** Whether luck-planner is registered there. */
  readonly installed: boolean;
  /** True when the registration matches the current launch command. */
  readonly upToDate: boolean | null;
  /** The registered command, when it can be read back. */
  readonly command: string | null;
  /** The registered arguments, when they can be read back. */
  readonly args: string[] | null;
}

/** True when both argument lists are equal, element by element. */
function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The XDG config directory of an app (`~/.config/<app>` by default). */
function configDir(app: string): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? "").trim();
  const base = xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, app);
}

/** A config file candidate: the preferred name first, the siblings after. */
interface FileCandidates {
  readonly dir: string;
  readonly fileNames: readonly string[];
}

function candidatePaths(target: FileCandidates): string[] {
  return target.fileNames.map((name) => path.join(target.dir, name));
}

// ---------------------------------------------------------------------------
// The `mcp:` format — OpenCode and Kilo
// ---------------------------------------------------------------------------

interface McpEntry {
  type?: unknown;
  command?: unknown;
  enabled?: unknown;
  timeout?: unknown;
}

interface McpDocument {
  mcp?: Record<string, unknown>;
}

/**
 * The config candidates of an agent — computed per call, never at import
 * time, so the paths follow the environment (a test can point them at a
 * temporary home) instead of freezing the machine's layout into the module.
 */
function opencodeFiles(): FileCandidates {
  return {
    dir: configDir("opencode"),
    // `opencode.json` first: it is the file the plugin creates when neither
    // exists, and OpenCode's config discovery looks for both names.
    fileNames: ["opencode.json", "opencode.jsonc"],
  };
}

function kiloFiles(): FileCandidates {
  return {
    dir: configDir("kilo"),
    // Kilo ships `kilo.jsonc` by convention, so an existing one is found
    // before the plugin would create a plain `kilo.json`.
    fileNames: ["kilo.jsonc", "kilo.json"],
  };
}

function clinePath(): string {
  return path.join(os.homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
}

function cursorPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

function codexPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

type LoadResult =
  | { ok: true; target: string; document: McpDocument; exists: boolean }
  | { ok: false; target: string; error: string };

function readJsonDocument(target: string): { ok: true; document: McpDocument } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("file is not a JSON object");
    }
    return { ok: true, document: parsed as McpDocument };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/**
 * Picks the file to read and write.
 *
 * An existing file that parses as plain JSON wins. A file that exists but
 * cannot be parsed (comments, syntax error) is skipped rather than
 * overwritten. When no candidate exists, the first name is created.
 */
function resolveMcpTarget(candidates: FileCandidates): LoadResult {
  const failures: string[] = [];
  for (const candidate of candidatePaths(candidates)) {
    if (!fs.existsSync(candidate)) continue;
    const loaded = readJsonDocument(candidate);
    if (loaded.ok) {
      return { ok: true, target: candidate, document: loaded.document, exists: true };
    }
    failures.push(`${candidate} (${loaded.error})`);
  }
  if (failures.length > 0) {
    return {
      ok: false,
      target: candidatePaths(candidates)[0] ?? "",
      error: `${failures.join("; ")} cannot be parsed and is left untouched — edit it manually or fix the syntax`,
    };
  }
  return {
    ok: true,
    target: candidatePaths(candidates)[0] ?? "",
    document: {},
    exists: false,
  };
}

function isMcpEntry(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && typeof (entry as McpEntry).type === "string";
}

function mcpEntryLaunch(entry: unknown): AgentMcpLaunch | null {
  const candidate = entry as McpEntry | undefined;
  if (candidate?.type !== "local" || !Array.isArray(candidate.command) || candidate.command.length === 0) {
    return null;
  }
  const [command, ...args] = (candidate.command as unknown[]).map(String);
  return { command: command ?? "", args };
}

function mcpEntryFor(launch: AgentMcpLaunch): McpEntry {
  return {
    type: "local",
    command: [launch.command, ...launch.args],
    enabled: true,
    timeout: TOOL_TIMEOUT_MS,
  };
}

/** Writes a JSON document atomically, keeping the file's mode. */
function writeJsonDocument(target: string, document: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode : undefined;
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (mode !== undefined) fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
}

// ---------------------------------------------------------------------------
// The `mcpServers:` format — Cline and Cursor
// ---------------------------------------------------------------------------

interface ServersDocument {
  mcpServers?: Record<string, unknown>;
}

type ServersLoad =
  | { ok: true; settings: ServersDocument }
  | { ok: false; error: string };

function readServersDocument(target: string): ServersLoad {
  if (!fs.existsSync(target)) return { ok: true, settings: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("file is not a JSON object");
    }
    return { ok: true, settings: parsed as ServersDocument };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: `${target} exists but cannot be parsed (${message}); fix or remove it manually`,
    };
  }
}

// ---------------------------------------------------------------------------
// The TOML format — Codex CLI
// ---------------------------------------------------------------------------

/** Matches the `[mcp_servers.<name>]` header of our table (quoted or bare). */
function codexSectionHeader(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^[ \\t]*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*\\][ \\t]*$`,
    "m",
  );
}

interface CodexSection {
  /** Line index of the table header. */
  readonly startLine: number;
  /** Line index of the next table header, or the line count at EOF. */
  readonly endLine: number;
}

/**
 * Locates our `[mcp_servers.<name>]` table. The table ends at the next line
 * that opens a new table (`[` as its first non-space character) or at the end
 * of the file.
 */
function findCodexSection(text: string, header: RegExp): CodexSection | null {
  const lines = text.split("\n");
  let startLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (header.test(lines[index] ?? "")) {
      startLine = index;
      break;
    }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let index = startLine + 1; index < lines.length; index += 1) {
    if (/^[ \t]*\[/.test(lines[index] ?? "")) {
      endLine = index;
      break;
    }
  }
  return { startLine, endLine };
}

/** Reads `command`/`args` from the body lines of our table. */
function parseCodexLaunch(bodyLines: readonly string[]): {
  command: string | null;
  args: string[] | null;
} {
  let command: string | null = null;
  let args: string[] | null = null;
  for (const line of bodyLines) {
    const commandMatch = /^[ \t]*command[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*$/.exec(line);
    if (commandMatch) command = unescapeTomlString(commandMatch[1] ?? "");
    const argsMatch = /^[ \t]*args[ \t]*=[ \t]*\[([\s\S]*)\][ \t]*$/.exec(line);
    if (argsMatch) args = parseTomlStringArray(argsMatch[1] ?? "");
  }
  return { command, args };
}

function parseTomlStringArray(inner: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    values.push(unescapeTomlString(match[1] ?? ""));
  }
  return values;
}

function unescapeTomlString(value: string): string {
  return value.replace(/\\(.)/g, (_match, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        // Covers \" and \\ — the escapes paths actually need.
        return ch;
    }
  });
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeCodexSection(launch: AgentMcpLaunch): string[] {
  const args = launch.args.map(tomlString).join(", ");
  return [
    `[mcp_servers.${AGENT_MCP_SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${args}]`,
  ];
}

function writeTextFile(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, target);
}

function ensureTrailingNewline(text: string): string {
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/** The label of a target, used in the settings screen. */
function targetLabel(id: AgentMcpTargetId): string {
  switch (id) {
    case "opencode":
      return "OpenCode";
    case "kilo":
      return "Kilo Code";
    case "cline":
      return "Cline";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex CLI";
  }
}

/** The path the target's config would live at. */
function targetPath(id: AgentMcpTargetId): string {
  switch (id) {
    case "opencode":
      return resolveMcpTarget(opencodeFiles()).target;
    case "kilo":
      return resolveMcpTarget(kiloFiles()).target;
    case "cline":
      return clinePath();
    case "cursor":
      return cursorPath();
    case "codex":
      return codexPath();
  }
}

/** Whether the agent is installed on this machine. */
function targetDetected(id: AgentMcpTargetId): boolean {
  switch (id) {
    case "opencode":
      return (
        fs.existsSync(resolveMcpTarget(opencodeFiles()).target) ||
        fs.existsSync(opencodeFiles().dir)
      );
    case "kilo":
      return (
        fs.existsSync(resolveMcpTarget(kiloFiles()).target) ||
        fs.existsSync(kiloFiles().dir)
      );
    case "cline":
      return fs.existsSync(clinePath()) || fs.existsSync(path.dirname(clinePath()));
    case "cursor":
      return fs.existsSync(cursorPath()) || fs.existsSync(path.dirname(cursorPath()));
    case "codex":
      return fs.existsSync(codexPath()) || fs.existsSync(path.dirname(codexPath()));
  }
}

/** The registration state of one target. */
function statusOf(id: AgentMcpTargetId): AgentMcpStatus {
  const launch = mcpServerCommand();
  const path = targetPath(id);
  const detected = targetDetected(id);

  if (id === "opencode" || id === "kilo") {
    const resolved = resolveMcpTarget(id === "opencode" ? opencodeFiles() : kiloFiles());
    if (!resolved.ok) {
      return { id, label: targetLabel(id), path, detected, installed: false, upToDate: null, command: null, args: null };
    }
    const entry = resolved.document.mcp?.[AGENT_MCP_SERVER_NAME];
    const installed = isMcpEntry(entry);
    const registered = installed ? mcpEntryLaunch(entry) : null;
    return {
      id,
      label: targetLabel(id),
      path: resolved.target,
      detected,
      installed,
      upToDate: registered
        ? registered.command === launch.command && sameStringArray(registered.args, launch.args)
        : null,
      command: registered?.command ?? null,
      args: registered?.args ?? null,
    };
  }

  if (id === "cline" || id === "cursor") {
    const loaded = readServersDocument(path);
    if (!loaded.ok) {
      return { id, label: targetLabel(id), path, detected, installed: false, upToDate: null, command: null, args: null };
    }
    const entry = loaded.settings.mcpServers?.[AGENT_MCP_SERVER_NAME];
    const installed =
      typeof entry === "object" && entry !== null;
    const registered = installed ? serversEntryLaunch(entry, id) : null;
    return {
      id,
      label: targetLabel(id),
      path,
      detected,
      installed,
      upToDate: registered
        ? registered.command === launch.command && sameStringArray(registered.args, launch.args)
        : null,
      command: registered?.command ?? null,
      args: registered?.args ?? null,
    };
  }

  // Codex CLI: the TOML table.
  let command: string | null = null;
  let args: string[] | null = null;
  let installed = false;
  if (fs.existsSync(codexPath())) {
    const text = fs.readFileSync(codexPath(), "utf8");
    const section = findCodexSection(text, codexSectionHeader(AGENT_MCP_SERVER_NAME));
    if (section !== null) {
      installed = true;
      const body = text.split("\n").slice(section.startLine + 1, section.endLine);
      const parsed = parseCodexLaunch(body);
      command = parsed.command;
      args = parsed.args;
    }
  }
  return {
    id,
    label: targetLabel(id),
    path: codexPath(),
    detected,
    installed,
    upToDate:
      command !== null && args !== null
        ? command === launch.command && sameStringArray(args, launch.args)
        : null,
    command,
    args,
  };
}

/** Reads the launch back from a Cline/Cursor entry. */
function serversEntryLaunch(entry: unknown, id: AgentMcpTargetId): AgentMcpLaunch | null {
  const candidate = entry as { command?: unknown; args?: unknown; transport?: unknown } | undefined;
  const command = id === "cline" ? (candidate?.transport as { command?: unknown } | undefined)?.command : candidate?.command;
  const args = id === "cline" ? (candidate?.transport as { args?: unknown } | undefined)?.args : candidate?.args;
  if (typeof command !== "string" || !Array.isArray(args)) return null;
  return { command, args: args.map(String) };
}

/** Writes the entry a Cline/Cursor expects. */
function serversEntryFor(id: AgentMcpTargetId, launch: AgentMcpLaunch): unknown {
  if (id === "cline") {
    return { transport: { type: "stdio", command: launch.command, args: launch.args } };
  }
  return { command: launch.command, args: launch.args };
}

/** The registration state of every target. */
export function agentMcpStatuses(): AgentMcpStatus[] {
  return AGENT_MCP_TARGETS.map((id) => statusOf(id));
}

/**
 * Adds (or refreshes) the plugin's entry in one target's config file,
 * preserving every other key, server and comment.
 */
export function registerAgentMcp(id: AgentMcpTargetId): { ok: boolean; error: string | null } {
  try {
    const launch = mcpServerCommand();

    if (id === "opencode" || id === "kilo") {
      const resolved = resolveMcpTarget(id === "opencode" ? opencodeFiles() : kiloFiles());
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const mcp = {
        ...(resolved.document.mcp ?? {}),
        [AGENT_MCP_SERVER_NAME]: mcpEntryFor(launch),
      };
      writeJsonDocument(resolved.target, { ...resolved.document, mcp });
      return { ok: true, error: null };
    }

    if (id === "cline" || id === "cursor") {
      const target = targetPath(id);
      const loaded = readServersDocument(target);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const servers = { ...(loaded.settings.mcpServers ?? {}) };
      servers[AGENT_MCP_SERVER_NAME] = serversEntryFor(id, launch);
      writeJsonDocument(target, { ...loaded.settings, mcpServers: servers });
      return { ok: true, error: null };
    }

    // Codex CLI: only our table is replaced, the rest stays byte-for-byte.
    const existing = fs.existsSync(codexPath()) ? fs.readFileSync(codexPath(), "utf8") : "";
    const section = findSection(existing);
    const lines = existing.split("\n");
    let updated: string;
    if (section !== null) {
      lines.splice(section.startLine, section.endLine - section.startLine, ...serializeCodexSection(launch));
      updated = lines.join("\n");
    } else {
      const block = serializeCodexSection(launch).join("\n");
      updated =
        existing.trim().length === 0 ? block : `${existing.replace(/\s*$/, "")}\n\n${block}`;
    }
    writeTextFile(codexPath(), ensureTrailingNewline(updated));
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/** Removes the plugin's entry; every other key, server and comment stays. */
export function unregisterAgentMcp(id: AgentMcpTargetId): { ok: boolean; error: string | null } {
  try {
    if (id === "opencode" || id === "kilo") {
      const resolved = resolveMcpTarget(id === "opencode" ? opencodeFiles() : kiloFiles());
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const mcp = resolved.document.mcp;
      if (!mcp || !(AGENT_MCP_SERVER_NAME in mcp)) return { ok: true, error: null };
      if (!resolved.exists) return { ok: true, error: null };
      const remaining = { ...mcp };
      delete remaining[AGENT_MCP_SERVER_NAME];
      const next: McpDocument = { ...resolved.document };
      if (Object.keys(remaining).length > 0) next.mcp = remaining;
      else delete next.mcp;
      writeJsonDocument(resolved.target, next);
      return { ok: true, error: null };
    }

    if (id === "cline" || id === "cursor") {
      const target = targetPath(id);
      const loaded = readServersDocument(target);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const servers = loaded.settings.mcpServers;
      if (!servers || !(AGENT_MCP_SERVER_NAME in servers)) return { ok: true, error: null };
      const remaining = { ...servers };
      delete remaining[AGENT_MCP_SERVER_NAME];
      writeJsonDocument(target, { ...loaded.settings, mcpServers: remaining });
      return { ok: true, error: null };
    }

    // Codex CLI.
    if (!fs.existsSync(codexPath())) return { ok: true, error: null };
    const existing = fs.readFileSync(codexPath(), "utf8");
    const section = findSection(existing);
    if (section === null) return { ok: true, error: null };
    const lines = existing.split("\n");
    // Also drop one blank separator line that followed the table.
    let count = section.endLine - section.startLine;
    if (section.endLine < lines.length && (lines[section.endLine] ?? "").trim() === "") {
      count += 1;
    }
    lines.splice(section.startLine, count);
    writeTextFile(codexPath(), ensureTrailingNewline(lines.join("\n")));
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/** Finds our table in the Codex config text. */
function findSection(text: string): CodexSection | null {
  return findCodexSection(text, codexSectionHeader(AGENT_MCP_SERVER_NAME));
}

/**
 * Whether a config file already carries a current registration for the
 * agent of the given provider.
 *
 * When it does, the session-level injection is skipped: the config entry
 * survives an eviction, reconnects at every location boot and reaches the
 * providers that ignore session-delivered servers — while a stale session
 * entry would shadow it and make every call fail.
 */
export function agentConfigCoversProvider(provider: string): {
  covered: boolean;
  path: string | null;
} {
  const id = AGENT_MCP_TARGETS.find((candidate) => candidate === provider);
  if (id === undefined) return { covered: false, path: null };
  const status = statusOf(id);
  return { covered: status.installed && status.upToDate === true, path: status.path };
}
