import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import {
  jsonMcpStatus,
  registerJsonMcp,
  unregisterJsonMcp,
  type JsonMcpShape,
} from "./agent-mcp-json";

/**
 * Direct MCP registration for Kimi Code CLI.
 *
 * Kimi Code CLI is a terminal agent (and, under Paseo, an ACP agent) that
 * reads stdio MCP servers from its own user-level `mcp.json`:
 * `$KIMI_CODE_HOME/mcp.json`, i.e. `~/.kimi-code/mcp.json` by default. The
 * file holds a top-level `mcpServers` object whose stdio entries are the
 * classic flat shape `{ command, args }` — the same shape Cursor uses — so
 * the shared JSON writer in `agent-mcp-json.ts` covers it; only the
 * directory differs and it follows `KIMI_CODE_HOME`, exactly like the CLI's
 * own data root.
 *
 * A project-local `.kimi-code/mcp.json` also exists, but it is gated by
 * workspace trust and belongs to the repository, not to the machine — the
 * plugin never writes there.
 */

export const KIMI_MCP_SERVER_NAME = "memory-flash";

export interface KimiMcpStatus {
  /** Absolute path of the Kimi Code CLI user-level MCP config file. */
  path: string;
  /** Whether the Kimi data directory (or the file itself) exists. */
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

/**
 * Kimi Code CLI data root: `$KIMI_CODE_HOME` when set, else `~/.kimi-code`.
 * Resolved per call so the environment (and a test's temporary home) decides
 * the path instead of freezing the machine's layout into the module.
 */
export function kimiCodeHome(): string {
  const configured = (process.env.KIMI_CODE_HOME ?? "").trim();
  return configured.length > 0 ? configured : path.join(os.homedir(), ".kimi-code");
}

/** Absolute path of Kimi Code CLI's user-level MCP config file. */
export function kimiMcpPath(): string {
  return path.join(kimiCodeHome(), "mcp.json");
}

interface KimiServerEntry {
  command?: unknown;
  args?: unknown;
}

const kimiShape: JsonMcpShape = {
  path: kimiMcpPath,
  serverName: KIMI_MCP_SERVER_NAME,
  isEntry: (entry: unknown): boolean =>
    typeof entry === "object" && entry !== null,
  fromEntry: (entry: unknown) => {
    const candidate = entry as KimiServerEntry | undefined;
    if (typeof candidate?.command !== "string" || !Array.isArray(candidate?.args)) {
      return null;
    }
    return { command: candidate.command, args: (candidate.args as unknown[]).map(String) };
  },
  toEntry: (launch) => ({ command: launch.command, args: launch.args }),
};

/** Current registration state of memory-flash in Kimi Code CLI's MCP config. */
export function kimiMcpStatus(): KimiMcpStatus {
  const status = jsonMcpStatus(kimiShape);
  const target = kimiMcpPath();
  return {
    ...status,
    detected: fs.existsSync(target) || fs.existsSync(path.dirname(target)),
  };
}

/** Adds (or refreshes) the memory-flash entry, preserving other servers. */
export function registerKimiMcp(): { ok: boolean; error: string | null } {
  return registerJsonMcp(kimiShape);
}

/** Removes the memory-flash entry; other servers are left untouched. */
export function unregisterKimiMcp(): { ok: boolean; error: string | null } {
  return unregisterJsonMcp(kimiShape);
}
