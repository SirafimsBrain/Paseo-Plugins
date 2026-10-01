import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  jsonMcpStatus,
  registerJsonMcp,
  unregisterJsonMcp,
  type JsonMcpShape,
} from "./agent-mcp-json";

/**
 * Direct MCP registration for Cursor.
 *
 * Cursor is a standalone IDE — it never sees the agent session
 * payloads Paseo creates, so the plugin's MCP injection cannot
 * reach it. Like Cline, Cursor reads stdio MCP servers from its
 * own global config file: `~/.cursor/mcp.json`, using the classic
 * flat format `{ mcpServers: { <name>: { command, args } } }`.
 *
 * The plugin registers the bundled stdio server there directly,
 * preserving every other server in the file and writing atomically
 * (temp file + rename). The file handling itself lives in
 * `agent-mcp-json.ts` and is shared with Cline.
 */

export const CURSOR_MCP_SERVER_NAME = "memory-flash";

export interface CursorMcpStatus {
  /** Absolute path of Cursor's global MCP config file. */
  path: string;
  /** Whether Cursor's config directory (or the file itself) exists. */
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

interface CursorServerEntry {
  command?: unknown;
  args?: unknown;
}

/** Absolute path of Cursor's global MCP config file. */
export function cursorMcpPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

const cursorShape: JsonMcpShape = {
  path: cursorMcpPath,
  serverName: CURSOR_MCP_SERVER_NAME,
  isEntry: (entry: unknown): boolean =>
    typeof entry === "object" && entry !== null,
  fromEntry: (entry: unknown) => {
    const candidate = entry as CursorServerEntry | undefined;
    if (typeof candidate?.command !== "string" || !Array.isArray(candidate?.args)) {
      return null;
    }
    return { command: candidate.command, args: (candidate.args as unknown[]).map(String) };
  },
  toEntry: (launch) => ({ command: launch.command, args: launch.args }),
};

/** Current registration state of memory-flash in Cursor's MCP config. */
export function cursorMcpStatus(): CursorMcpStatus {
  const status = jsonMcpStatus(cursorShape);
  const target = cursorMcpPath();
  return {
    ...status,
    detected: fs.existsSync(target) || fs.existsSync(path.dirname(target)),
  };
}

/** Adds (or refreshes) the memory-flash entry, preserving other servers. */
export function registerCursorMcp(): { ok: boolean; error: string | null } {
  return registerJsonMcp(cursorShape);
}

/** Removes the memory-flash entry; other servers are left untouched. */
export function unregisterCursorMcp(): { ok: boolean; error: string | null } {
  return unregisterJsonMcp(cursorShape);
}
