import { useCallback, useEffect, useState } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  openInObsidian,
  readNote,
  searchVaultRpc,
  vaultStatus,
  type SearchHit,
  type VaultStatus,
} from "../shared/contracts";

/**
 * Compact knowledge-base tab beside agents and terminals.
 *
 * Same index and same search as the sidebar screen, sized for a tab: status,
 * query, hits, a short preview and "Open in Obsidian". The full screen remains
 * the place for the role map and reindexing.
 */
export function KnowledgeWorkspacePanel({ theme, layout }: PluginWorkspacePanelProps) {
  const statusRpc = useRpc(vaultStatus);
  const searchRpc = useRpc(searchVaultRpc);
  const noteRpc = useRpc(readNote);
  const openRpc = useRpc(openInObsidian);

  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const font = (base: number) => (layout.compact ? base : base + 1);

  const refresh = useCallback(() => {
    void statusRpc({})
      .then((value) => setStatus(value))
      .catch(() => undefined);
  }, [statusRpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    setBusy(true);
    setMessage(null);
    try {
      const result = await searchRpc({ query: trimmed.length > 0 ? trimmed : " " });
      setHits(result.hits);
      if (result.hits.length === 0) setMessage(result.note ?? "No results.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [query, searchRpc]);

  const openNote = useCallback(
    async (path: string) => {
      try {
        const note = await noteRpc({ path });
        setPreview({ path: note.path, text: note.content.slice(0, 6000) });
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [noteRpc],
  );

  const openInApp = useCallback(
    async (path: string) => {
      try {
        const result = await openRpc({ path });
        if (!result.ok) setMessage(result.error ?? "Obsidian did not open the note.");
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [openRpc],
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 10 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: font(16), fontWeight: "600" }}>
        Obsidian knowledge base
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: font(11) }} numberOfLines={2}>
        {status?.configured
          ? `${status.indexedNotes} notes · ${status.indexedChunks} chunks · ${status.indexedLinks} links`
          : "No directory configured yet — open the Obsidian Bridge settings."}
      </Text>
      {status?.enrichment.enabled ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: font(10) }} numberOfLines={2}>
          Obsidian: {status.enrichment.reachable ? "connected" : "unreachable"}
          {status.enrichment.events ? " · live events" : ""}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => void runSearch()}
          placeholder="Search the vault…"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            color: theme.colors.foreground,
            fontSize: font(12),
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search the Obsidian vault"
          onPress={() => void runSearch()}
          disabled={busy}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 8,
            backgroundColor: theme.colors.accent,
            opacity: busy ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: font(11) }}>Search</Text>
        </Pressable>
      </View>

      {message ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: font(11) }} numberOfLines={4}>
          {message}
        </Text>
      ) : null}

      {hits.map((hit, index) => (
        <Pressable
          key={`${hit.path}:${hit.heading}:${index}`}
          accessibilityRole="button"
          onPress={() => void openNote(hit.path)}
          style={{
            borderTopWidth: 1,
            borderColor: theme.colors.border,
            paddingTop: 8,
            gap: 2,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: font(12) }} numberOfLines={2}>
            {hit.title}
          </Text>
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: font(10) }}
            numberOfLines={1}
          >
            {hit.role} · {hit.heading.length > 0 ? `${hit.path} § ${hit.heading}` : hit.path}
          </Text>
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: font(11) }}
            numberOfLines={2}
          >
            {hit.snippet}
          </Text>
        </Pressable>
      ))}

      {preview ? (
        <View style={{ gap: 6, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: font(12), fontWeight: "600" }}>
            {preview.path}
          </Text>
          <Text
            selectable
            style={{ color: theme.colors.foreground, fontSize: font(11) }}
          >
            {preview.text}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open this note in Obsidian"
              onPress={() => void openInApp(preview.path)}
              disabled={!status?.enrichment.enabled}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.accent,
                opacity: status?.enrichment.enabled ? 1 : 0.5,
              }}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: font(11) }}>
                Open in Obsidian
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPreview(null)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: font(11) }}>Close</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
