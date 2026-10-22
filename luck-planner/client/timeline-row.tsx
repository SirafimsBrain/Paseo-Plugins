import { useMemo } from "react";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { StyleSheet, Text, View } from "react-native";
import { timelineRowText, type TimelineData } from "../shared/timeline";
import { scaledFont } from "./host-font-scale";
import { useHostFontScale } from "./use-host-typography";

/**
 * Renderer for the plugin's own timeline rows (PLAN.md stage H2): the daemon
 * appends `{ kind, version, data }` and `index.client.tsx` registers this
 * component under the same `kind`/`version` and schema — a mismatch on either
 * side is what the host renders as "Plugin timeline item unavailable".
 *
 * Cross-platform rules apply verbatim: React Native primitives, colors from
 * `theme.colors`, padding from `layout.compact`, no DOM. The row must stay
 * readable without color (the event name is spelled out), and long names are
 * ellipsized rather than wrapped — a timeline is a log, not a detail view.
 * The wording itself lives in `shared/timeline.ts` (see `timelineRowText`),
 * so the tests can read a row without loading React Native.
 */

export function LuckPlannerTimelineRow(
  props: PluginTimelineItemProps<TimelineData>,
) {
  const { theme, layout, item } = props;
  const fontScale = useHostFontScale();
  const font = (base: number) => scaledFont(base, fontScale);
  const text = timelineRowText(item.data);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: "row",
          gap: layout.compact ? 6 : 8,
          alignItems: "flex-start",
          paddingVertical: layout.compact ? 4 : 6,
        },
        glyph: {
          fontSize: font(14),
          lineHeight: font(18),
        },
        body: {
          flex: 1,
          gap: 2,
        },
        name: {
          color: theme.colors.foreground,
          fontSize: font(14),
          fontWeight: "600",
        },
        label: {
          color: theme.colors.foregroundMuted,
          fontSize: font(14),
        },
        meta: {
          color: theme.colors.foregroundMuted,
          fontSize: font(12),
        },
      }),
    [theme, layout.compact, fontScale],
  );

  return (
    <View
      style={styles.row}
      accessibilityLabel={`${text.label}: ${text.name}. ${text.meta}`}
    >
      <Text style={styles.glyph}>{text.glyph}</Text>
      <View style={styles.body}>
        <Text numberOfLines={1}>
          <Text style={styles.label}>{text.label}: </Text>
          <Text style={styles.name}>{text.name}</Text>
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {text.meta}
        </Text>
      </View>
    </View>
  );
}
