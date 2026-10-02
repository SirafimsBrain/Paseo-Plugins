import type { PluginServerContext } from "@getpaseo/plugin/server";
import { memoryFlashClientSettings, type MemoryFlashClientSettings } from "./shared/settings";
import {
  checkConnection,
  checkConnectionDraft,
  clientStatus,
  conflictCheck,
  deleteConnection,
  listConnections,
  regenerateClientId,
  saveConnection,
} from "./shared/contracts";
import {
  connectionsFilePath,
  deleteConnection as removeConnection,
  getConnection,
  listConnections as loadConnections,
  listViews,
  persistCheck,
  saveConnection as persistConnection,
} from "./server/connections";
import { probeConnection } from "./server/probe";
import { checkConflict } from "./server/conflict";
import {
  generateClientId,
  isValidClientId,
  resolveIdentityHost,
  type RequestIdentity,
} from "./server/identity";

/**
 * Plugin server for Memory Flash Client.
 *
 * Responsibilities:
 * 1. Registers host-scoped settings — the client identity (UUID +
 *    hostname) and how remote memory servers are injected into agents.
 * 2. Injects the configured remote memory MCP servers (HTTP + API key)
 *    into every Paseo-created agent via the `agent.create` before-hook,
 *    announcing the client identity on each connection.
 * 3. Serves the plugin RPC surface for the Paseo UI: connection CRUD,
 *    the connection check (health + MCP handshake against a memory host),
 *    the coexistence check with memory-flash, and a client-id reset.
 *
 * Trust model: the API key is the credential. The UUID/hostname headers
 * are advisory and exist purely so the memory host can log which client
 * connected; they never grant access.
 */

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(memoryFlashClientSettings);

  let currentSettings: MemoryFlashClientSettings | null = null;
  /**
   * Identity used when settings carry no valid UUID yet. Kept in memory
   * so every agent created during this process presents the same id; the
   * user can pin a real UUID in settings at any time, which then wins.
   */
  let fallbackClientId: string | null = null;

  const applySettings = (values: MemoryFlashClientSettings): void => {
    currentSettings = values;
    if (isValidClientId(values.clientId)) {
      // A pinned UUID is authoritative — stop echoing the generated one.
      fallbackClientId = null;
    }
  };

  void settings.read().then((state) => {
    if (state.status === "ready") applySettings(state.values);
  });
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status === "ready") applySettings(state.values);
  });

  /** Effective identity: pinned UUID from settings, else a generated one. */
  const resolveIdentity = (values: MemoryFlashClientSettings | null): RequestIdentity => {
    const configured = values?.clientId ?? "";
    if (isValidClientId(configured)) {
      return { clientId: configured, host: resolveIdentityHost(values?.hostname ?? "") };
    }
    if (fallbackClientId === null) fallbackClientId = generateClientId();
    return { clientId: fallbackClientId, host: resolveIdentityHost(values?.hostname ?? "") };
  };

  /** Current settings, or the schema defaults when the store is invalid. */
  const readSettings = async (): Promise<MemoryFlashClientSettings | null> => {
    const state = await settings.read().catch(() => null);
    if (state?.status === "ready") {
      applySettings(state.values);
      return state.values;
    }
    return currentSettings;
  };

  // -------------------------------------------------------------------------
  // Remote memory MCP injection
  //
  // Every enabled connection becomes one HTTP MCP server in the agent
  // config. With a single connection it is named exactly `mcpServerName`
  // (e.g. `memory-flash`); with several, each gets a suffixed name so the
  // names stay unique inside one agent.
  // -------------------------------------------------------------------------

  const buildServerName = (connectionId: string, total: number, prefix: string): string =>
    total <= 1 ? prefix : `${prefix}-${connectionId}`;

  const removeCreateHook = server.before("agent.create", async ({ request }) => {
    const values = await readSettings();
    if (!values?.injectIntoAgents) return request;

    const connections = loadConnections().filter((entry) => entry.enabled);
    if (connections.length === 0) return request;

    const identity = resolveIdentity(values);
    const mcpServers = { ...(request.config.mcpServers ?? {}) };
    for (const connection of connections) {
      const name = buildServerName(
        connection.id,
        connections.length,
        values.mcpServerName,
      );
      const headers: Record<string, string> = {
        Authorization: `Bearer ${connection.secret}`,
      };
      if (values.sendIdentityHeaders) {
        headers["X-Memory-Flash-Client-Id"] = identity.clientId;
        headers["X-Memory-Flash-Host"] = identity.host;
      }
      // `as const` instead of a named `McpHttpServerConfig` annotation: the MCP
      // config types live in @getpaseo/protocol, which is not a host-supplied
      // specifier, so importing them would make this bundle need node_modules
      // at install time. Storing into `mcpServers` below checks the literal
      // against the host's own type, which is a stronger guarantee.
      const config = {
        type: "http",
        url: connection.url,
        headers,
        alwaysLoad: true,
      } as const;
      mcpServers[name] = config;
      // Diagnostic: the endpoint and name are safe to log, the key is not.
      console.log(
        `[memory-flash-client] MCP injected: ${name} → ${connection.url} (client ${identity.host})`,
      );
    }
    request.config.mcpServers = mcpServers;
    return request;
  });

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  server.handle(listConnections, () => ({ connections: listViews() }));

  server.handle(saveConnection, (input) => persistConnection(input.connection));

  server.handle(deleteConnection, (input) => ({ ok: removeConnection(input.id) }));

  server.handle(checkConnection, async (input) => {
    const connection = getConnection(input.id);
    if (!connection) {
      return {
        ok: false,
        status: "error" as const,
        latencyMs: null,
        error: "Connection not found.",
        serverName: null,
        toolCount: null,
        checkedAt: new Date().toISOString(),
      };
    }
    const values = await readSettings();
    const result = await probeConnection(
      connection.url,
      connection.secret,
      resolveIdentity(values),
    );
    persistCheck(connection.id, result.ok ? "ok" : "error", result.error);
    return result;
  });

  server.handle(checkConnectionDraft, async (input) => {
    const values = await readSettings();
    return probeConnection(input.url, input.secret, resolveIdentity(values));
  });

  server.handle(clientStatus, async () => {
    const values = await readSettings();
    const identity = resolveIdentity(values);
    const connections = loadConnections();
    return {
      clientId: identity.clientId,
      hostname: values?.hostname ?? "",
      identityHost: identity.host,
      totalConnections: connections.length,
      enabledConnections: connections.filter((entry) => entry.enabled).length,
      okConnections: connections.filter((entry) => entry.status === "ok").length,
      injectIntoAgents: values?.injectIntoAgents ?? true,
      mcpServerName: values?.mcpServerName ?? "memory-flash",
      connectionsPath: connectionsFilePath(),
    };
  });

  server.handle(conflictCheck, () => checkConflict());

  server.handle(regenerateClientId, () => {
    const next = generateClientId();
    fallbackClientId = next;
    return { clientId: next };
  });

  // -------------------------------------------------------------------------

  return () => {
    removeCreateHook();
    unsubscribeSettings();
    fallbackClientId = null;
  };
}
