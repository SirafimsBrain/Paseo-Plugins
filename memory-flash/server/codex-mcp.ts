import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import { mcpServerCommand } from "./mcp-launch";
import { sameStringArray, type JsonMcpLaunch } from "./agent-mcp-json";

/**
 * Direct MCP registration for Codex CLI.
 *
 * Codex CLI is a terminal agent — like Cline it does not connect
 * stdio MCP servers delivered through an orchestrator's agent
 * session; it reads MCP servers from its own global config file
 * `~/.codex/config.toml` as TOML tables:
 *
 *     [mcp_servers.memory-flash]
 *     command = "node"
 *     args = ["/path/to/mcp-server.js"]
 *
 * The plugin registers the bundled stdio server there directly.
 * The config is plain user-edited TOML, so the file is edited as
 * text: only the `[mcp_servers.<name>]` table of memory-flash is
 * replaced, everything else (other servers, keys, comments) is
 * preserved byte-for-byte, and the write is atomic (temp file +
 * rename) — the same guarantees the JSON-config agents get from
 * `agent-mcp-json.ts`.
 */

export const CODEX_MCP_SERVER_NAME = "memory-flash";

export interface CodexMcpStatus {
  /** Absolute path of the Codex CLI config file. */
  path: string;
  /** Whether the Codex config directory (or the file itself) exists. */
  detected: boolean;
  /** Whether the `[mcp_servers.<name>]` table is present. */
  installed: boolean;
  /** True when the registered entry matches the current launch command. */
  upToDate: boolean | null;
  /** Registered command, when parseable. */
  command: string | null;
  /** Registered args, when parseable. */
  args: string[] | null;
}

/** Absolute path of the Codex CLI config file. */
export function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

/** Matches the `[mcp_servers.<name>]` header of our table (quoted or bare key). */
function sectionHeaderRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^[ \\t]*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*\\][ \\t]*$`,
    "m",
  );
}

interface TomlSection {
  /** Line index of the table header. */
  startLine: number;
  /** Line index of the next table header, or the line count at EOF. */
  endLine: number;
}

/**
 * Locates our `[mcp_servers.<name>]` table. The table ends at the
 * next line that opens a new table (`[` as its first non-space
 * character) or at the end of the file.
 */
function findSection(text: string, header: RegExp): TomlSection | null {
  const lines = text.split("\n");
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i])) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^[ \t]*\[/.test(lines[i])) {
      endLine = i;
      break;
    }
  }
  return { startLine, endLine };
}

/** Reads `command`/`args` from the body lines of our table. */
function parseLaunch(bodyLines: string[]): { command: string | null; args: string[] | null } {
  let command: string | null = null;
  let args: string[] | null = null;
  for (const line of bodyLines) {
    const commandMatch = /^[ \t]*command[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*$/.exec(line);
    if (commandMatch) command = unescapeTomlString(commandMatch[1]);
    const argsMatch = /^[ \t]*args[ \t]*=[ \t]*\[([\s\S]*)\][ \t]*$/.exec(line);
    if (argsMatch) args = parseTomlStringArray(argsMatch[1]);
  }
  return { command, args };
}

function parseTomlStringArray(inner: string): string[] {
  const values: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(inner)) !== null) {
    values.push(unescapeTomlString(match[1]));
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

function serializeSection(launch: JsonMcpLaunch): string[] {
  const args = launch.args.map(tomlString).join(", ");
  return [
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${args}]`,
  ];
}

function writeConfig(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, "utf-8");
  fs.renameSync(temp, target);
}

function ensureTrailingNewline(text: string): string {
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
}

/** Current registration state of memory-flash in the Codex config file. */
export function codexMcpStatus(): CodexMcpStatus {
  const target = codexConfigPath();
  const launch = mcpServerCommand();
  const detected = fs.existsSync(target) || fs.existsSync(path.dirname(target));
  let installed = false;
  let command: string | null = null;
  let args: string[] | null = null;
  if (fs.existsSync(target)) {
    const text = fs.readFileSync(target, "utf-8");
    const section = findSection(text, sectionHeaderRegex(CODEX_MCP_SERVER_NAME));
    if (section) {
      installed = true;
      const body = text.split("\n").slice(section.startLine + 1, section.endLine);
      const parsed = parseLaunch(body);
      command = parsed.command;
      args = parsed.args;
    }
  }
  const upToDate =
    command !== null && args !== null
      ? command === launch.command && sameStringArray(args, launch.args)
      : null;
  return { path: target, detected, installed, upToDate, command, args };
}

/** Adds (or refreshes) the memory-flash table, preserving the rest of the file. */
export function registerCodexMcp(): { ok: boolean; error: string | null } {
  try {
    const target = codexConfigPath();
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
    const header = sectionHeaderRegex(CODEX_MCP_SERVER_NAME);
    const section = findSection(existing, header);
    let updated: string;
    if (section) {
      const lines = existing.split("\n");
      lines.splice(section.startLine, section.endLine - section.startLine, ...serializeSection(mcpServerCommand()));
      updated = lines.join("\n");
    } else {
      const block = serializeSection(mcpServerCommand()).join("\n");
      updated =
        existing.trim().length === 0
          ? block
          : `${existing.replace(/\s*$/, "")}\n\n${block}`;
    }
    writeConfig(target, ensureTrailingNewline(updated));
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/** Removes the memory-flash table; the rest of the file is left untouched. */
export function unregisterCodexMcp(): { ok: boolean; error: string | null } {
  try {
    const target = codexConfigPath();
    if (!fs.existsSync(target)) return { ok: true, error: null };
    const existing = fs.readFileSync(target, "utf-8");
    const section = findSection(existing, sectionHeaderRegex(CODEX_MCP_SERVER_NAME));
    if (!section) return { ok: true, error: null };
    const lines = existing.split("\n");
    // Also drop one blank separator line that followed the table.
    let count = section.endLine - section.startLine;
    if (section.endLine < lines.length && lines[section.endLine].trim() === "") {
      count += 1;
    }
    lines.splice(section.startLine, count);
    writeConfig(target, ensureTrailingNewline(lines.join("\n")));
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}
