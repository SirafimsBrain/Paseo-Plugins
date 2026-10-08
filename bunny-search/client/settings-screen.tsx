import { useCallback, useEffect, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings, useRpc, usePaseo } from "@getpaseo/plugin/client";
import { openSearchInterfaceUrl } from "./open-search-ui";
import { bunnySearchSettings } from "../shared/settings";
import {
  SEARCH_SERVICE_LABELS,
  DUCKDUCKJS_ENGINE_LABELS,
  connectionStatus,
  connectionTest,
  type ConnectionStatus,
  type ConnectionTestResult,
  type DuckduckjsEngine,
} from "../shared/contracts";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";
import type { SearchService } from "../shared/contracts";

/**
 * Plugin settings screen (Paseo Settings → Plugins → Bunny Search).
 *
 * Sections:
 * - Connection: live status indicator of the configured search
 *   service + the "Test connection" button (real HTTP probe of
 *   the service + live MCP handshake check of the bundled server).
 * - Search provider: which service to use (SearXNG by default),
 *   its URL, API key and default search options.
 * - Integration: MCP injection into Paseo-created agents.
 */

type ConnectionState = "unknown" | "checking" | "ok" | "error";

function stateOf(status: ConnectionStatus | null, testing: boolean): ConnectionState {
  if (testing) return "checking";
  if (!status?.lastCheck) return "unknown";
  return status.lastCheck.ok ? "ok" : "error";
}

function stateColor(state: ConnectionState, colors: { accent: string; success: string; danger: string; muted: string }): string {
  switch (state) {
    case "ok":
      return colors.success;
    case "error":
      return colors.danger;
    case "checking":
      return colors.accent;
    default:
      return colors.muted;
  }
}

function stateLabel(state: ConnectionState): string {
  switch (state) {
    case "ok":
      return "Connected — search service is working";
    case "error":
      return "Connection failed";
    case "checking":
      return "Testing connection…";
    default:
      return "Not checked yet";
  }
}

export function BunnySearchSettingsScreen(props: PluginSurfaceProps) {
  const { theme } = props;
  const paseo = usePaseo();
  const settings = useSettings(bunnySearchSettings);
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const success = theme.colors.statusSuccess;
  const danger = theme.colors.statusDanger;

  const statusRpc = useRpc(connectionStatus);
  const testRpc = useRpc(connectionTest);

  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const reloadStatus = useCallback(() => {
    void statusRpc({})
      .then((result) => {
        setStatus(result);
        if (result.lastCheck) setTestResult(result.lastCheck);
      })
      .catch(() => undefined);
  }, [statusRpc]);

  useEffect(() => {
    reloadStatus();
  }, [reloadStatus]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testRpc({}).catch(() => null);
    setTesting(false);
    if (result) {
      setTestResult(result);
      setStatus((previous) =>
        previous ? { ...previous, lastCheck: result } : previous,
      );
    }
  }, [testRpc]);

  const openInterface = useCallback(async () => {
    const url = status?.uiUrl;
    if (!url) return;
    setOpening(true);
    try {
      await openSearchInterfaceUrl(url, props, paseo);
    } finally {
      setOpening(false);
    }
  }, [status?.uiUrl, props, paseo]);

  if (settings.status === "loading") {
    return (
      <View style={styles.container}>
        <Text style={{ color: fg, fontSize: font(13), ...uiFontStyle }}>Loading settings…</Text>
      </View>
    );
  }
  if (settings.status !== "ready") {
    return (
      <View style={styles.container}>
        <Text style={{ color: danger, fontSize: font(12) }}>Settings are invalid: {settings.error}</Text>
        <Pressable onPress={() => void settings.reset()}>
          <Text style={{ color: accent, fontSize: font(12), textDecorationLine: "underline" }}>Reset to defaults</Text>
        </Pressable>
      </View>
    );
  }

  const values = settings.values;
  const patch = (partial: Partial<typeof values>) => {
    void settings.save({ ...values, ...partial }, settings.revision);
  };

  const connectionState = stateOf(status, testing);
  const color = stateColor(connectionState, { accent, success, danger, muted: fgMuted });
  const serviceOptions = (Object.keys(SEARCH_SERVICE_LABELS) as SearchService[]).map((id) => ({
    label: SEARCH_SERVICE_LABELS[id],
    value: id,
  }));
  const engineOptions = (Object.keys(DUCKDUCKJS_ENGINE_LABELS) as DuckduckjsEngine[]).map((id) => ({
    label: DUCKDUCKJS_ENGINE_LABELS[id],
    value: id,
  }));

  return (
    <ScrollView style={styles.container}>
      {settings.saveError ? (
        <Text style={{ color: danger, fontSize: font(12), ...uiFontStyle }}>{settings.saveError}</Text>
      ) : null}

      <SettingsCard>
        <SettingsSection
          title="Connection"
          info="Checks that the configured search service is reachable and that the MCP server agents spawn is healthy."
        >
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <View style={styles.statusInfo}>
              <Text style={{ color, fontSize: font(12), fontWeight: "600", ...uiFontStyle }}>
                {stateLabel(connectionState)}
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }} numberOfLines={2}>
                {SEARCH_SERVICE_LABELS[values.searchService]}
                {status?.baseUrl ? ` · ${status.baseUrl}` : ""}
                {testResult?.latencyMs != null ? ` · ${testResult.latencyMs} ms` : ""}
                {testResult ? ` · checked ${new Date(testResult.checkedAt).toLocaleTimeString()}` : ""}
              </Text>
            </View>
          </View>
          <SettingsAction
            label="Test connection"
            actionLabel={testing ? "Testing…" : "Test connection now"}
            onPress={() => void runTest()}
            disabled={testing}
          />
          <SettingsAction
            label="Open search interface"
            hint={
              status?.uiUrl
                ? `Opens ${status.uiUrl} in a browser tab.`
                : "Set a search URL to enable."
            }
            actionLabel={opening ? "Opening…" : "Open in browser"}
            onPress={() => void openInterface()}
            disabled={opening || !status?.uiUrl}
          />
          {testResult && !testResult.ok ? (
            <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }} numberOfLines={4}>
              {testResult.error ?? "Connection test failed."}
            </Text>
          ) : null}
          {testResult?.mcp && !testResult.mcp.ok ? (
            <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }} numberOfLines={4}>
              MCP server check failed: {testResult.mcp.error}
            </Text>
          ) : null}
          {testResult?.ok ? (
            <Text style={{ color: success, fontSize: font(11), ...uiFontStyle }}>
              Search service responded{testResult.mcp?.ok ? " and the MCP server answered the handshake" : ""}.
            </Text>
          ) : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Search provider"
          info="Which service the web_search tool uses. DuckDuckJS (multi-engine: DuckDuckGo, Brave, Google, Mojeek, Yahoo; no API key) is the default."
        >
          <SettingsSelect
            label="Search service"
            hint="DuckDuckJS is the default and needs no API key. SearXNG stays available for self-hosted setups."
            value={values.searchService}
            options={serviceOptions}
            onValueChange={(service: SearchService) => patch({ searchService: service })}
          />
          {values.searchService === "duckduckjs" ? (
            <>
              <SettingsSelect
                label="DuckDuckJS engine"
                hint="Auto tries DuckDuckGo, Brave, Google, Mojeek and Yahoo in order until one returns results."
                value={values.duckduckjsEngine}
                options={engineOptions}
                onValueChange={(engine: DuckduckjsEngine) => patch({ duckduckjsEngine: engine })}
              />
              <SettingsInput
                label="Proxy URL"
                hint="Optional http(s) proxy for DuckDuckJS requests, e.g. http://127.0.0.1:8080. Empty = direct connection."
                initialValue={values.proxyUrl}
                placeholder="(direct)"
                onChangeText={(text: string) => patch({ proxyUrl: text })}
              />
            </>
          ) : null}
          {values.searchService === "searxng" ? (
            <SettingsInput
              label="SearXNG URL"
              hint="Base URL of your SearXNG instance (its /search endpoint)."
              initialValue={values.searxngBaseUrl}
              placeholder="http://127.0.0.1:8888/search"
              onChangeText={(text: string) => patch({ searxngBaseUrl: text })}
            />
          ) : null}
          {values.searchService === "custom-json" ? (
            <SettingsInput
              label="Endpoint URL"
              hint="JSON search endpoint. Use {query} as the query placeholder, or the query is sent as ?q=."
              initialValue={values.customBaseUrl}
              placeholder="https://example.com/search?q={query}"
              onChangeText={(text: string) => patch({ customBaseUrl: text })}
            />
          ) : null}
          {(values.searchService === "brave" || values.searchService === "custom-json") && (
            <SettingsInput
              label="API key"
              hint={
                values.searchService === "brave"
                  ? "Brave Search subscription token (sent as X-Subscription-Token)."
                  : "Optional. Sent as a Bearer token when set."
              }
              initialValue={values.apiKey}
              placeholder="(none)"
              secureTextEntry
              onChangeText={(text: string) => patch({ apiKey: text })}
            />
          )}
          <SettingsInput
            label="Timeout (ms)"
            hint="Per-request timeout, 1000–60000."
            initialValue={String(values.timeoutMs)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ timeoutMs: parsed });
              }
            }}
          />
          <SettingsInput
            label="Default max results"
            hint="Results per search, 1–30."
            initialValue={String(values.maxResults)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ maxResults: parsed });
              }
            }}
          />
          <SettingsInput
            label="Default categories"
            hint="SearXNG only, comma-separated (general, web, news, science, …)."
            initialValue={values.categories}
            onChangeText={(text: string) => patch({ categories: text })}
          />
          <SettingsInput
            label="Default language"
            hint="Language code (ru, en, uk, …) or empty for auto-detect."
            initialValue={values.language}
            placeholder="(auto)"
            onChangeText={(text: string) => patch({ language: text })}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection title="Integration">
          <SettingsSwitch
            label="Inject MCP server into new agents"
            hint="Adds the bunny-search MCP server (web_search tool) to every agent created through Paseo."
            value={values.injectIntoAgents}
            onValueChange={(enabled: boolean) => patch({ injectIntoAgents: enabled })}
          />
          <SettingsInput
            label="MCP server name"
            hint="Name reported to agents in the MCP handshake."
            initialValue={values.mcpServerName}
            onChangeText={(text: string) => patch({ mcpServerName: text })}
          />
        </SettingsSection>
      </SettingsCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusInfo: { flex: 1 },
});
