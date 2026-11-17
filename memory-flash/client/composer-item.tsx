import { useState } from "react";
import type { PluginComposerItemProps } from "@getpaseo/plugin/client";
import { useComposer, useRpc } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { saveMemory, searchMemories } from "../shared/memories";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Memory controls inside the composer (Paseo 0.16.0, 0.13.5).
 *
 * Two small actions, both scoped to what the composer already holds:
 *
 * - **Remember** saves the current draft as a `note` memory, so a decision the
 *   user just typed survives the turn without leaving the composer.
 * - **Cite** searches memory with the draft text and inserts `#id title` for
 *   the best match, which gives an agent a pointer to the stored context
 *   instead of a copy of it.
 *
 * The item never changes the prompt on its own and never writes outside the
 * memory database.
 */

/** Longest title taken from a draft's first line. */
const TITLE_LIMIT = 120;

/** Prompt text a memory title is derived from. */
function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? prompt;
  const title = firstLine.replace(/^#+\s*/, "").trim();
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}

export function MemoryComposerItem({ theme, layout }: PluginComposerItemProps) {
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const composer = useComposer();
  const saveRpc = useRpc(saveMemory);
  const searchRpc = useRpc(searchMemories);

  const [busy, setBusy] = useState<"save" | "cite" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const prompt = composer.prompt.trim();
  const disabled = busy !== null || prompt.length === 0;

  const remember = async () => {
    if (disabled) return;
    setBusy("save");
    setStatus(null);
    try {
      const result = await saveRpc({
        input: {
          kind: "note",
          title: titleFromPrompt(prompt),
          content: prompt,
          tags: [],
          project: null,
          agentId: null,
          changedBy: "composer",
        },
      });
      setStatus(result.ok && result.id ? `Saved #${result.id}` : (result.error ?? "Could not save"));
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Could not save");
    } finally {
      setBusy(null);
    }
  };

  const cite = async () => {
    if (disabled) return;
    setBusy("cite");
    setStatus(null);
    try {
      const { results } = await searchRpc({
        query: prompt,
        kinds: [],
        tags: [],
        tagMode: "any",
        project: null,
        agentId: null,
        limit: 5,
      });
      const best = results[0]?.memory;
      if (!best) {
        setStatus("No memory found");
        return;
      }
      composer.insertText(`#${best.id} ${best.title}`);
      setStatus(`Cited #${best.id}`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Could not search");
    } finally {
      setBusy(null);
    }
  };

  const label = layout.compact ? undefined : true;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel="Save the prompt as a memory"
        disabled={disabled}
        onPress={() => void remember()}
        style={[styles.button, { borderColor: theme.colors.border }, disabled && styles.disabled]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.foreground }, uiFont ? { fontFamily: uiFont } : null]}>
          {busy === "save" ? "…" : label ? "Remember" : "＋"}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Insert a memory citation for this prompt"
        disabled={disabled}
        onPress={() => void cite()}
        style={[styles.button, { borderColor: theme.colors.border }, disabled && styles.disabled]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.foreground }, uiFont ? { fontFamily: uiFont } : null]}>
          {busy === "cite" ? "…" : label ? "Cite" : "#"}
        </Text>
      </Pressable>
      {status ? (
        <Text
          numberOfLines={1}
          style={[styles.status, { color: theme.colors.foregroundMuted, fontSize: font(12) }]}
        >
          {status}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  button: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 20 / 8,
  },
  buttonText: { fontSize: 12 },
  status: { flexShrink: 1 },
  disabled: { opacity: 0.4 },
});
