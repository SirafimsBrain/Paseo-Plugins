import * as os from "node:os";
import * as path from "node:path";
import {
  jsonMcpStatus,
  registerJsonMcp,
  unregisterJsonMcp,
  type JsonMcpShape,
} from "./agent-mcp-json";

/**
 * Direct MCP registration for Cline (requirement 9).
 *
 * Cline accepts `mcpServers` in the agent session payload but only
 * connects remote (http/sse) servers from it — stdio servers are
 * ignored. Cline reads stdio MCP servers from its own settings file:
 * `~/.cline/data/settings/cline_mcp_settings.json` (same shape as
 * its UI-managed configuration: `{ mcpServers: { <name>: {
 * transport: { type, command, args } } } } }`).
 *
 * The plugin registers the bundled stdio server there directly, so a
 * fresh machine gets a working Cline integration with one click from
 * the plugin settings screen. Registration preserves every other
 * server in the file and writes atomically (temp file + rename).
 * The file handling itself lives in `agent-mcp-json.ts` and is
 * shared with the other JSON-config agents (Cursor).
 */

export const CLINE_MCP_SERVER_NAME = "memory-flash";

export interface ClineMcpStatus {
  /** Absolute path of the Cline MCP settings file. */
  path: string;
  /** Whether the settings file exists on this machine. */
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

interface ClineTransport {
  type?: unknown;
  command?: unknown;
  args?: unknown;
}

interface ClineServerEntry {
  transport?: ClineTransport;
}

/** Absolute path of Cline's MCP settings file. */
export function clineSettingsPath(): string {
  return path.join(os.homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
}

const clineShape: JsonMcpShape = {
  path: clineSettingsPath,
  serverName: CLINE_MCP_SERVER_NAME,
  isEntry: (entry: unknown): boolean => {
    const transport = (entry as ClineServerEntry | undefined)?.transport;
    return (
      typeof transport === "object" &&
      transport !== null &&
      typeof (transport as ClineTransport).type === "string"
    );
  },
  fromEntry: (entry: unknown) => {
    const transport = (entry as ClineServerEntry | undefined)?.transport;
    if (typeof transport?.command !== "string" || !Array.isArray(transport?.args)) {
      return null;
    }
    return { command: transport.command, args: (transport.args as unknown[]).map(String) };
  },
  toEntry: (launch) => ({
    transport: { type: "stdio", command: launch.command, args: launch.args },
  }),
};

/** Current registration state of memory-flash in the Cline settings file. */
export function clineMcpStatus(): ClineMcpStatus {
  return jsonMcpStatus(clineShape);
}

/** Adds (or refreshes) the memory-flash entry, preserving other servers. */
export function registerClineMcp(): { ok: boolean; error: string | null } {
  return registerJsonMcp(clineShape);
}

/** Removes the memory-flash entry; other servers are left untouched. */
export function unregisterClineMcp(): { ok: boolean; error: string | null } {
  return unregisterJsonMcp(clineShape);
}
