// MUST stay the first import: this module defines the CommonJS
// `__dirname`/`__filename` globals that Paseo's plugin bundle
// evaluator omits, and evaluation order of ESM imports is declaration
// order — bundled dependencies (see server/cjs-globals.ts) must not
// evaluate before it runs.
import "./server/cjs-globals";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { bunnySearchSettings } from "./shared/settings";
import type { BunnySearchSettings } from "./shared/settings";
import {
  agentReload,
  connectionStatus,
  connectionTest,
  runSearch,
  statusStream,
  type ConnectionTestResult,
  type ProvisioningEvent,
  type RuntimeSettings,
} from "./shared/contracts";
import {
  checkSearchService,
  formatSearchResponse,
  providerBaseUrl,
  resetSearchCache,
  searchWeb,
} from "./server/providers";
import {
  notifyStatusChange,
  provisioningMarker,
  readProvisioningMarker,
  recentProvisioning,
  recordProvisioning,
  subscribeProvisioning,
  withProvisioningMarker,
  type AgentMetadata,
  type MetadataValue,
  type ProvisioningMode,
} from "./server/provisioning";
import { INJECTED_SERVER_NAME, mcpServerCommand } from "./server/mcp-launch";
import { createWebSearchTool } from "./server/agent-tools";
import { readSavedMcpServers } from "./server/agent-record";
import { decideSessionOpen, needsCapabilityProbe, providerExcluded } from "./server/session-open";
import { sharedOpenCodeMcpBlockFor } from "./server/opencode-service";
import { probeMcpServer } from "./server/probe";
import { parseSettingsFile } from "./server/settings-file";
import { settingsMirrorPath, writeSettingsMirror } from "./server/settings-mirror";
import { searchInterfaceUrl } from "./server/ui-url";

/**
 * Plugin server for Bunny Search.
 *
 * Responsibilities:
 * 1. Registers host-scoped settings (search provider, base URL,
 *    API key, timeouts) — edited in Paseo Settings → Plugins →
 *    Bunny Search.
 * 2. Keeps the settings file the spawned MCP server reads in
 *    sync with the host's settings store (the host owns that
 *    store; the MCP process, spawned by agent providers,
 *    cannot use the plugin API and reads the file instead).
 * 3. Injects the bunny-search MCP server into every agent created
 *    through Paseo via the `agent.create.before` hook, and re-contributes
 *    it (or the attached `bunny_web_search` tool) on every
 *    `agent.open.before` — the path that also reaches agents created
 *    before injection was turned on. Both are registered through
 *    `server.addHook` (Paseo 0.15.0; `server.before` is deprecated).
 * 4. Serves the plugin RPC surface for the Paseo UI, including
 *    the connection test (real HTTP probe of the configured
 *    search service + live MCP handshake check) and the repair
 *    reload used by the Command Center action.
 */

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(bunnySearchSettings);

  let disposed = false;
  /** Last connection-test result, kept for the status RPC. */
  let lastCheck: ConnectionTestResult | null = null;

  // -------------------------------------------------------------------------
  // Settings: live host store, mirrored to a file for the MCP process
  // -------------------------------------------------------------------------

  /**
   * Reads the effective runtime settings from the host's
   * settings store. Falls back to the mirrored file (plus
   * environment variables) when the store holds invalid
   * values, so the plugin still works after a bad edit.
   */
  async function readRuntimeSettings(): Promise<RuntimeSettings> {
    const state = await settings.read();
    if (state.status !== "ready") return parseSettingsFile();
    return {
      searchService: state.values.searchService,
      duckduckjsEngine: state.values.duckduckjsEngine,
      proxyUrl: state.values.proxyUrl,
      ddgsPythonPath: state.values.ddgsPythonPath,
      searxngBaseUrl: state.values.searxngBaseUrl,
      customBaseUrl: state.values.customBaseUrl,
      apiKey: state.values.apiKey,
      timeoutMs: state.values.timeoutMs,
      maxResults: state.values.maxResults,
      categories: state.values.categories,
      language: state.values.language,
      cacheTtlSeconds: state.values.cacheTtlSeconds,
    };
  }

  /** Reads full settings (with the UI URL) for interface derivation. */
  async function readFullSettings(): Promise<BunnySearchSettings | null> {
    const state = await settings.read();
    return state.status === "ready" ? state.values : null;
  }

  /**
   * Writes the current settings into the file the MCP server
   * process reads. Best-effort: a failure here only means the
   * MCP process keeps the previous configuration until the
   * next successful write.
   */
  async function mirrorSettings(): Promise<void> {
    const values = await readFullSettings();
    if (!values) return;
    try {
      writeSettingsMirror(values);
      console.log(`[bunny-search] settings mirrored: ${settingsMirrorPath()}`);
    } catch (cause) {
      console.warn(
        `[bunny-search] could not write settings mirror: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  // Write once at startup (so the first agents already see the
  // user's configuration), then keep the mirror in sync with
  // every change made in the Paseo settings UI.
  void mirrorSettings();
  const removeSettingsListener = settings.subscribe((state) => {
    if (state.status === "ready") {
      // A settings edit can change the service, its URL or the key, so every
      // cached answer is suspect: drop them and let open screens repaint.
      resetSearchCache();
      notifyStatusChange();
      void mirrorSettings();
    }
  });

  // -------------------------------------------------------------------------
  // MCP injection (the plugin's reason to exist: agents get web search)
  // -------------------------------------------------------------------------

  /**
   * Returns `request` with this plugin's provisioning marker replaced (0.7.5).
   *
   * The create hook has no agent id, so it only writes the marker into the
   * metadata Paseo persists on the agent; the session-open hook additionally
   * appends to the event log the status stream reads.
   */
  function withMode(
    request: { metadata?: AgentMetadata },
    mode: ProvisioningMode,
    reason: string,
  ): Record<string, MetadataValue> {
    return withProvisioningMarker(request.metadata, provisioningMarker(mode, reason));
  }

  const removeCreateHook = server.addHook("agent.create.before", async ({ request }) => {
    // Async hooks are awaited by the host before the request proceeds,
    // so the mutation below is guaranteed to be applied to agent creation.
    const state = await settings.read().catch(() => null);
    if (state?.status !== "ready" || !state.values.injectIntoAgents) return request;
    // `PluginHookRequests["agent.create.before"]` carries only `config` and `env` —
    // no labels — so a configured label gate cannot be evaluated here. Defer the
    // whole creation-time injection to `agent.open.before`, which reads
    // `request.labels` (see server/session-open.ts: `createHookOwnsCreation`).
    if (state.values.labelGateKey.trim().length > 0) {
      console.log(
        `[bunny-search] label gate '${state.values.labelGateKey.trim()}' set: ` +
          "session_open owns the creation-time contribution",
      );
      return request;
    }
    // `background` is a session-open flag in Paseo 0.16.0; the creation request
    // may carry it inside the config, so honour it when it is there. Otherwise the
    // session open excludes it (the agent keeps whatever creation gave it).
    if (
      state.values.skipBackgroundAgents &&
      (request.config as { background?: unknown }).background === true
    ) {
      const reason = "background agent excluded by skipBackgroundAgents";
      console.log(`[bunny-search] create skipped: ${reason}`);
      return { ...request, metadata: withMode(request, "skipped", reason) };
    }
    if (providerExcluded(request.config.provider, state.values.skipProviders)) {
      const reason = `provider '${request.config.provider}' is excluded by skipProviders`;
      console.log(`[bunny-search] create skipped: ${reason}`);
      return { ...request, metadata: withMode(request, "skipped", reason) };
    }
    // 0.6.3: a *shared* OpenCode v2 service (Paseo 0.15.0, #7435) refuses every
    // agent whose config carries custom MCP servers, so writing the entry here
    // would make creation fail outright. Degrade instead: the agent gets
    // `bunny_web_search` on its first open. See server/opencode-service.ts.
    const openCodeBlock = sharedOpenCodeMcpBlockFor(request.config.provider);
    if (openCodeBlock !== null) {
      console.log(
        `[bunny-search] create skipped: ${openCodeBlock} (bunny_web_search stays available)`,
      );
      // The session open attaches the tool and rewrites this marker as `tool`.
      return { ...request, metadata: withMode(request, "skipped", openCodeBlock) };
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
      [INJECTED_SERVER_NAME]: config,
    };
    // Diagnostic: visible in `paseo plugin logs bunny-search` — helps to
    // troubleshoot MCP spawn failures on the agent side.
    console.log(`[bunny-search] MCP injected: ${command} ${args.join(" ")}`);
    return {
      ...request,
      metadata: withMode(request, "mcp", "MCP server contributed at creation"),
    };
  });

  // -------------------------------------------------------------------------
  // Session-open contribution (Paseo 0.14, 0.5.2)
  //
  // `agent.create.before` writes the agent's *saved* configuration once, at creation.
  // This hook runs on every open — create, resume after the daemon restart, agent
  // recovery, the 0.14.0 idle-hour runtime release, refresh, import — and is the only
  // place that can reach an agent created before bunny-search was installed or before
  // `injectIntoAgents` was switched on (today such an agent keeps searching without a
  // server until it is recreated).
  //
  // The constraints below are the ones memory-flash 0.9.4 learned first in this same
  // repository: a name that collides with a *saved* server fails the session open, so
  // the agent's saved `mcpServers` are read from the daemon record
  // (server/agent-record.ts) and the contribution is skipped whenever that state is
  // present, unreadable or unknown; `purpose: "history"` never gets a contribution;
  // and a provider without MCP support aborts the open, hence the capability probe.
  //
  // What survives every failure mode is the attached `bunny_web_search` tool: it is
  // re-derived on each open, never persisted, and cannot collide with an MCP server.
  // -------------------------------------------------------------------------

  const webSearchTool = createWebSearchTool(readRuntimeSettings);

  const removeSessionOpenHook = server.addHook(
    "agent.open.before",
    async ({ request }, { paseo }) => {
      const state = await settings.read().catch(() => null);
      const values = state?.status === "ready" ? state.values : null;
      // Marker written by a previous provisioning of this agent (0.7.5): a
      // recorded `mcp` mode makes the daemon capability probe unnecessary.
      const known = readProvisioningMarker(request.metadata);
      const background = request.background === true;
      const base = {
        reason: request.reason,
        purpose: request.purpose,
        provider: request.provider,
        labels: request.labels,
        injectIntoAgents: values?.injectIntoAgents ?? false,
        serverName: INJECTED_SERVER_NAME,
        labelGateKey: values?.labelGateKey ?? "",
        skipProviders: values?.skipProviders ?? "",
        background,
        skipBackgroundAgents: values?.skipBackgroundAgents ?? false,
        knownMode: known?.mode ?? null,
        lookup: readSavedMcpServers(request.agentId),
        // A shared OpenCode v2 service cannot carry an injected MCP server at
        // all (Paseo 0.15.0, #7435) — the tool-only path takes over.
        openCodeMcpBlock: sharedOpenCodeMcpBlockFor(request.provider),
      };

      // The daemon is only consulted when an MCP contribution is still possible;
      // every other branch (gated off, history, create owned by the create hook,
      // server already saved) is decided without touching it.
      // An agent this plugin already provisioned with the MCP server gives the
      // answer without a round trip: the marker records that the provider accepted
      // it for this agent (0.7.5).
      let supportsMcpServers: boolean | null = known?.mode === "mcp" ? true : null;
      if (supportsMcpServers === null && needsCapabilityProbe({ ...base, supportsMcpServers: null })) {
        const snapshot = await paseo.agents
          .ref(request.agentId)
          .refresh()
          .catch(() => null);
        supportsMcpServers = snapshot?.agent.capabilities.supportsMcpServers ?? null;
      }

      const decision = decideSessionOpen({ ...base, supportsMcpServers });
      const mode: ProvisioningMode = decision.injectMcp
        ? "mcp"
        : decision.attachTool
          ? "tool"
          : "skipped";
      console.log(
        `[bunny-search] session_open ${request.agentId} (${request.reason}/${request.purpose}${background ? "/background" : ""}) [${mode}]: ${decision.why}`,
      );
      // The live status stream shows which agents got what, including the ones that
      // only received the attached tool — the rows the repair action used to hunt
      // for by hand.
      recordProvisioning({
        agentId: request.agentId,
        provider: request.provider,
        mode,
        reason: decision.why,
        background,
        at: new Date().toISOString(),
      });
      const metadata = withProvisioningMarker(
        request.metadata,
        provisioningMarker(mode, decision.why),
      );

      if (!decision.injectMcp && !decision.attachTool) return { ...request, metadata };

      const tools = decision.attachTool ? [...request.tools, webSearchTool] : request.tools;
      let mcpServers = request.mcpServers;
      if (decision.injectMcp) {
        const { command, args } = mcpServerCommand();
        const config = {
          type: "stdio",
          command,
          args,
          alwaysLoad: true,
        } as const;
        mcpServers = { ...request.mcpServers, [INJECTED_SERVER_NAME]: config };
        console.log(`[bunny-search] session_open MCP injected: ${command} ${args.join(" ")}`);
      }

      return { ...request, tools, mcpServers, metadata };
    },
  );

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  /** Current status snapshot — the same shape `connectionStatus` returns. */
  async function statusSnapshot() {
    const runtime = await readRuntimeSettings();
    const full = await readFullSettings();
    return {
      provider: runtime.searchService,
      baseUrl: providerBaseUrl(runtime),
      uiUrl: full ? searchInterfaceUrl(full) : null,
      lastCheck,
    };
  }

  /**
   * Tests the connection to the configured search service.
   *
   * Two checks are combined, because "search works" means both
   * halves are healthy:
   * 1. A real probe request against the configured provider
   *    (DuckDuckJS by default) with the configured timeout.
   * 2. A live MCP handshake: the bundled server is spawned the
   *    way an agent would spawn it and must answer `initialize`.
   */
  server.handle(connectionTest, async () => {
    const runtime = await readRuntimeSettings();
    const checkedAt = new Date().toISOString();

    const service = await checkSearchService(runtime);
    let mcp: ConnectionTestResult["mcp"] = null;
    try {
      const { command, args } = mcpServerCommand();
      const live = await probeMcpServer(command, args);
      mcp = { ok: live, error: live ? null : "MCP server did not answer the initialize handshake." };
    } catch (cause) {
      mcp = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }

    const result: ConnectionTestResult = {
      ok: service.ok && (mcp?.ok ?? true),
      provider: runtime.searchService,
      status: service.ok ? "ok" : "error",
      latencyMs: service.latencyMs,
      error: service.error ?? (mcp && !mcp.ok ? mcp.error : null),
      checkedAt,
      mcp,
    };
    lastCheck = result;
    // Wake every open status screen: the probe result is why they are open.
    notifyStatusChange();
    return result;
  });

  server.handle(connectionStatus, async () => statusSnapshot());

  // --- Live status stream (Paseo 0.16.0 `addSubscription`, 0.7.5) ----------------
  // Pushes a full snapshot on subscribe and again on every provisioning decision,
  // connection test and settings change, so the screen shows what happened while
  // it was open without polling and without a manual Test.
  server.handle(statusStream, async (_input, context) => {
    let closed = false;
    const emit = async (event: ProvisioningEvent | null) => {
      await context.push({
        kind: event === null ? "status" : "provisioning",
        at: new Date().toISOString(),
        status: await statusSnapshot(),
        provisioning: event,
        recent: recentProvisioning(),
      });
    };
    await emit(null);
    const unsubscribe = subscribeProvisioning((event) => {
      if (closed) return;
      void emit(event).catch((cause: unknown) => {
        console.warn(
          `[bunny-search] status stream push failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      });
    });
    const stop = () => {
      closed = true;
      unsubscribe();
    };
    if (context.signal.aborted) stop();
    else context.signal.addEventListener("abort", stop, { once: true });
  });

  server.handle(runSearch, async (input) => {
    const runtime = await readRuntimeSettings();
    const startedAt = Date.now();
    try {
      const response = await searchWeb(
        {
          query: input.query,
          maxResults: input.maxResults ?? runtime.maxResults,
        },
        runtime,
      );
      return {
        ok: true,
        error: null,
        latencyMs: Date.now() - startedAt,
        text: formatSearchResponse(response),
      };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
        latencyMs: Date.now() - startedAt,
        text: null,
      };
    }
  });

  // --- Repair: reopen the agent's session so the hooks above run again ----------
  // The supported answer to "this agent lost its search tools": `reload()` reopens
  // the provider session with its current configuration and reruns
  // `agent.open.before`, which re-contributes the server or the attached tool.
  server.handle(agentReload, async (input, { paseo }) => {
    try {
      const result = await paseo.agents.ref(input.agentId).reload();
      if (result === null) {
        return { ok: false, error: `Agent ${input.agentId} not found or not reloadable.` };
      }
      console.log(`[bunny-search] reloaded agent ${input.agentId} (search tools re-registered)`);
      return { ok: true, error: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[bunny-search] agent reload failed: ${message}`);
      return { ok: false, error: message };
    }
  });

  // -------------------------------------------------------------------------

  return () => {
    disposed = true;
    void disposed;
    removeSettingsListener();
    removeCreateHook();
    removeSessionOpenHook();
  };
}
