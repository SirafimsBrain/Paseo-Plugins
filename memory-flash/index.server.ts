import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { memoryFlashSettings, type MemoryFlashSettings } from "./shared/settings";
import {
  memoryChanges,
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
  agentReload,
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
  registerOpencodeMcp,
  unregisterOpencodeMcp,
  opencodeMcpStatus,
  registerKiloMcp,
  unregisterKiloMcp,
  kiloMcpStatus,
  registerKimiMcp,
  unregisterKimiMcp,
  kimiMcpStatus,
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
import {
  kimiMcpStatus as readKimiMcpStatus,
  registerKimiMcp as registerKimiMcpOnDisk,
  unregisterKimiMcp as unregisterKimiMcpOnDisk,
} from "./server/kimi-mcp";
import {
  opencodeMcpStatus as readOpencodeMcpStatus,
  registerOpencodeMcp as registerOpencodeMcpOnDisk,
  unregisterOpencodeMcp as unregisterOpencodeMcpOnDisk,
  kiloMcpStatus as readKiloMcpStatus,
  registerKiloMcp as registerKiloMcpOnDisk,
  unregisterKiloMcp as unregisterKiloMcpOnDisk,
  agentConfigCoversProvider,
} from "./server/opencode-mcp";
import { withLiveSpawn } from "./server/mcp-probe";
import { startChangeFeed } from "./server/changes";
import { saveWorkspaceNameMap } from "./server/workspace-map";
import { readSavedMcpServers } from "./server/agent-record";
import { decideSessionOpen } from "./server/session-open";
import { sharedOpenCodeMcpBlockFor } from "./server/opencode-service";
import { createMemoryRecallTool } from "./server/agent-tools";
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
  // Live change feed (Paseo 0.16.0 subscriptions, 0.13.5)
  //
  // The screen refetches through its own RPCs when this fires; the event only
  // says "something changed". Writes made by an agent's MCP server happen in
  // another process, which is why the signal comes from the shared SQLite
  // change log rather than from an in-memory emitter.
  // -------------------------------------------------------------------------

  server.handle(memoryChanges, (_input, context) => {
    const stop = startChangeFeed(store, (event) => context.push(event), context.signal);
    context.signal.addEventListener("abort", stop, { once: true });
    console.log(`[memory-flash] changes subscription opened`);
  });

  // -------------------------------------------------------------------------
  // Workspace names for the default project (0.13.5)
  //
  // The MCP server sees `PASEO_WORKSPACE_ID` but cannot ask Paseo for a name,
  // so the plugin writes the id → name map it can build from the API. Refreshed
  // at most every few minutes from session opens, which is when new workspaces
  // first matter.
  // -------------------------------------------------------------------------

  let lastWorkspaceRefresh = 0;
  const WORKSPACE_REFRESH_MS = 5 * 60 * 1000;

  const refreshWorkspaceNames = async (paseo: PaseoApi): Promise<void> => {
    if (Date.now() - lastWorkspaceRefresh < WORKSPACE_REFRESH_MS) return;
    lastWorkspaceRefresh = Date.now();
    try {
      const result = await paseo.workspaces.list();
      saveWorkspaceNameMap(
        result.entries.map((entry) => ({
          id: entry.id,
          name: entry.name ?? entry.projectDisplayName ?? null,
          directory: entry.workspaceDirectory ?? null,
        })),
      );
    } catch {
      // No workspace list on this host: the MCP server falls back to the cwd.
    }
  };

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

  /**
   * Records how memory was wired into an agent (Paseo 0.16.0 agent metadata).
   *
   * One key, replaced wholesale on every open: it is provenance for the repair
   * action and a future sidebar badge, never a copy of the agent's config.
   */
  const markAgent = (
    request: { metadata?: Record<string, unknown> },
    patch: Record<string, string | boolean>,
  ): void => {
    request.metadata = {
      ...(request.metadata ?? {}),
      "memory-flash": { ...patch, at: new Date().toISOString() },
    };
  };

  const removeCreateHook = server.before("agent.create", async ({ request }) => {
    // Async hooks are awaited by the host before the request proceeds, so the
    // mutation below is guaranteed to be applied to agent creation.
    const state = await settings.read().catch(() => null);
    if (state?.status !== "ready" || !state.values.injectIntoAgents) {
      markAgent(request, { injected: false, reason: "injection off" });
      return request;
    }
    // 0.8.1: for OpenCode/Kilo the config-file registration is strictly
    // better than the session-level entry injected here — after an idle
    // location eviction the session-level entry dies and shadows the live
    // config one, breaking every memory-flash_* call until the session is
    // re-opened. Skip the injection when the config file carries a current
    // registration; keep it as the fallback everywhere else.
    const cover = agentConfigCoversProvider(request.config.provider);
    if (cover.covered) {
      console.log(
        `[memory-flash] agent.create injection skipped for ${request.config.provider}: ` +
          `config-file registration active at ${cover.path}`,
      );
      markAgent(request, {
        injected: false,
        reason: "config-file registration",
        server: "memory-flash",
      });
      return request;
    }
    // 0.11.4: a *shared* OpenCode v2 service (Paseo 0.15.0, #7435) refuses every
    // agent whose config carries custom MCP servers, so writing the entry here
    // would make creation fail outright. Degrade instead: memory stays reachable
    // through the config-file registration or the recall tool attached on
    // session open. See server/opencode-service.ts.
    const openCodeBlock = sharedOpenCodeMcpBlockFor(request.config.provider);
    if (openCodeBlock !== null) {
      console.log(
        `[memory-flash] agent.create injection skipped for ${request.config.provider}: ${openCodeBlock}`,
      );
      markAgent(request, { injected: false, reason: openCodeBlock, server: "memory-flash" });
      return request;
    }
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
    markAgent(request, { injected: true, server: "memory-flash" });
    return request;
  });

  // -------------------------------------------------------------------------
  // Session-open contribution (Paseo 0.14, 0.9.4)
  //
  // `agent.create` writes the agent's *saved* configuration once, at creation.
  // This hook runs on every open — create, resume after the daemon restart or
  // the 0.14.0 idle-hour release, refresh, import — and is the only place that
  // can reach an agent created before memory-flash was installed, or one whose
  // saved entry is gone (the documented "No tool named memory-flash_memory_save"
  // case, §13 of __doc.md).
  //
  // Two host rules make the decision matrix in server/session-open.ts necessary:
  // * a launch-only name that already exists in the agent's *saved*
  //   configuration aborts the open (`MCP server '…' collides with agent saved
  //   configuration`, host agent-manager.js), and neither the hook nor the SDK
  //   can see the saved set — so it is read from the daemon's agent record
  //   (server/agent-record.ts) and the contribution is skipped whenever it is
  //   present, unreadable or unknown;
  // * a provider without MCP support aborts the open as well, hence the
  //   `supportsMcpServers` capability check before contributing anything.
  //
  // What survives every failure mode is the attached read-only tool: it is
  // re-derived on each open, never persisted, and cannot collide with an MCP
  // server, so an agent that gets no server still gets memory.
  // -------------------------------------------------------------------------

  const memoryRecallTool = createMemoryRecallTool(store);

  const removeSessionOpenHook = server.before(
    "agent.session_open",
    async ({ request }, { paseo }) => {
      const state = await settings.read().catch(() => null);
      const values = state?.status === "ready" ? state.values : null;
      const injectIntoAgents = values?.injectIntoAgents ?? false;
      const serverName = (values?.mcpServerName ?? "").trim() || "memory-flash";

      const cover =
        injectIntoAgents && request.purpose !== "history"
          ? agentConfigCoversProvider(request.provider)
          : { covered: false, path: null };
      const lookup = readSavedMcpServers(request.agentId);

      // A shared OpenCode v2 service cannot carry an injected MCP server at all
      // (Paseo 0.15.0, #7435), and knowing that also makes the capability probe
      // pointless: no MCP contribution is possible on this open.
      const openCodeMcpBlock = sharedOpenCodeMcpBlockFor(request.provider);

      // Capability is only needed when an MCP contribution is still possible;
      // every other branch is decided without touching the daemon.
      let supportsMcpServers: boolean | null = null;
      const needsCapability =
        injectIntoAgents &&
        request.purpose !== "history" &&
        request.reason !== "create" &&
        !cover.covered &&
        openCodeMcpBlock === null;
      if (needsCapability) {
        const snapshot = await paseo.agents
          .ref(request.agentId)
          .refresh()
          .catch(() => null);
        supportsMcpServers = snapshot?.agent.capabilities.supportsMcpServers ?? null;
      }

      // 0.13.5: keep the workspace id → name map current for the default project.
      void refreshWorkspaceNames(paseo);

      const decision = decideSessionOpen({
        reason: request.reason,
        purpose: request.purpose,
        provider: request.provider,
        injectIntoAgents,
        serverName,
        configCovered: cover.covered,
        lookup,
        supportsMcpServers,
        openCodeMcpBlock,
      });
      console.log(
        `[memory-flash] session_open ${request.agentId} (${request.reason}/${request.purpose}): ${decision.why}`,
      );

      // Provenance on already-created agents: the create hook only runs once,
      // but a resumed agent can gain the tool or lose the server. The skip
      // reasons are recorded too — "why does this agent have no memory tools"
      // is exactly the question the repair action has to answer. Failures are
      // expected on hosts without `entityMetadata` and are not errors here.
      void paseo.agents
        .ref(request.agentId)
        .setMetadata({
          "memory-flash": {
            injected: decision.injectMcp,
            tool: decision.attachTool,
            reason: decision.why.slice(0, 120),
            at: new Date().toISOString(),
          },
        })
        .catch(() => {});

      if (!decision.injectMcp && !decision.attachTool) return request;

      const tools = decision.attachTool ? [...request.tools, memoryRecallTool] : request.tools;
      let mcpServers = request.mcpServers;
      if (decision.injectMcp) {
        const { command, args } = mcpServerCommand();
        const config = {
          type: "stdio",
          command,
          args,
          alwaysLoad: true,
        } as const;
        mcpServers = { ...request.mcpServers, [serverName]: config };
        const entry = args[0] ?? "";
        console.log(
          `[memory-flash] session_open MCP injected: ${command} ${args.join(" ")} ` +
            `(${isExecutableFile(entry) ? "entry exists" : "entry MISSING"})`,
        );
      }

      return { ...request, tools, mcpServers };
    },
  );

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
        return { ok: false, error: `Agent ${input.agentId} not found.`, agentId: null, background: false };
      }
      if (!open) {
        return {
          ok: false,
          error: `Agent ${input.agentId} is archived or closed.`,
          agentId: null,
          background: false,
        };
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

      // Hidden maintenance child (Paseo 0.16.0, 0.13.5): the task no longer
      // occupies a visible tab. It needs the target's provider and directory;
      // if the host refuses the creation, the task falls back to the chosen
      // agent instead of being lost.
      if (input.background) {
        const snapshot = await paseo.agents.ref(agentId).refresh().catch(() => null);
        const provider = snapshot?.agent.provider;
        const cwd = snapshot?.agent.cwd;
        if (provider && cwd) {
          try {
            const created = await paseo.agents.create({
              config: { provider },
              cwd,
              background: true,
              title: "Memory maintenance",
              prompt,
            });
            console.log(
              `[memory-flash] delegated maintenance to background agent ${created.id} (from ${agentId})`,
            );
            return { ok: true, error: null, agentId: created.id, background: true };
          } catch (cause) {
            console.log(
              `[memory-flash] background delegation refused (${cause instanceof Error ? cause.message : String(cause)}); falling back to ${agentId}`,
            );
          }
        }
      }

      await paseo.agents.ref(agentId).send(prompt);
      return { ok: true, error: null, agentId, background: false };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
        agentId: null,
        background: false,
      };
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
  // Cline, Cursor and Codex CLI ignore stdio MCP servers delivered through
  // the agent session, and Kimi Code CLI keeps its own user-level registry;
  // each reads MCP servers from its own config file, so the plugin registers
  // the server there directly. The Cline status additionally probes the
  // registered command with a live MCP initialize handshake.

  server.handle(clineMcpStatus, async () => withLiveSpawn(readClineMcpStatus()));

  server.handle(registerClineMcp, () => registerClineMcpOnDisk());

  server.handle(unregisterClineMcp, () => unregisterClineMcpOnDisk());

  server.handle(cursorMcpStatus, () => readCursorMcpStatus());

  server.handle(registerCursorMcp, () => registerCursorMcpOnDisk());

  server.handle(unregisterCursorMcp, () => unregisterCursorMcpOnDisk());

  server.handle(codexMcpStatus, () => readCodexMcpStatus());

  server.handle(registerCodexMcp, () => registerCodexMcpOnDisk());

  server.handle(unregisterCodexMcp, () => unregisterCodexMcpOnDisk());

  // OpenCode and Kilo keep MCP servers in their own `mcp` config object.
  // Registering there is what keeps the memory tools alive across OpenCode's
  // per-directory location eviction (see server/opencode-mcp.ts).
  server.handle(opencodeMcpStatus, () => readOpencodeMcpStatus());

  server.handle(registerOpencodeMcp, () => registerOpencodeMcpOnDisk());

  server.handle(unregisterOpencodeMcp, () => unregisterOpencodeMcpOnDisk());

  server.handle(kiloMcpStatus, () => readKiloMcpStatus());

  server.handle(registerKiloMcp, () => registerKiloMcpOnDisk());

  server.handle(unregisterKiloMcp, () => unregisterKiloMcpOnDisk());

  // Kimi Code CLI keeps its user-level MCP servers in
  // `$KIMI_CODE_HOME/mcp.json` (`~/.kimi-code/mcp.json` by default), flat
  // `{command, args}` entries under `mcpServers`.
  server.handle(kimiMcpStatus, () => readKimiMcpStatus());

  server.handle(registerKimiMcp, () => registerKimiMcpOnDisk());

  server.handle(unregisterKimiMcp, () => unregisterKimiMcpOnDisk());

  server.handle(registerAllAgentMcp, () => ({
    results: [
      { agent: "Cline", ...registerClineMcpOnDisk() },
      { agent: "Cursor", ...registerCursorMcpOnDisk() },
      { agent: "Codex CLI", ...registerCodexMcpOnDisk() },
      { agent: "OpenCode", ...registerOpencodeMcpOnDisk() },
      { agent: "Kilo", ...registerKiloMcpOnDisk() },
      { agent: "Kimi Code CLI", ...registerKimiMcpOnDisk() },
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

  // --- Repair: reopen the agent's session so the hooks above run again ------
  // The supported answer to §13 (tools gone after an idle location eviction):
  // `reload()` reopens the provider session with its current configuration and
  // reruns `agent.session_open`, which re-registers the MCP server with Paseo.
  server.handle(agentReload, async (input, { paseo }) => {
    try {
      const result = await paseo.agents.ref(input.agentId).reload();
      if (result === null) {
        return { ok: false, error: `Agent ${input.agentId} not found or not reloadable.` };
      }
      console.log(`[memory-flash] reloaded agent ${input.agentId} (memory tools re-registered)`);
      return { ok: true, error: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[memory-flash] agent reload failed: ${message}`);
      return { ok: false, error: message };
    }
  });

  // ---------------------------------------------------------------------------

  return () => {
    disposed = true;
    removeCreateHook();
    removeSessionOpenHook();
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
