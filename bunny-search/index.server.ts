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
  type ConnectionTestResult,
  type RuntimeSettings,
} from "./shared/contracts";
import { checkSearchService, formatSearchResponse, providerBaseUrl, searchWeb } from "./server/providers";
import { INJECTED_SERVER_NAME, mcpServerCommand } from "./server/mcp-launch";
import { createWebSearchTool } from "./server/agent-tools";
import { readSavedMcpServers } from "./server/agent-record";
import { decideSessionOpen, needsCapabilityProbe, providerExcluded } from "./server/session-open";
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
 *    through Paseo via the `agent.create` before-hook, and re-contributes
 *    it (or the attached `bunny_web_search` tool) on every
 *    `agent.session_open` — the path that also reaches agents created
 *    before injection was turned on.
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
      void mirrorSettings();
    }
  });

  // -------------------------------------------------------------------------
  // MCP injection (the plugin's reason to exist: agents get web search)
  // -------------------------------------------------------------------------

  const removeCreateHook = server.before("agent.create", async ({ request }) => {
    // Async hooks are awaited by the host before the request proceeds,
    // so the mutation below is guaranteed to be applied to agent creation.
    const state = await settings.read().catch(() => null);
    if (state?.status !== "ready" || !state.values.injectIntoAgents) return request;
    // `PluginBeforeRequests["agent.create"]` carries only `config` and `env` — no
    // labels — so a configured label gate cannot be evaluated here. Defer the whole
    // creation-time injection to `agent.session_open`, which reads `request.labels`
    // (see server/session-open.ts: `createHookOwnsCreation`).
    if (state.values.labelGateKey.trim().length > 0) {
      console.log(
        `[bunny-search] label gate '${state.values.labelGateKey.trim()}' set: ` +
          "session_open owns the creation-time contribution",
      );
      return request;
    }
    if (providerExcluded(request.config.provider, state.values.skipProviders)) {
      console.log(
        `[bunny-search] create skipped: provider '${request.config.provider}' excluded by skipProviders`,
      );
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
      [INJECTED_SERVER_NAME]: config,
    };
    // Diagnostic: visible in `paseo plugin logs bunny-search` — helps to
    // troubleshoot MCP spawn failures on the agent side.
    console.log(`[bunny-search] MCP injected: ${command} ${args.join(" ")}`);
    return request;
  });

  // -------------------------------------------------------------------------
  // Session-open contribution (Paseo 0.14, 0.5.2)
  //
  // `agent.create` writes the agent's *saved* configuration once, at creation. This
  // hook runs on every open — create, resume after the daemon restart or the 0.14.0
  // idle-hour runtime release, refresh, import — and is the only place that can reach
  // an agent created before bunny-search was installed or before `injectIntoAgents`
  // was switched on (today such an agent keeps searching without a server until it is
  // recreated).
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

  const removeSessionOpenHook = server.before(
    "agent.session_open",
    async ({ request }, { paseo }) => {
      const state = await settings.read().catch(() => null);
      const values = state?.status === "ready" ? state.values : null;
      const base = {
        reason: request.reason,
        purpose: request.purpose,
        provider: request.provider,
        labels: request.labels,
        injectIntoAgents: values?.injectIntoAgents ?? false,
        serverName: INJECTED_SERVER_NAME,
        labelGateKey: values?.labelGateKey ?? "",
        skipProviders: values?.skipProviders ?? "",
        lookup: readSavedMcpServers(request.agentId),
      };

      // The daemon is only consulted when an MCP contribution is still possible;
      // every other branch (gated off, history, create owned by the create hook,
      // server already saved) is decided without touching it.
      let supportsMcpServers: boolean | null = null;
      if (needsCapabilityProbe({ ...base, supportsMcpServers: null })) {
        const snapshot = await paseo.agents
          .ref(request.agentId)
          .refresh()
          .catch(() => null);
        supportsMcpServers = snapshot?.agent.capabilities.supportsMcpServers ?? null;
      }

      const decision = decideSessionOpen({ ...base, supportsMcpServers });
      console.log(
        `[bunny-search] session_open ${request.agentId} (${request.reason}/${request.purpose}): ${decision.why}`,
      );

      if (!decision.injectMcp && !decision.attachTool) return request;

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

      return { ...request, tools, mcpServers };
    },
  );

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

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
    return result;
  });

  server.handle(connectionStatus, async () => {
    const runtime = await readRuntimeSettings();
    const full = await readFullSettings();
    const baseUrl = providerBaseUrl(runtime);
    const uiUrl = full ? searchInterfaceUrl(full) : null;
    return { provider: runtime.searchService, baseUrl, uiUrl, lastCheck };
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
  // `agent.session_open`, which re-contributes the server or the attached tool.
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
