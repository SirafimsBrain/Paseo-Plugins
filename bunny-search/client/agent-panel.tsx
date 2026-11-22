import { useCallback, useState } from "react";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useComposers, useRpc } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  SEARCH_SERVICE_LABELS,
  connectionStatus,
  runSearch,
  type SearchService,
} from "../shared/contracts";

/**
 * Agent panel: web search for one agent (0.8.7).
 *
 * Scope is deliberately per agent: the panel is opened for `params.agentId`, and what it
 * searches is meant to land in *that* agent's composer. The plugin cannot attribute a
 * tool call to an agent (the MCP server is spawned by the provider, outside the plugin
 * host, and reports no agent id), so a shared history would be fiction; the panel keeps
 * the last searches of this panel instance instead, and hands the formatted result to
 * the agent's own composer with `useComposers({ agentId })`.
 *
 * The global screen stays the place for configuration; this panel is the place for
 * "search, then paste into the prompt I am writing for this agent".
 */

/** Markdown-ish block inserted into the composer, so the agent sees sources. */
function asPromptBlock(text: string): string {
  return `\nWeb search results:\n\n${text}\n`;
}

export function BunnySearchAgentPanel(props: PluginAgentPanelProps) {
  const { theme, params } = props;
  const agentId = params.agentId;
  const composers = useComposers({ agentId });
  const searchRpc = useRpc(runSearch);
  const statusRpc = useRpc(connectionStatus);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inserted, setInserted] = useState(false);
  const [provider, setProvider] = useState<SearchService | null>(null);

  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const success = theme.colors.statusSuccess;

  const run = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    setText(null);
    setInserted(false);
    const [result, status] = await Promise.all([
      searchRpc({ query: trimmed }).catch(() => null),
      statusRpc({}).catch(() => null),
    ]);
    setBusy(false);
    if (status) setProvider(status.provider as SearchService);
    if (result?.ok && result.text) {
      setText(result.text);
    } else {
      setError(result?.error ?? "Search failed (see plugin logs).");
    }
  }, [query, searchRpc, statusRpc]);

  const insert = useCallback(() => {
    if (!text) return;
    const composer = composers[0];
    if (!composer) {
      setError("This agent has no open composer to insert into.");
      return;
    }
    composer.insertText(asPromptBlock(text));
    setInserted(true);
  }, [composers, text]);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.input, { color: fg, borderColor: fgMuted }]}
          value={query}
          onChangeText={setQuery}
          placeholder="Search the web…"
          placeholderTextColor={fgMuted}
          onSubmitEditing={() => void run()}
          returnKeyType="search"
        />
        <Pressable
          onPress={() => void run()}
          style={[styles.button, { backgroundColor: accent, opacity: busy ? 0.6 : 1 }]}
          disabled={busy || query.trim().length === 0}
        >
          <Text style={styles.buttonText}>{busy ? "…" : "Search"}</Text>
        </Pressable>
      </View>

      {provider ? (
        <Text style={{ color: fgMuted, fontSize: 10 }}>
          via {SEARCH_SERVICE_LABELS[provider]}
        </Text>
      ) : null}

      {error ? (
        <Text style={{ color: danger, fontSize: 11 }} numberOfLines={6}>
          {error}
        </Text>
      ) : null}

      {text ? (
        <>
          <View style={styles.actions}>
            <Pressable
              onPress={insert}
              style={[styles.button, { backgroundColor: accent, flex: 1 }]}
            >
              <Text style={styles.buttonText}>Insert into the prompt</Text>
            </Pressable>
          </View>
          {inserted ? (
            <Text style={{ color: success, fontSize: 11 }}>Inserted into the composer.</Text>
          ) : null}
          <Text style={{ color: fg, fontSize: 11, lineHeight: 16 }}>{text}</Text>
        </>
      ) : null}

      {!text && !error ? (
        <Text style={{ color: fgMuted, fontSize: 11 }}>
          Results stay in this panel until you insert them; nothing is sent to the agent
          automatically.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  searchRow: { flexDirection: "row", gap: 6 },
  actions: { flexDirection: "row", gap: 6 },
  input: { flex: 1, borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  button: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, alignItems: "center" },
  buttonText: { color: "#ffffff", fontSize: 12 },
});
