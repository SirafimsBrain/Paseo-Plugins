import { MCP_TOOLS } from "./mcp-tools";
import {
  PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./mcp-jsonrpc";
import { PASEO_DOWN_MESSAGE } from "./daemon-gate";

/**
 * JSON-RPC answers of a stdio MCP server that may not serve this agent.
 *
 * Used when the Paseo daemon/desktop is not running (`server/daemon-gate.ts`).
 * The server still speaks the protocol — a client that only handshakes sees a
 * healthy server instead of a crash loop — but every tool call is refused with
 * the same explicit sentence, delivered as an MCP `isError` result so the
 * *agent* (not only the client log) reads it and can stop.
 *
 * `tools/list` deliberately keeps the real tool catalogue: an empty list makes
 * an agent silently skip memory, while a refused call is what carries the
 * reason. The message is also published in `instructions` on `initialize`.
 *
 * No database is opened on this path: the store is constructed only after the
 * gate passes, so a stopped Paseo cannot leave locks or create a fresh
 * database behind an external agent's attempt.
 */
export function handleUnavailableRequest(
  request: JsonRpcRequest,
  serverInfo: { name: string; version: string },
  message: string = PASEO_DOWN_MESSAGE,
): JsonRpcResponse | null {
  const id = request.id ?? null;
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions: message,
        },
      };
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: message }], isError: true },
      };
    default:
      if (request.method.startsWith("notifications/")) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}
