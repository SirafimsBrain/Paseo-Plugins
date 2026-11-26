import { MemoryStore } from "./store";
import type { McpDispatchContext } from "./mcp-tools";
import { parseSettingsFile, type ParsedSettings } from "./settings-file";
import { defaultProject } from "./workspace-map";
import {
  handleJsonRpcRequest,
  SERVER_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./mcp-jsonrpc";
import {
  checkPaseoDaemon,
  PASEO_DOWN_MESSAGE,
  type PaseoAvailability,
} from "./daemon-gate";
import { handleUnavailableRequest } from "./mcp-unavailable";

/**
 * Memory Flash MCP server — JSON-RPC 2.0 over stdio (MCP protocol).
 *
 * Spawned by coding agents (Cline, OpenCode, Kilo, …) as a stdio MCP
 * server, and injected into Paseo-created agents via `config.mcpServers`.
 * Each agent process talks to this server over stdin/stdout while the
 * shared SQLite database (WAL mode) serializes concurrent access from
 * every process.
 *
 * MCP protocol handling lives in `mcp-jsonrpc.ts` and is shared with
 * the HTTP endpoint (`http-server.ts`). This file only owns the stdio
 * framing: newline-delimited JSON on stdout, nothing else is ever
 * written to stdout (logs go to stderr).
 *
 * Availability gate (0.15.1): agents outside Paseo keep this server in their
 * own config and spawn it whenever they run, including while Paseo is closed.
 * A plugin's MCP server belongs to Paseo, so it serves only while the daemon or
 * desktop is up; otherwise every tool call answers "Демон Paseo недоступен, MCP
 * недоступен" and no database is opened. See `server/daemon-gate.ts`.
 */

function main(): void {
  const settings = parseSettingsFile();
  const availability = checkPaseoDaemon();
  if (!availability.available) {
    serveUnavailable(settings, availability);
    return;
  }
  const store = new MemoryStore({ historyPerMemory: settings.historyPerMemory });
  const context: McpDispatchContext = {
    store,
    defaultAgentId: settings.defaultAgentId || process.env.MEMORY_FLASH_AGENT_ID || undefined,
    // 0.13.5: file unlabelled memories under the workspace, not the cwd path.
    defaultProject: defaultProject(),
  };

  const serverInfo = { name: settings.mcpServerName, version: SERVER_VERSION };

  process.stderr.write(
    `[memory-flash] MCP server ready (db: ${store.stats().dbSizeBytes} bytes)\n`,
  );

  const writeMessage = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        writeMessage({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        continue;
      }
      const response: JsonRpcResponse | null = handleJsonRpcRequest(
        request,
        context,
        serverInfo,
        (message) => process.stderr.write(`${message}\n`),
      );
      if (response) writeMessage(response);
    }
  });

  process.stdin.on("end", () => {
    store.close();
    process.exit(0);
  });

  const shutdown = (): void => {
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Transport that answers the protocol but refuses every tool call, because
 * Paseo is not running. It stays alive until the agent closes stdin so a
 * client does not treat the spawn as a crash and retry it, and it never opens
 * the SQLite file.
 */
function serveUnavailable(settings: ParsedSettings, availability: PaseoAvailability): void {
  const serverInfo = { name: settings.mcpServerName, version: SERVER_VERSION };
  process.stderr.write(
    `[memory-flash] ${PASEO_DOWN_MESSAGE} (gate: ${availability.reason})\n`,
  );

  const writeMessage = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      const response: JsonRpcResponse | null = handleUnavailableRequest(request, serverInfo);
      if (response) writeMessage(response);
    }
  });

  process.stdin.on("end", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main();
