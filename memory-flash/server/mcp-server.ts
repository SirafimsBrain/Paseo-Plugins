import { MemoryStore } from "./store";
import { MCP_TOOLS, dispatchMcpTool, type McpDispatchContext } from "./mcp-tools";
import { parseSettingsFile } from "./settings-file";

/**
 * Memory Flash MCP server — JSON-RPC 2.0 over stdio (MCP protocol).
 *
 * Spawned by coding agents (Cline, OpenCode, Kilo, …) as a stdio MCP server,
 * and injected into Paseo-created agents via `config.mcpServers`. Each agent
 * process talks to this server over stdin/stdout while the shared SQLite
 * database (WAL mode) serializes concurrent access from every process.
 *
 * Protocol basics implemented: `initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call`, `ping`. responses are newline-delimited JSON on
 * stdout; nothing else is ever written to stdout (logs go to stderr).
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.1.1";

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string | null, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id: number | string | null, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function main(): void {
  const settings = parseSettingsFile();
  const store = new MemoryStore({ historyPerMemory: settings.historyPerMemory });
  const context: McpDispatchContext = {
    store,
    defaultAgentId: settings.defaultAgentId || process.env.MEMORY_FLASH_AGENT_ID || undefined,
  };

  const serverInfo = { name: settings.mcpServerName, version: SERVER_VERSION };

  process.stderr.write(`[memory-flash] MCP server ready (db: ${store.stats().dbSizeBytes} bytes)\n`);

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
        respondError(null, -32700, "Parse error");
        continue;
      }
      handleRequest(request, context, serverInfo);
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

function handleRequest(
  request: JsonRpcRequest,
  context: McpDispatchContext,
  serverInfo: { name: string; version: string },
): void {
  const id = request.id ?? null;
  switch (request.method) {
    case "initialize": {
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // notification — no response
    case "ping":
      respond(id, {});
      return;
    case "tools/list": {
      respond(id, { tools: MCP_TOOLS });
      return;
    }
    case "tools/call": {
      const params = request.params ?? {};
      const name = String(params.name ?? "");
      try {
        const result = dispatchMcpTool(name, params.arguments ?? {}, context);
        respond(id, result);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`[memory-flash] tool ${name} failed: ${message}\n`);
        respond(id, { content: [{ type: "text", text: message }], isError: true });
      }
      return;
    }
    default:
      if (request.method.startsWith("notifications/")) return;
      respondError(id, -32601, `Method not found: ${request.method}`);
  }
}

main();
