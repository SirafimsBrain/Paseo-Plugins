import { useCallback, useEffect, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, usePaseo } from "@getpaseo/plugin/client";
import { openSearchInterfaceUrl } from "./open-search-ui";
import {
  SEARCH_SERVICE_LABELS,
  connectionStatus,
  connectionTest,
  runSearch,
  type ConnectionStatus,
  type ConnectionTestResult,
  type SearchService,
} from "../shared/contracts";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Bunny Search surface (sidebar item / ⌘K).
 *
 * Gives the user a persistent, glanceable answer to "is my web
 * search MCP connected and working": the current provider, the
 * last connection-test verdict (green/red), and a quick search
 * box that runs a real query through the configured service.
 */

export function BunnySearchSurface(props: PluginSurfaceProps) {
  const { theme } = props;
  const paseo = usePaseo();
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
  const searchRpc = useRpc(runSearch);

  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchText, setSearchText] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const reloadStatus = useCallback(() => {
    void statusRpc({})
      .then((result) => setStatus(result))
      .catch(() => undefined);
  }, [statusRpc]);

  useEffect(() => {
    reloadStatus();
  }, [reloadStatus]);

  const runTest = useCallback(async () => {
    setTesting(true);
    const result = await testRpc({}).catch(() => null);
    setTesting(false);
    if (result) setStatus((previous) => (previous ? { ...previous, lastCheck: result } : previous));
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

  const quickSearch = useCallback(async () => {
    const text = query.trim();
    if (text.length === 0) return;
    setSearching(true);
    setSearchError(null);
    setSearchText(null);
    const result = await searchRpc({ query: text }).catch(() => null);
    setSearching(false);
    if (result?.ok) {
      setSearchText(result.text);
    } else {
      setSearchError(result?.error ?? "Search failed (see plugin logs).");
    }
  }, [query, searchRpc]);

  const lastCheck: ConnectionTestResult | null = status?.lastCheck ?? null;
  const stateColor = lastCheck ? (lastCheck.ok ? success : danger) : fgMuted;
  const stateText = lastCheck
    ? lastCheck.ok
      ? `Working${lastCheck.latencyMs != null ? ` · ${lastCheck.latencyMs} ms` : ""}`
      : `Failed: ${lastCheck.error ?? "unknown error"}`
    : "Not checked yet";

  return (
    <ScrollView style={styles.container}>
      <View style={styles.statusCard}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: stateColor }]} />
          <View style={styles.statusInfo}>
            <Text style={{ color: fg, fontSize: font(13), fontWeight: "600", ...uiFontStyle }}>
              {SEARCH_SERVICE_LABELS[(status?.provider ?? "searxng") as SearchService]}
            </Text>
            <Text style={{ color: stateColor, fontSize: font(11), ...uiFontStyle }} numberOfLines={3}>
              {stateText}
            </Text>
            {status?.baseUrl ? (
              <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }} numberOfLines={1}>
                {status.baseUrl}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={() => void runTest()}
            style={[styles.testButton, { borderColor: accent }]}
            disabled={testing}
          >
            <Text style={{ color: accent, fontSize: font(11), ...uiFontStyle }}>
              {testing ? "Testing…" : "Test"}
            </Text>
          </Pressable>
          {status?.uiUrl ? (
            <Pressable
              onPress={() => void openInterface()}
              style={[styles.testButton, { borderColor: accent }]}
              disabled={opening}
            >
              <Text style={{ color: accent, fontSize: font(11), ...uiFontStyle }}>
                {opening ? "Opening…" : "Open"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.searchCard}>
        <TextInput
          style={[styles.input, { color: fg, borderColor: fgMuted, fontSize: font(13), ...uiFontStyle }]}
          value={query}
          onChangeText={setQuery}
          placeholder="Search the web…"
          placeholderTextColor={fgMuted}
          onSubmitEditing={() => void quickSearch()}
          returnKeyType="search"
        />
        <Pressable
          onPress={() => void quickSearch()}
          style={[styles.searchButton, { backgroundColor: accent }]}
          disabled={searching || query.trim().length === 0}
        >
          <Text style={{ color: "#ffffff", fontSize: font(12), ...uiFontStyle }}>
            {searching ? "Searching…" : "Search"}
          </Text>
        </Pressable>
      </View>

      {searchError ? (
        <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }} numberOfLines={6}>
          {searchError}
        </Text>
      ) : null}
      {searchText ? (
        <Text style={{ color: fg, fontSize: font(11), lineHeight: font(16), ...uiFontStyle }}>
          {searchText}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  statusCard: { borderWidth: 1, borderColor: "rgba(128,128,128,0.25)", borderRadius: 8, padding: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusInfo: { flex: 1, gap: 2 },
  testButton: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  searchCard: { gap: 6 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  searchButton: { borderRadius: 6, paddingVertical: 6, alignItems: "center" },
});
