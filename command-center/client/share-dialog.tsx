import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { copyText } from "@getpaseo/plugin/client/ui";
import type { ImportMode, ImportResult } from "../shared/share";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

interface Props {
  theme: PluginTheme;
  /** Current library, listed in the export tab for a selection. */
  commands: { id: string; name: string }[];
  /** `undefined` exports the whole library. */
  onExport: (ids: string[] | undefined) => Promise<{ json: string; count: number }>;
  onImport: (json: string, mode: ImportMode) => Promise<ImportResult>;
  onImportUrl: (url: string, mode: ImportMode) => Promise<ImportResult>;
  /** Called after any successful import so the library can reload. */
  onImported: () => void;
  onClose: () => void;
}

type Mode = "export" | "import";

function describeResult(result: ImportResult): string {
  if (!result.ok && result.added + result.updated === 0) {
    return result.error ?? "Nothing was imported.";
  }
  const parts = [
    result.added > 0 ? `${result.added} added` : null,
    result.updated > 0 ? `${result.updated} updated` : null,
    result.skipped > 0 ? `${result.skipped} skipped` : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join(", ")}${result.error ? ` — ${result.error}` : ""}`;
}

/**
 * Library sharing (0.8.0): export the whole library (or a selection, encoded by
 * the caller) as a versioned JSON bundle, and import one by pasting it or by
 * pointing at a raw JSON file (e.g. in a git repository). The dialog owns only
 * the presentation; parsing/merging lives in `shared/share.ts` and runs on the
 * server so the same rules apply to every host.
 */
export function ShareDialog({
  theme,
  commands,
  onExport,
  onImport,
  onImportUrl,
  onImported,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>("export");
  const [selectedIds, setSelectedIds] = useState<string[]>(() => commands.map((command) => command.id));
  const [exportJson, setExportJson] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultOk, setResultOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const all = selectedIds.length === commands.length;
    onExport(all ? undefined : selectedIds)
      .then((payload) => {
        if (!cancelled) setExportJson(payload.json);
      })
      .catch((error: unknown) => {
        if (!cancelled) setExportError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [onExport, commands, selectedIds]);

  const { foreground, foregroundMuted } = theme.colors;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const monoFont = monoFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;

  const finish = (outcome: ImportResult) => {
    setResultOk(outcome.ok);
    setResult(describeResult(outcome));
    if (outcome.ok) onImported();
  };

  const runImport = (task: () => Promise<ImportResult>) => {
    setBusy(true);
    setResult(null);
    void task()
      .then(finish)
      .catch((error: unknown) => {
        setResultOk(false);
        setResult(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {(["export", "import"] as const).map((option) => (
          <Pressable
            key={option}
            style={[styles.chip, { borderColor: theme.colors.border }, mode === option && styles.chipActive]}
            onPress={() => setMode(option)}
          >
            <Text
              style={[styles.chipText, { color: foreground, fontSize: font(12) }, mode === option && styles.chipTextActive]}
            >
              {option === "export" ? "Export" : "Import"}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === "export" ? (
        <>
          <Text style={[styles.hint, { color: foregroundMuted, fontSize: font(12) }]}>
            {selectedIds.length} of {commands.length} commands · versioned JSON bundle · usage counters
            are not shared.
          </Text>
          {commands.length > 1 ? (
            <View style={styles.row}>
              {commands.map((command) => {
                const selected = selectedIds.includes(command.id);
                return (
                  <Pressable
                    key={command.id}
                    style={[
                      styles.chip,
                      { borderColor: theme.colors.border },
                      selected && styles.chipActive,
                    ]}
                    onPress={() =>
                      setSelectedIds((previous) =>
                        previous.includes(command.id)
                          ? previous.filter((id) => id !== command.id)
                          : [...previous, command.id],
                      )
                    }
                  >
                    <Text
                      style={[
                        styles.chipText,
                        { color: foreground, fontSize: font(11) },
                        selected && styles.chipTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {selected ? "✓ " : ""}{command.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {exportError ? <Text style={styles.errorText}>{exportError}</Text> : null}
          <TextInput
            editable={false}
            multiline
            selectTextOnFocus
            value={exportJson ?? "Preparing…"}
            style={[
              styles.textArea,
              { color: foreground, borderColor: theme.colors.border, fontSize: font(11) },
              monoFont ? { fontFamily: monoFont } : null,
            ]}
          />
          <View style={styles.row}>
            <Pressable
              style={[styles.button, styles.secondaryButton, !exportJson && styles.disabled]}
              disabled={!exportJson}
              onPress={() => {
                if (!exportJson) return;
                void copyText(exportJson).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Text style={styles.buttonText}>{copied ? "Copied ✓" : "Copy JSON"}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={onClose}>
              <Text style={styles.buttonText}>Close</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={[styles.fieldLabel, { color: foregroundMuted, fontSize: font(12) }]}>
            What to do with a command that already exists
          </Text>
          <View style={styles.row}>
            <Pressable
              style={[styles.chip, { borderColor: theme.colors.border }, importMode === "merge" && styles.chipActive]}
              onPress={() => setImportMode("merge")}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: foreground, fontSize: font(12) },
                  importMode === "merge" && styles.chipTextActive,
                ]}
              >
                Update it (merge)
              </Text>
            </Pressable>
            <Pressable
              style={[styles.chip, { borderColor: theme.colors.border }, importMode === "copy" && styles.chipActive]}
              onPress={() => setImportMode("copy")}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: foreground, fontSize: font(12) },
                  importMode === "copy" && styles.chipTextActive,
                ]}
              >
                Add a copy
              </Text>
            </Pressable>
          </View>
          <Text style={[styles.hint, { color: foregroundMuted, fontSize: font(11) }]}>
            Merge matches by id, then by name; favorites and run counters stay local. Add a copy gives
            every imported command a fresh id and name, so nothing is overwritten.
          </Text>

          <Text style={[styles.fieldLabel, { color: foregroundMuted, fontSize: font(12) }]}>
            Paste a bundle or a commands.json array
          </Text>
          <TextInput
            multiline
            value={pasted}
            onChangeText={setPasted}
            placeholder={'{ "format": "command-center/commands", "version": 1, … }'}
            placeholderTextColor={foregroundMuted}
            style={[
              styles.textArea,
              { color: foreground, borderColor: theme.colors.border, fontSize: font(11) },
              monoFont ? { fontFamily: monoFont } : null,
            ]}
          />

          <Text style={[styles.fieldLabel, { color: foregroundMuted, fontSize: font(12) }]}>
            …or fetch a raw JSON file (git host, gist, static URL)
          </Text>
          <View style={styles.row}>
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder="https://example.com/commands.json"
              placeholderTextColor={foregroundMuted}
              autoCapitalize="none"
              style={[
                styles.urlInput,
                { color: foreground, borderColor: theme.colors.border, fontSize: font(12) },
                uiFontStyle,
              ]}
            />
            <Pressable
              style={[styles.button, styles.inlineButton, (busy || url.trim().length === 0) && styles.disabled]}
              disabled={busy || url.trim().length === 0}
              onPress={() => runImport(() => onImportUrl(url.trim(), importMode))}
            >
              <Text style={styles.buttonText}>{busy ? "Working…" : "Fetch"}</Text>
            </Pressable>
          </View>

          {result ? (
            <Text style={[resultOk ? styles.successText : styles.errorText, { fontSize: font(12) }]}>{result}</Text>
          ) : null}

          <View style={styles.row}>
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={onClose} disabled={busy}>
              <Text style={styles.buttonText}>Close</Text>
            </Pressable>
            <Pressable
              style={[styles.button, (busy || pasted.trim().length === 0) && styles.disabled]}
              disabled={busy || pasted.trim().length === 0}
              onPress={() => runImport(() => onImport(pasted, importMode))}
            >
              <Text style={styles.buttonText}>{busy ? "Working…" : "Import pasted JSON"}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  fieldLabel: { fontSize: 12, opacity: 0.7, marginTop: 6 },
  hint: { fontSize: 11, opacity: 0.7 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
  },
  chipActive: { backgroundColor: "rgba(90,140,255,0.25)", borderColor: "rgba(90,140,255,0.8)" },
  chipText: { fontSize: 12 },
  chipTextActive: { fontWeight: "700" },
  textArea: {
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 11,
    minHeight: 140,
    textAlignVertical: "top",
  },
  urlInput: {
    flex: 1,
    minWidth: 200,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
  },
  button: {
    flexGrow: 1,
    backgroundColor: "rgba(90,140,255,0.9)",
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  inlineButton: { flexGrow: 0 },
  secondaryButton: { backgroundColor: "rgba(128,128,128,0.3)" },
  disabled: { opacity: 0.5 },
  buttonText: { color: "white", fontWeight: "600" },
  successText: { color: "rgb(80,180,120)" },
  errorText: { color: "rgb(220,80,80)", fontSize: 12 },
});
