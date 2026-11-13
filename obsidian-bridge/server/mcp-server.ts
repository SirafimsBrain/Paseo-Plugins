import { MCP_TOOLS, dispatchTool, mcpInstructions } from "./mcp-tools";
import { resolveRoleDirs } from "./dirs";
import { parseSettingsFile } from "./settings-file";

/**
 * Obsidian Bridge MCP server — JSON-RPC 2.0 over stdio.
 *
 * Spawned by coding agents (injected through `agent.open.before`, or configured
 * manually in any MCP client). Each call opens the vault's SQLite index, answers
 * from it, and closes it; nothing is cached across calls, so the file is always
 * whoever's latest write.
 *
 * Implemented: `initialize`, `notifications/initialized`, `ping`, `tools/list`,
 * `tools/call`. Newline-delimited JSON on stdout; logs go to stderr.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";

/** Injected at bundle time from package.json (see scripts/bundle-mcp-server.mjs). */
declare const __OBSIDIAN_BRIDGE_VERSION__: string;
const SERVER_VERSION =
  typeof __OBSIDIAN_BRIDGE_VERSION__ === "string" ? __OBSIDIAN_BRIDGE_VERSION__ : "0.0.0";

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
  const serverInfo = { name: "obsidian-bridge", version: SERVER_VERSION };

  process.stderr.write(
    `[obsidian-bridge] MCP server ready (vault: ${
      settings.vaultPath.length > 0 ? settings.vaultPath : "not configured"
    })\n`,
  );

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
      void handleRequest(request, settings, serverInfo);
    }
  });

  process.stdin.on("end", () => process.exit(0));
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleRequest(
  request: JsonRpcRequest,
  settings: ReturnType<typeof parseSettingsFile>,
  serverInfo: { name: string; version: string },
): Promise<void> {
  const id = request.id ?? null;
  switch (request.method) {
    case "initialize":
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: mcpInstructions(resolveRoleDirs(settings)),
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return;
    case "ping":
      respond(id, {});
      return;
    case "tools/list":
      respond(id, { tools: MCP_TOOLS });
      return;
    case "tools/call": {
      const params = request.params ?? {};
      const name = String(params.name ?? "");
      const outcome = await dispatchTool(name, params.arguments ?? {}, settings);
      if (outcome.isError) {
        process.stderr.write(`[obsidian-bridge] tool ${name} failed: ${outcome.text}\n`);
      }
      respond(id, {
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.structuredContent !== undefined
          ? { structuredContent: outcome.structuredContent }
          : {}),
        ...(outcome.isError ? { isError: true } : {}),
      });
      return;
    }
    default:
      if (request.method.startsWith("notifications/")) return;
      respondError(id, -32601, `Method not found: ${request.method}`);
  }
}

main();
