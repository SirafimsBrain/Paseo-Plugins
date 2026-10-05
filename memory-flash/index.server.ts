import type { PluginServerContext } from "@getpaseo/plugin/server";
import { memoryFlashSettings, type MemoryFlashSettings } from "./shared/settings";
import {
  clearHistory,
  delegateTask,
  deleteMemory,
  deleteRemoteHost,
  getMemory,
  generateApiKey,
  httpStatus,
  installSkill,
  listApiKeys,
  listMemories,
  listRemoteHosts,
  listSkillTargets,
  listTags,
  memoryStats,
  purgeMemories,
  restoreRevision,
  deleteApiKey,
  saveMemory,
  saveRemoteHost,
  searchMemories,
  searchDiagnoseSchema,
  skillStatus,
  skillPreview,
  uninstallSkill,
  checkRemoteHost,
  clineMcpStatus,
  codexMcpStatus,
  registerCodexMcp,
  unregisterCodexMcp,
  cursorMcpStatus,
  registerCursorMcp,
  unregisterCursorMcp,
  registerClineMcp,
  unregisterClineMcp,
  registerAllAgentMcp,
} from "./shared/memories";
import type { ApiKey } from "./shared/memories";
import { MemoryStore, type ApiKeyRecord } from "./server/store";
import { diagnose, formatReport } from "./server/diagnose";
import { HttpEndpoint } from "./server/http-lifecycle";
import { SERVER_VERSION } from "./server/mcp-jsonrpc";
import { mcpServerCommand, isExecutableFile, publishedMcpEntry } from "./server/mcp-launch";
import {
  clineMcpStatus as readClineMcpStatus,
  registerClineMcp as registerClineMcpOnDisk,
  unregisterClineMcp as unregisterClineMcpOnDisk,
} from "./server/cline-mcp";
import {
  cursorMcpStatus as readCursorMcpStatus,
  registerCursorMcp as registerCursorMcpOnDisk,
  unregisterCursorMcp as unregisterCursorMcpOnDisk,
} from "./server/cursor-mcp";
import {
  codexMcpStatus as readCodexMcpStatus,
  registerCodexMcp as registerCodexMcpOnDisk,
  unregisterCodexMcp as unregisterCodexMcpOnDisk,
} from "./server/codex-mcp";
import { withLiveSpawn } from "./server/mcp-probe";
import { skillStatuses, skillMarkdown, installSkill as installSkillOnDisk, uninstallSkill as uninstallSkillOnDisk } from "./server/skill";
import {
  listRemoteHosts as loadHosts,
  saveRemoteHost as persistHost,
  deleteRemoteHost as removeHost,
  checkRemoteHost as probeHost,
} from "./server/remote-hosts";

/**
 * Plugin server for Memory Flash.
 *
 * Responsibilities:
 * 1. Registers host-scoped settings and keeps the store's history cap in sync.
 * 2. Injects the memory MCP server into every Paseo-created agent via the
 *    `agent.create` before-hook (requirement 1 and 9 — the plugin runs with
 *    the Paseo server process and integrates with agent creation).
 * 3. Serves the plugin RPC surface for the Paseo UI (browse, search, edit,
 *    delete, history, stats, skill install, remote hosts, delegation).
 */

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(memoryFlashSettings);

  const store = new MemoryStore();
  let disposed = false;

  // -------------------------------------------------------------------------
  // HTTP MCP endpoint (remote access, 0.5.0). Started and stopped
  // with the httpEnabled/httpHost/httpPort settings; local agents
  // keep using stdio regardless of this setting.
  //
  // `HttpEndpoint` owns the socket and serialises the restarts: settings
  // arrive per keystroke, and overlapping start/stop calls used to leave a
  // stale listener behind and report the wrong address (see the class docs).
  // -------------------------------------------------------------------------

  const httpEndpoint = new HttpEndpoint({
    store,
    serverInfo: { name: "memory-flash", version: SERVER_VERSION },
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  });

  const syncHttpServer = (values: MemoryFlashSettings): void => {
    if (disposed) return;
    httpEndpoint.sync({
      httpEnabled: values.httpEnabled,
      httpHost: values.httpHost,
      httpPort: values.httpPort,
      defaultAgentId: values.defaultAgentId,
      serverName: values.mcpServerName,
    });
  };

  // Keep the per-memory history cap and the HTTP endpoint in sync
  // with settings.
  void settings.read().then((state) => {
    if (state.status !== "ready") return;
    store.historyLimitPerMemory = state.values.historyPerMemory;
    syncHttpServer(state.values);
  });
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status !== "ready") return;
    store.historyLimitPerMemory = state.values.historyPerMemory;
    syncHttpServer(state.values);
  });

  // -------------------------------------------------------------------------
  // MCP injection (requirement: all agents share one memory through MCP)
  // -------------------------------------------------------------------------

  // Publish the bundle at its revision-independent path on every load, not
  // only when an agent is created: agents created before an update hold that
  // path in their config and re-spawn from it on every turn, so it has to be
  // current before the first turn of the day. Visible in
  // `paseo plugin logs memory-flash` as `[memory-flash] MCP entry: …`.
  {
    const launch = mcpServerCommand();
    const entry = launch.args[0] ?? "";
    console.log(
      `[memory-flash] MCP entry: ${entry} (${isExecutableFile(entry) ? "exists" : "MISSING"})`,
    );
  }

  const removeCreateHook = server.before("agent.create", async ({ request }) => {
    // Async hooks are awaited by the host before the request proceeds, so the
    // mutation below is guaranteed to be applied to agent creation.
    const state = await settings.read().catch(() => null);
    if (state?.status !== "ready" || !state.values.injectIntoAgents) return request;
    const { command, args } = mcpServerCommand();
    // `as const` instead of a named `McpStdioServerConfig` annotation: the MCP
    // config types live in @getpaseo/protocol, which is not a host-supplied
    // specifier, so importing them would make this bundle need node_modules at
    // install time. Assigning into `request.config.mcpServers` below checks the
    // literal against the host's own type, which is a stronger guarantee.
    const config = {
      type: "stdio",
      command,
      args,
      alwaysLoad: true,
    } as const;
    request.config.mcpServers = {
      ...(request.config.mcpServers ?? {}),
      "memory-flash": config,
    };
    // Diagnostic: visible in `paseo plugin logs memory-flash` — helps to
    // troubleshoot MCP spawn failures on the agent side.
    const entry = args[0] ?? "";
    console.log(
      `[memory-flash] MCP injected: ${command} ${args.join(" ")} ` +
        `(${isExecutableFile(entry) ? "entry exists" : "entry MISSING"}; ` +
        `stable path ${publishedMcpEntry()})`,
    );
    return request;
  });

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  server.handle(listMemories, (input) => {
    const { memories, total } = store.list({
      query: "",
      kinds: input.kinds,
      tags: input.tags,
      tagMode: input.tagMode,
      project: input.project,
      agentId: input.agentId,
      limit: input.limit,
      offset: input.offset,
    });
    return { memories, total };
  });

  server.handle(searchMemories, (input) => {
    const results = store.search(input);
    return { results };
  });

  server.handle(searchDiagnoseSchema, (input) => {
    const control = input.queries.map((q) => ({ query: q.query, expectedIds: q.expectedIds }));
    const report = diagnose(store, control);
    const skipped = control.filter((c) => c.query.trim().length === 0 || c.expectedIds.length === 0).length;
    return {
      summary: formatReport(report),
      recallAt: report.recallAt,
      hitsAt: report.hitsAt,
      total: report.total,
      poolCeiling: report.poolCeiling,
      retrievalFailures: report.retrievalFailures,
      rankingFailures: report.rankingFailures,
      misses: report.misses,
      skipped,
    };
  });

  server.handle(saveMemory, (input) => {
    try {
      if (input.id === undefined) {
        const memory = store.create(input.input, input.input.changedBy ?? "paseo-ui");
        return { ok: true, id: memory.id, error: null };
      }
      const memory = store.update(input.id, input.input, input.input.changedBy ?? "paseo-ui");
      return { ok: true, id: memory.id, error: null };
    } catch (cause) {
      return { ok: false, id: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  server.handle(deleteMemory, (input) => {
    try {
      const deleted = store.delete(input.id, "paseo-ui");
      return { ok: deleted, error: deleted ? null : `Memory ${input.id} not found.` };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  server.handle(getMemory, (input) => {
    return {
      memory: store.getById(input.id),
      history: store.historyOf(input.id),
    };
  });

  server.handle(restoreRevision, (input) => {
    try {
      const memory = store.restoreRevision(input.revisionId, "paseo-ui");
      return { ok: true, id: memory.id, error: null };
    } catch (cause) {
      return { ok: false, id: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  server.handle(memoryStats, () => store.stats());

  server.handle(listTags, () => ({ tags: store.allTags() }));

  server.handle(clearHistory, (input) => ({ removed: store.clearHistory(input.olderThan) }));

  server.handle(purgeMemories, (input) => {
    try {
      return { removed: store.purge({ tags: input.tags, project: input.project, kind: input.kind }) };
    } catch (cause) {
      // Purge with no filter is refused by the store; surface the reason.
      throw new Error(cause instanceof Error ? cause.message : String(cause));
    }
  });

  // --- Delegation: ask an agent to edit the database through its MCP tools --

  server.handle(delegateTask, async (input, { paseo }) => {
    try {
      const agents = await paseo.agents.list();
      const target = agents.entries.find(
        (entry) =>
          (entry as unknown as { id?: string }).id === input.agentId ||
          (entry as unknown as { agentId?: string }).agentId === input.agentId,
      );
      const open = (target as unknown as { archivedAt?: string | null } | undefined)?.archivedAt == null;
      if (!target) {
        return { ok: false, error: `Agent ${input.agentId} not found.` };
      }
      if (!open) {
        return { ok: false, error: `Agent ${input.agentId} is archived or closed.` };
      }
      const references =
        input.memoryIds.length > 0
          ? `\n\nMemory ids to consider: ${input.memoryIds.map((id) => `#${id}`).join(", ")}. Read each with memory_get before changing it.`
          : "";
      const prompt =
        "Memory Flash maintenance task — you have the memory-flash MCP tools.\n\n" +
        `${input.instruction}${references}\n\n` +
        "Work carefully: prefer memory_update over delete; when deleting several " +
        "memories, list them first (memory_search / memory_list_by_tag) and keep " +
        "the changes minimal. Report what you changed.";
      const agentId = (target as unknown as { id?: string }).id ?? input.agentId;
      await paseo.agents.ref(agentId).send(prompt);
      return { ok: true, error: null };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  // --- Skill management ------------------------------------------------------

  server.handle(listSkillTargets, () => {
    // `listSkillTargets` returns static targets; the status RPC adds install state.
    return { targets: skillStatuses().map(({ id, label, path, detected }) => ({ id, label, path, detected })) };
  });

  server.handle(skillStatus, () => ({ targets: skillStatuses() }));

  server.handle(skillPreview, () => ({ markdown: skillMarkdown() }));

  server.handle(installSkill, (input) => installSkillOnDisk(input.targetId));

  server.handle(uninstallSkill, (input) => {
    const result = uninstallSkillOnDisk(input.targetId);
    return { ok: result.ok, error: result.error };
  });

  // --- Direct MCP registration for session-agnostic agents -------------
  // Cline, Cursor and Codex CLI ignore stdio MCP servers delivered
  // through the agent session; each reads them from its own config
  // file, so the plugin registers the server there directly. The
  // Cline status additionally probes the registered command with a
  // live MCP initialize handshake.

  server.handle(clineMcpStatus, async () => withLiveSpawn(readClineMcpStatus()));

  server.handle(registerClineMcp, () => registerClineMcpOnDisk());

  server.handle(unregisterClineMcp, () => unregisterClineMcpOnDisk());

  server.handle(cursorMcpStatus, () => readCursorMcpStatus());

  server.handle(registerCursorMcp, () => registerCursorMcpOnDisk());

  server.handle(unregisterCursorMcp, () => unregisterCursorMcpOnDisk());

  server.handle(codexMcpStatus, () => readCodexMcpStatus());

  server.handle(registerCodexMcp, () => registerCodexMcpOnDisk());

  server.handle(unregisterCodexMcp, () => unregisterCodexMcpOnDisk());

  server.handle(registerAllAgentMcp, () => ({
    results: [
      { agent: "Cline", ...registerClineMcpOnDisk() },
      { agent: "Cursor", ...registerCursorMcpOnDisk() },
      { agent: "Codex CLI", ...registerCodexMcpOnDisk() },
    ],
  }));

  // --- Remote hosts ----------------------------------------------------------

  server.handle(listRemoteHosts, () => ({ hosts: loadHosts() }));

  server.handle(saveRemoteHost, (input) => persistHost(input.host));

  server.handle(deleteRemoteHost, (input) => ({ ok: removeHost(input.id) }));

  server.handle(checkRemoteHost, (input) => probeHost(input.id));

  // --- Remote access: API keys for the HTTP MCP endpoint --------
  // The secret is returned exactly once by the generate RPC and
  // never persisted — the store keeps only its SHA-256 hash.

  server.handle(listApiKeys, () => ({
    keys: store.listApiKeys().map(toApiKey),
  }));

  server.handle(generateApiKey, (input) => {
    try {
      const { record, secret } = store.generateApiKey({
        label: input.label,
        ttlDays: input.ttlDays,
        scope: input.scope,
      });
      return { ok: true, id: record.id, secret, key: toApiKey(record), error: null };
    } catch (cause) {
      return {
        ok: false,
        id: null,
        secret: null,
        key: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });

  // Deletes the row outright rather than flagging it revoked, so the label
  // can be reused immediately and dead keys do not pile up in the list.
  server.handle(deleteApiKey, (input) => {
    try {
      return { ok: store.deleteApiKey(input.id), error: null };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  server.handle(httpStatus, () => ({
    ...httpEndpoint.status(),
    keyCount: store.activeKeyCount(),
  }));

  // ---------------------------------------------------------------------------

  return () => {
    disposed = true;
    removeCreateHook();
    unsubscribeSettings();
    void httpEndpoint.dispose();
    store.close();
  };
}

/** UI-facing view of an API key: the secret hash never leaves the store. */
function toApiKey(record: ApiKeyRecord): ApiKey {
  const { keyHash: _keyHash, ...key } = record;
  return key;
}
