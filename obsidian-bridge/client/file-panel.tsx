import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useFileText } from "@getpaseo/plugin/client";
import { Loading, Markdown } from "@getpaseo/plugin/client/ui";
import { ScrollView, Text, View } from "react-native";

/**
 * Markdown preview for notes opened as a Paseo file tab (0.22.18).
 *
 * Paseo hands the panel a `PluginFile` handle, so the view is read-only and
 * always reflects what is on disk; editing stays in Obsidian or with
 * `obsidian_edit`. The panel is deliberately vault-agnostic: it renders any
 * Markdown file Paseo opens with it, and shows the file's path and, when Paseo
 * supplied them, the requested line range.
 */
export function ObsidianFilePanel({ file, params, theme, layout }: PluginFilePanelProps) {
  const text = useFileText(file);
  const font = layout.compact ? 12 : 13;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 8 }}
    >
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: font + 2, fontWeight: "600" }}>
          {file.name}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: font - 1 }} numberOfLines={2}>
          {params.path}
          {params.lineStart
            ? ` · lines ${params.lineStart}${params.lineEnd ? `–${params.lineEnd}` : ""}`
            : ""}
        </Text>
      </View>

      {text.status === "loading" ? <Loading /> : null}
      {text.status === "error" ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: font }}>
          {text.error.message}
        </Text>
      ) : null}
      {text.status === "ready" ? <Markdown>{text.text}</Markdown> : null}
    </ScrollView>
  );
}
