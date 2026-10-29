import { MCP_TOOLS, dispatchMcpTool, type McpDispatchContext } from "./mcp-tools";

/**
 * Transport-agnostic MCP JSON-RPC 2.0 handling (0.5.0).
 *
 * Both transports — the stdio server (`mcp-server.ts`) and the HTTP
 * endpoint (`http-server.ts`) — parse incoming messages and hand them
 * to `handleJsonRpcRequest`, so the MCP semantics (initialize, ping,
 * tools/list, tools/call) stay identical regardless of how the client
 * connected. Transports own framing: stdio uses newline-delimited
 * JSON, HTTP uses one JSON body per POST.
 */

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_VERSION = "0.1.1";

/**
 * `instructions` of the MCP `initialize` result (0.9.4).
 *
 * The MCP spec lets a server describe itself to the client, and the harnesses
 * that surface it show these sentences next to the tool list — the one place an
 * agent reads on every session, before it decides how to use nine `memory_*`
 * tools. It restates the skill's baseline in one paragraph rather than
 * duplicating it: mandatory-before-work search, save-the-bugfix-now, always a
 * handoff, English, and `memory_get` instead of a snippet.
 */
export const MCP_INSTRUCTIONS =
  "Shared team memory for all coding agents: treat it as mandatory, not optional. " +
  "Start a non-trivial task with 2-4 differently worded memory_search calls — one " +
  "empty query is not a search — save every bugfix, decision and working solution " +
  "with memory_save the moment it exists rather than at the end of the session, " +
  "and always leave a memory_handoff before you stop, on success as well as on " +
  "failure. Read a hit in full with memory_get instead of trusting the snippet, " +
  "update an existing memory instead of writing a conflicting duplicate, tag every " +
  "memory with the project name and a topic, and write titles, content and tags in " +
  "English.";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Sink for transport-level diagnostics (stdio writes to stderr). */
export type JsonRpcLog = (message: string) => void;

/**
 * Handle a parsed JSON-RPC request. Returns the response to send, or
 * null for notifications (no response). Tool dispatch errors are
 * answered with an MCP `isError` result, not a JSON-RPC error, so
 * agents can read the failure text.
 */
export function handleJsonRpcRequest(
  request: JsonRpcRequest,
  context: McpDispatchContext,
  serverInfo: { name: string; version: string },
  log: JsonRpcLog = () => {},
): JsonRpcResponse | null {
  const id = request.id ?? null;
  switch (request.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions: MCP_INSTRUCTIONS,
        },
      };
    }
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
      try {
        const result = dispatchMcpTool(name, params.arguments ?? {}, context);
        return { jsonrpc: "2.0", id, result };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        log(`[memory-flash] tool ${name} failed: ${message}`);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: message }], isError: true },
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
