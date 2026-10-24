import { LuckPlannerStore, defaultDbPath } from "./store";
import type { McpDispatchContext, ToolResult } from "./mcp-tools";
import { MCP_TOOLS, dispatchMcpTool } from "./mcp-tools";

/**
 * luck-planner MCP server — JSON-RPC 2.0 over stdio (PLAN.md stage D2).
 *
 * Spawned by coding agents as a stdio MCP server and, from stage D3 on,
 * injected into Paseo-created agents via `config.mcpServers`. Each agent
 * process talks to this server over stdin/stdout while the shared SQLite
 * database (WAL mode, stage B2) serializes concurrent access from every
 * process.
 *
 * Framing: newline-delimited JSON. **stdout carries the protocol and
 * nothing else** — every diagnostic goes to stderr, otherwise a stray log
 * line corrupts the client's frame stream and the agent reports
 * `Connection closed` on an otherwise healthy server (memory-flash lesson).
 *
 * MCP semantics (initialize, ping, tools/list, tools/call) live next to the
 * framing in this file because there is exactly one transport: the dashboard
 * HTTP server (stage F1) is a read-only REST API, not an MCP endpoint.
 * Tool behavior itself is transport-independent in `mcp-tools.ts`.
 */

/** MCP protocol revision spoken by this server. */
export const PROTOCOL_VERSION = "2024-11-05";

/**
 * Server version reported in `initialize`. Kept in sync with
 * `package.json` by `tests/mcp-server-e2e.test.ts`, so every version bump
 * must update this constant — the handshake is what agents see.
 */
export const SERVER_VERSION = "0.34.0";

/**
 * Default server name agents see in `initialize`. The `mcpServerName`
 * setting (stage D3) overrides it through `LUCK_PLANNER_SERVER_NAME`, which
 * the injected MCP config carries in `env` — the config key (and therefore
 * the tool-name prefix) always stays `luck-planner`.
 */
export const SERVER_NAME = "luck-planner";

/** The name this process reports: the `mcpServerName` setting, or the default. */
function reportedServerName(): string {
  const configured = (process.env.LUCK_PLANNER_SERVER_NAME ?? "").trim();
  return configured.length > 0 ? configured : SERVER_NAME;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Handle a parsed JSON-RPC request. Returns the response to send, or
 * `null` for notifications. Tool failures are answered with an MCP
 * `isError` result rather than a JSON-RPC error, so agents can read the
 * failure text instead of a bare code.
 */
function handleJsonRpcRequest(request: JsonRpcRequest): JsonRpcResponse | null {
  const id = request.id ?? null;
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: reportedServerName(), version: SERVER_VERSION },
        },
      };
    case "notifications/initialized":
    case "initialized":
      return null; // notification — no response
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const params = request.params ?? {};
      const name = String(params.name ?? "");
      const context = serverContext;
      if (!context) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: "Server not initialized (store not open)." }],
            isError: true,
          },
        };
      }
      try {
        const result: ToolResult = dispatchMcpTool(
          name,
          params.arguments ?? {},
          context,
        );
        return { jsonrpc: "2.0", id, result };
      } catch (cause) {
        // dispatchMcpTool already converts store errors into isError
        // results; this belt catches anything above it so one bad call
        // never tears down the transport.
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`[luck-planner] tool ${name} failed: ${message}\n`);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }
    default:
      if (request.method.startsWith("notifications/")) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}

/** Set in {@link main}; shared by every `tools/call` on this process. */
let serverContext: McpDispatchContext | null = null;

function main(): void {
  const store = new LuckPlannerStore();
  serverContext = {
    store,
    // The agent id the server was launched with (stage D3 sets it per
    // agent); the audit trail must never be empty.
    defaultActor: process.env.LUCK_PLANNER_AGENT_ID || undefined,
  };

  process.stderr.write(
    `[luck-planner] MCP server ready (db: ${defaultDbPath()}, actor: ${
      serverContext.defaultActor ?? "unset"
    })\n`,
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
      const response = handleJsonRpcRequest(request);
      if (response) writeMessage(response);
    }
  });

  const shutdown = (): void => {
    store.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
