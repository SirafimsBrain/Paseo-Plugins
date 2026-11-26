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
 * Direct MCP registration for the Pi coding agent (`pi`).
 *
 * Pi is a terminal agent: it never sees the agent session payloads Paseo
 * creates, so the plugin's MCP injection cannot reach it. Like Cursor and Kimi
 * Code CLI it reads stdio MCP servers from its own user-level file,
 * `<agent-dir>/mcp.json`, with the classic flat entry shape:
 *
 *     { "mcpServers": { "memory-flash": { "command": "node", "args": ["…"] } } }
 *
 * The agent directory defaults to `~/.pi/agent` and moves with
 * `PI_CODING_AGENT_DIR`, exactly like Pi's own data root; the plugin always
 * resolves it per call so tests and a moved installation both work.
 *
 * A project-level `.pi/mcp.json` also exists, but it belongs to the
 * repository (and requires project trust), so the plugin never writes there.
 *
 * Remember that a server registered here is started by Pi itself and is only
 * useful while Paseo runs: the stdio server refuses to serve (and says so)
 * when the daemon/desktop is stopped. See `server/daemon-gate.ts`.
 */

export const PI_MCP_SERVER_NAME = "memory-flash";

export interface PiMcpStatus {
  /** Absolute path of Pi's user-level MCP config file. */
  path: string;
  /** Whether the Pi agent directory (or the file itself) exists. */
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
 * Pi's agent directory: `$PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.
 * Resolved per call so the environment decides the path instead of freezing
 * the machine's layout into the module.
 */
export function piAgentDir(): string {
  const configured = (process.env.PI_CODING_AGENT_DIR ?? "").trim();
  return configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent");
}

/** Absolute path of Pi's user-level MCP config file. */
export function piMcpPath(): string {
  return path.join(piAgentDir(), "mcp.json");
}

interface PiServerEntry {
  command?: unknown;
  args?: unknown;
}

const piShape: JsonMcpShape = {
  path: piMcpPath,
  serverName: PI_MCP_SERVER_NAME,
  isEntry: (entry: unknown): boolean => typeof entry === "object" && entry !== null,
  fromEntry: (entry: unknown) => {
    const candidate = entry as PiServerEntry | undefined;
    if (typeof candidate?.command !== "string" || !Array.isArray(candidate?.args)) {
      return null;
    }
    return { command: candidate.command, args: (candidate.args as unknown[]).map(String) };
  },
  toEntry: (launch) => ({ command: launch.command, args: launch.args }),
};

/** Current registration state of memory-flash in Pi's MCP config. */
export function piMcpStatus(): PiMcpStatus {
  const status = jsonMcpStatus(piShape);
  const target = piMcpPath();
  return {
    ...status,
    detected: fs.existsSync(target) || fs.existsSync(path.dirname(target)),
  };
}

/** Adds (or refreshes) the memory-flash entry, preserving other servers. */
export function registerPiMcp(): { ok: boolean; error: string | null } {
  return registerJsonMcp(piShape);
}

/** Removes the memory-flash entry; other servers are left untouched. */
export function unregisterPiMcp(): { ok: boolean; error: string | null } {
  return unregisterJsonMcp(piShape);
}
