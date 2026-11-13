import { useCallback, useEffect, useState } from "react";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  openInObsidian,
  readNote,
  reindexVault,
  searchVaultRpc,
  vaultStatus,
  type NotePreview,
  type SearchHit,
  type VaultStatus,
} from "../shared/contracts";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Knowledge-base screen.
 *
 * Read-only by design: it searches the same index the agents use, previews a
 * note, shows freshness, and can rebuild the index. Configuration lives in the
 * plugin's settings screen, where every setting belongs.
 */
export function KnowledgeSurface({ theme }: PluginScreenProps) {
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const mono = monoFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const monoFontStyle = mono ? { fontFamily: mono } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const border = theme.colors.border;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const surface = theme.colors.surface1;

  const statusRpc = useRpc(vaultStatus);
  const searchRpc = useRpc(searchVaultRpc);
  const noteRpc = useRpc(readNote);
  const reindexRpc = useRpc(reindexVault);
  const openRpc = useRpc(openInObsidian);

  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [noteText, setNoteText] = useState<string | null>(null);
  const [notePath, setNotePath] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    void statusRpc({})
      .then((value) => setStatus(value))
      .catch(() => undefined);
  }, [statusRpc]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    setBusy(true);
    setMessage(null);
    try {
      const result = await searchRpc({ query: trimmed.length > 0 ? trimmed : " " });
      setHits(result.hits);
      setMessage(result.hits.length === 0 ? (result.note ?? "No results.") : null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [query, searchRpc]);

  const openNote = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        const note: NotePreview = await noteRpc({ path });
        setNotePath(note.path);
        setNoteTitle(`${note.path}${note.truncated ? " (truncated)" : ""}`);
        setNoteText(note.content);
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [noteRpc],
  );

  const openInApp = useCallback(
    async (path: string) => {
      setOpenPath(path);
      try {
        const result = await openRpc({ path });
        if (!result.ok) setMessage(result.error ?? "Obsidian did not open the note.");
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setOpenPath(null);
      }
    },
    [openRpc],
  );

  const reindex = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await reindexRpc({});
      setMessage(
        result.ok
          ? `Indexed ${result.notes} notes (${result.chunks} chunks) in ${result.tookMs} ms.`
          : (result.error ?? "Reindex failed."),
      );
      refreshStatus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [reindexRpc, refreshStatus]);

  const configured = status?.configured ?? false;
  const indexed = (status?.indexedNotes ?? 0) > 0;
  const freshness = status?.lastScanAt
    ? new Date(status.lastScanAt).toLocaleString()
    : "never";

  return (
    <ScrollView style={styles.container}>
      <View style={[styles.card, { backgroundColor: surface, borderColor: border }]}>
        <Text style={{ color: fg, fontSize: font(15), fontWeight: "600", ...uiFontStyle }}>
          Obsidian knowledge base
        </Text>
        <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }} numberOfLines={3}>
          {configured ? status?.vaultPath : "No vault configured yet."}
        </Text>
        <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }} numberOfLines={2}>
          {status
            ? `${status.indexedNotes} notes · ${status.indexedChunks} chunks · ${
                status.indexedLinks
              } links · ${Math.round(status.indexBytes / 1024)} KiB · scanned ${freshness}`
            : "Reading status…"}
        </Text>
        {status?.watching ? (
          <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }}>
            Watching for changes · {status.readOnly ? "writes refused" : "append-only writes"}
          </Text>
        ) : null}
        {status?.error ? (
          <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }} numberOfLines={4}>
            {status.error}
          </Text>
        ) : null}

        {status?.configured ? (
          <View style={{ gap: 2 }}>
            {(
              [
                ["workspace", status.directories.workspace, "."],
                ["inbox", status.directories.inbox, "(not configured)"],
                ["out", status.directories.out, "(not configured)"],
                ["raw", status.directories.raw, "(not configured)"],
              ] as Array<[string, string | null, string]>
            ).map(([role, value, fallback]) => (
              <Text
                key={role}
                style={{ color: fgMuted, fontSize: font(10), ...monoFontStyle }}
                numberOfLines={1}
              >
                {role}: {value === null || value.length === 0 ? fallback : value}
              </Text>
            ))}
          </View>
        ) : null}

        {status ? (
          <View style={{ gap: 2 }}>
            <Text style={{ color: fgMuted, fontSize: font(10), ...monoFontStyle }} numberOfLines={1}>
              semantic:{" "}
              {status.embedding.enabled
                ? `${status.embedding.model} (${status.embedding.dtype}) · ${status.embedding.embedded}/${status.embedding.chunks} vectors · ${status.embedding.state}`
                : "off"}
            </Text>
            {status.embedding.note ? (
              <Text
                style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }}
                numberOfLines={2}
              >
                {status.embedding.note}
              </Text>
            ) : null}
            {status.enrichment.enabled ? (
              <Text style={{ color: fgMuted, fontSize: font(10), ...monoFontStyle }} numberOfLines={2}>
                obsidian: {status.enrichment.reachable ? "connected" : "unreachable"}
                {status.enrichment.version ? ` · ${status.enrichment.version}` : ""}
                {status.enrichment.events ? " · live events" : ""}
                {status.enrichment.error ? ` · ${status.enrichment.error}` : ""}
              </Text>
            ) : null}
            {status.memory.level !== "ok" && status.memory.note ? (
              <Text style={{ color: danger, fontSize: font(10), ...uiFontStyle }} numberOfLines={3}>
                {status.memory.note}
              </Text>
            ) : null}
          </View>
        ) : null}

        {!configured ? (
          <View style={styles.emptyBox}>
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>
              Set the vault path in Settings → Plugins → Obsidian Bridge. Indexing starts after the
              path is saved; nothing is written into the vault.
            </Text>
          </View>
        ) : null}

        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            onPress={() => void reindex()}
            disabled={busy || !configured}
            style={[styles.button, { backgroundColor: accent, opacity: busy || !configured ? 0.5 : 1 }]}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: font(11), ...uiFontStyle }}>
              {busy ? "Working…" : "Reindex"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={refreshStatus}
            style={[styles.button, { backgroundColor: surface, borderColor: border, borderWidth: 1 }]}
          >
            <Text style={{ color: fg, fontSize: font(11), ...uiFontStyle }}>Refresh</Text>
          </Pressable>
        </View>
      </View>

      {configured && indexed ? (
        <View style={[styles.card, { backgroundColor: surface, borderColor: border }]}>
          <View style={styles.row}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => void runSearch()}
              placeholder="Search notes, plans, research…"
              placeholderTextColor={fgMuted}
              style={[
                styles.input,
                { color: fg, borderColor: border, fontSize: font(12), ...uiFontStyle },
              ]}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void runSearch()}
              disabled={busy}
              style={[styles.button, { backgroundColor: accent, opacity: busy ? 0.5 : 1 }]}
            >
              <Text
                style={{ color: theme.colors.accentForeground, fontSize: font(11), ...uiFontStyle }}
              >
                Search
              </Text>
            </Pressable>
          </View>

          {message ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }} numberOfLines={4}>
              {message}
            </Text>
          ) : null}

          {hits.map((hit, index) => (
            <Pressable
              key={`${hit.path}:${hit.heading}:${index}`}
              accessibilityRole="button"
              onPress={() => void openNote(hit.path)}
              style={[styles.hit, { borderColor: border }]}
            >
              <Text style={{ color: fg, fontSize: font(12), ...uiFontStyle }} numberOfLines={2}>
                {hit.title}
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(10), ...monoFontStyle }} numberOfLines={1}>
                {hit.role} · {hit.heading.length > 0 ? `${hit.path} § ${hit.heading}` : hit.path}
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }} numberOfLines={3}>
                {hit.snippet}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {noteText !== null ? (
        <View style={[styles.card, { backgroundColor: surface, borderColor: border }]}>
          <Text style={{ color: fg, fontSize: font(12), fontWeight: "600", ...uiFontStyle }}>
            {noteTitle}
          </Text>
          <Text
            style={{ color: fg, fontSize: font(11), ...monoFontStyle }}
            selectable
          >
            {noteText}
          </Text>
          <View style={styles.row}>
            {notePath ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void openInApp(notePath)}
                disabled={openPath !== null || !status?.enrichment.enabled}
                style={[
                  styles.button,
                  {
                    backgroundColor: accent,
                    opacity: openPath !== null || !status?.enrichment.enabled ? 0.5 : 1,
                  },
                ]}
              >
                <Text
                  style={{ color: theme.colors.accentForeground, fontSize: font(11), ...uiFontStyle }}
                >
                  {openPath !== null ? "Opening…" : "Open in Obsidian"}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setNoteText(null);
                setNotePath(null);
                setNoteTitle(null);
              }}
              style={[styles.button, { backgroundColor: surface, borderColor: border, borderWidth: 1 }]}
            >
              <Text style={{ color: fg, fontSize: font(11), ...uiFontStyle }}>Close note</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, gap: 10 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  hit: { borderTopWidth: 1, paddingTop: 8, gap: 2 },
  emptyBox: { paddingVertical: 4 },
});
