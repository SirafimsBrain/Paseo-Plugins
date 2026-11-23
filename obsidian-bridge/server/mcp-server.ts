import { MCP_TOOLS, dispatchTool, mcpInstructions } from "./mcp-tools";
import { normalizeTruncation } from "./continuation";
import { resolveRoleDirs } from "./dirs";
import { resolveInstalledMcpEntry } from "./mcp-launch";
import { refreshStableEntry } from "./mcp-stable";
import { isStandaloneBridge, settingsMirrorPath } from "./paths";
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

/** Version answered when the client asks for nothing this server knows. */
const PROTOCOL_VERSION = "2024-11-05";

/**
 * Protocol revisions this server can serve (0.23.18).
 *
 * The transport and the tool surface (`tools/list`, `tools/call`, structured
 * content) are identical in all three, so the client's own revision is echoed
 * instead of forcing a downgrade a strict client may log as a mismatch. A
 * revision outside this list gets {@link PROTOCOL_VERSION}, which is what the
 * server has always answered.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

function negotiateProtocol(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

/**
 * Extra `initialize` instructions for a standalone installation (0.23.18).
 *
 * A direct `<user>` prefix says where the settings actually live instead of
 * pointing at a Paseo settings screen that such an installation does not have.
 */
function standaloneInstructions(): string {
  return (
    "\n\nThis server is installed standalone, outside Paseo: it reads `vaultPath`, the " +
    "directory roles and the search settings from `" + settingsMirrorPath() + "`, and any `OBSIDIAN_*` " +
    "environment variable overrides that file. The same document (`AGENT-SETUP.md`) sits next to the " +
    "installation. If the vault is not configured, ask the user to run the installer again with " +
    "`--vault <path>`, or to edit that file; do not guess a path."
  );
}

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
  const startupSettings = parseSettingsFile();
  const serverInfo = { name: "obsidian-bridge", version: SERVER_VERSION };

  // `paseo plugin update` does not restart the plugin host, so the stable copy
  // an agent launches can still hold the previous version. Repair it from the
  // installed checkout before serving anything (0.21.17); this process keeps
  // the code it already loaded, stderr is the only place to say so.
  //
  // A standalone installation has no Paseo checkout and no stable copy to keep
  // current — the file this process runs from *is* the installation — so the
  // refresh is skipped rather than writing into `~/.paseo` (0.23.18).
  if (!isStandaloneBridge()) {
    const refresh = refreshStableEntry(resolveInstalledMcpEntry(), SERVER_VERSION);
    if (refresh?.updated) {
      process.stderr.write(
        `[obsidian-bridge] stable MCP entry refreshed ${refresh.running} → ${refresh.installed}; ` +
          "the next agent launch uses the installed version\n",
      );
    }
  }

  process.stderr.write(
    `[obsidian-bridge] MCP server ready (vault: ${
      startupSettings.vaultPath.length > 0 ? startupSettings.vaultPath : "not configured"
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
      void handleRequest(request, serverInfo);
    }
  });

  process.stdin.on("end", () => process.exit(0));
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleRequest(
  request: JsonRpcRequest,
  serverInfo: { name: string; version: string },
): Promise<void> {
  const id = request.id ?? null;
  // Read settings per request: the file is the standalone UI, and a user who
  // edits it (or the plugin host that mirrors it) should not have to restart
  // the agent's MCP process.
  const settings = parseSettingsFile();
  switch (request.method) {
    case "initialize":
      respond(id, {
        protocolVersion: negotiateProtocol(request.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions:
          mcpInstructions(resolveRoleDirs(settings)) +
          (isStandaloneBridge() ? standaloneInstructions() : ""),
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
      const outcome = normalizeTruncation(await dispatchTool(name, params.arguments ?? {}, settings));
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
