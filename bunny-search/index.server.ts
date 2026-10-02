import type { PluginServerContext } from "@getpaseo/plugin/server";
import { bunnySearchSettings } from "./shared/settings";
import type { BunnySearchSettings } from "./shared/settings";
import {
  connectionStatus,
  connectionTest,
  runSearch,
  type ConnectionTestResult,
  type RuntimeSettings,
} from "./shared/contracts";
import { checkSearchService, formatSearchResponse, searchWeb } from "./server/providers";
import { mcpServerCommand } from "./server/mcp-launch";
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
 *    through Paseo via the `agent.create` before-hook.
 * 4. Serves the plugin RPC surface for the Paseo UI, including
 *    the connection test (real HTTP probe of the configured
 *    search service + live MCP handshake check).
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
      "bunny-search": config,
    };
    // Diagnostic: visible in `paseo plugin logs bunny-search` — helps to
    // troubleshoot MCP spawn failures on the agent side.
    console.log(`[bunny-search] MCP injected: ${command} ${args.join(" ")}`);
    return request;
  });

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  /**
   * Tests the connection to the configured search service.
   *
   * Two checks are combined, because "search works" means both
   * halves are healthy:
   * 1. A real probe request against the configured provider
   *    (SearXNG by default) with the configured timeout.
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
    const baseUrl =
      runtime.searchService === "searxng"
        ? runtime.searxngBaseUrl
        : runtime.searchService === "custom-json"
          ? runtime.customBaseUrl || null
          : runtime.searchService === "duckduckgo"
            ? "https://html.duckduckgo.com/html/"
            : "https://api.search.brave.com/res/v1/web/search";
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

  // -------------------------------------------------------------------------

  return () => {
    disposed = true;
    void disposed;
    removeSettingsListener();
    removeCreateHook();
  };
}
