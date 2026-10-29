import type { PluginServerContext } from "@getpaseo/plugin/server";
import { memoryFlashClientSettings, type MemoryFlashClientSettings } from "./shared/settings";
import {
  checkConnection,
  checkConnectionDraft,
  clientStatus,
  conflictCheck,
  agentReload,
  deleteConnection,
  installSkill,
  listConnections,
  regenerateClientId,
  saveConnection,
  skillPreview,
  skillStatus,
  uninstallSkill,
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
  installSkill as installRemoteSkill,
  skillMarkdown,
  skillStatuses,
  uninstallSkill as uninstallRemoteSkill,
} from "./server/skill";
import {
  generateClientId,
  isValidClientId,
  resolveIdentityHost,
  type RequestIdentity,
} from "./server/identity";
import { readSavedMcpServers } from "./server/agent-record";
import { decideClientSessionOpen } from "./server/session-open";

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

  /**
   * Server entries for the current connection set, shared by both hooks so the
   * create-time (saved) and session-open (launch-only) registrations cannot
   * drift apart in name, URL or identity headers.
   *
   * The literal annotation keeps the `type: "http"` narrowing without importing
   * the MCP config types from `@getpaseo/protocol`, which Paseo does not supply
   * to plugins and which would make the bundle need `node_modules` at install
   * time (§12 of __doc.md).
   */
  const buildServerEntries = (
    values: MemoryFlashClientSettings,
    identity: RequestIdentity,
  ): Array<{
    name: string;
    url: string;
    config: {
      type: "http";
      url: string;
      headers: Record<string, string>;
      alwaysLoad: true;
    };
  }> => {
    const connections = loadConnections().filter((entry) => entry.enabled);
    return connections.map((connection) => {
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
      return {
        name,
        url: connection.url,
        config: { type: "http", url: connection.url, headers, alwaysLoad: true },
      };
    });
  };

  const removeCreateHook = server.before("agent.create", async ({ request }) => {
    const values = await readSettings();
    if (!values?.injectIntoAgents) return request;

    const identity = resolveIdentity(values);
    const entries = buildServerEntries(values, identity);
    if (entries.length === 0) return request;

    const mcpServers = { ...(request.config.mcpServers ?? {}) };
    for (const entry of entries) {
      mcpServers[entry.name] = entry.config;
      // Diagnostic: the endpoint and name are safe to log, the key is not.
      console.log(
        `[memory-flash-client] MCP injected: ${entry.name} → ${entry.url} (client ${identity.host})`,
      );
    }
    request.config.mcpServers = mcpServers;
    return request;
  });

  // -------------------------------------------------------------------------
  // Session-open contribution (Paseo 0.14, 0.3.2)
  //
  // The create hook writes the agent's *saved* configuration once. This hook
  // runs on every open (create, resume after the 0.14.0 idle-hour release,
  // refresh, import) and is the only place that can reach an agent created
  // before this plugin was installed — or one whose saved entry is gone, which
  // is the case where its tools are missing.
  //
  // It is deliberately conservative: a launch-only name that already exists in
  // the saved configuration aborts the open (`collides with agent saved
  // configuration`, host agent-manager.js), and nothing in the SDK can see the
  // saved set. So the record is read from disk (server/agent-record.ts) and
  // every unverifiable state — record missing/unreadable, provider capabilities
  // unknown, reason `create` — resolves to "do not inject". See
  // server/session-open.ts for the full matrix.
  // -------------------------------------------------------------------------

  const removeSessionOpenHook = server.before(
    "agent.session_open",
    async ({ request }, { paseo }) => {
      const values = await readSettings();
      const injectIntoAgents = values?.injectIntoAgents ?? false;

      let supportsMcpServers: boolean | null = null;
      const needsCapability =
        injectIntoAgents &&
        request.purpose !== "history" &&
        request.reason !== "create";
      if (needsCapability) {
        const snapshot = await paseo.agents
          .ref(request.agentId)
          .refresh()
          .catch(() => null);
        supportsMcpServers = snapshot?.agent.capabilities.supportsMcpServers ?? null;
      }

      const entries =
        values === null ? [] : buildServerEntries(values, resolveIdentity(values));
      const decision = decideClientSessionOpen({
        reason: request.reason,
        purpose: request.purpose,
        injectIntoAgents,
        serverNames: entries.map((entry) => entry.name),
        lookup: readSavedMcpServers(request.agentId),
        supportsMcpServers,
      });
      console.log(
        `[memory-flash-client] session_open ${request.agentId} (${request.reason}/${request.purpose}): ${decision.why}`,
      );

      if (decision.injectNames.length === 0) return request;

      const allowed = new Set(decision.injectNames);
      let mcpServers = request.mcpServers;
      for (const entry of entries) {
        if (!allowed.has(entry.name)) continue;
        mcpServers = { ...mcpServers, [entry.name]: entry.config };
        console.log(
          `[memory-flash-client] session_open MCP injected: ${entry.name} → ${entry.url}`,
        );
      }
      return { ...request, mcpServers };
    },
  );

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

  // --- Repair: reopen the agent's session so the hooks above run again ------
  // The supported answer to a remote server that stopped reaching an agent:
  // `reload()` reopens the provider session with its current configuration and
  // reruns `agent.session_open`, which re-contributes the remote HTTP servers.
  server.handle(agentReload, async (input, { paseo }) => {
    try {
      const result = await paseo.agents.ref(input.agentId).reload();
      if (result === null) {
        return { ok: false, error: `Agent ${input.agentId} not found or not reloadable.` };
      }
      console.log(
        `[memory-flash-client] reloaded agent ${input.agentId} (remote servers re-registered)`,
      );
      return { ok: true, error: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[memory-flash-client] agent reload failed: ${message}`);
      return { ok: false, error: message };
    }
  });

  server.handle(regenerateClientId, () => {
    const next = generateClientId();
    fallbackClientId = next;
    return { clientId: next };
  });

  // Agent skill: teaches this machine's agents that the injected remote
  // servers are a shared team base, and when to search and write.
  server.handle(skillPreview, () => ({ markdown: skillMarkdown() }));

  server.handle(skillStatus, () => ({ targets: skillStatuses() }));

  server.handle(installSkill, (input) => installRemoteSkill(input.targetId));

  server.handle(uninstallSkill, (input) => uninstallRemoteSkill(input.targetId));

  // -------------------------------------------------------------------------

  return () => {
    removeCreateHook();
    removeSessionOpenHook();
    unsubscribeSettings();
    fallbackClientId = null;
  };
}
