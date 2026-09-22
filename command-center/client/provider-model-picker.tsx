import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ProviderWithModels } from "../shared/commands";

interface Props {
  providers: ProviderWithModels[];
  /** Full `provider/model` reference, or "" when nothing is picked yet. */
  value: string;
  loading: boolean;
  multiHost: boolean;
  theme: PluginTheme;
  onChange: (value: string) => void;
}

/**
 * Dropdown for picking a full `provider/model` reference. Only enabled
 * providers with at least one reported model are offered — anything else
 * would be rejected by the daemon with "Expected config.provider in
 * 'provider/model' format".
 */
export function ProviderModelPicker({ providers, value, loading, multiHost, theme, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const { foreground, foregroundMuted } = theme.colors;

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return providers
      .filter((provider) => provider.models.length > 0)
      .map((provider) => ({
        provider,
        models: provider.models.filter(
          (model) =>
            needle.length === 0 ||
            model.id.toLowerCase().includes(needle) ||
            model.label.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [providers, filter]);

  return (
    <View>
      <Pressable
        style={[styles.selector, { borderColor: theme.colors.border }]}
        onPress={() => setOpen((previous) => !previous)}
      >
        <Text style={[styles.selectorText, { color: value ? foreground : foregroundMuted }]} numberOfLines={1}>
          {value || (loading ? "Loading models…" : "Select provider/model…")}
        </Text>
        <Text style={[styles.chevron, { color: foregroundMuted }]}>{open ? "▴" : "▾"}</Text>
      </Pressable>

      {open ? (
        <View style={[styles.dropdown, { borderColor: theme.colors.border }]}>
          <TextInput
            style={[styles.filter, { color: foreground, borderColor: theme.colors.border }]}
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter models…"
            placeholderTextColor={foregroundMuted}
          />
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {groups.length === 0 ? (
              <Text style={[styles.empty, { color: foregroundMuted }]}>
                {loading ? "Loading models…" : "No models match — disabled providers are hidden."}
              </Text>
            ) : null}
            {groups.map((group) => (
              <View key={`${group.provider.serverId}:${group.provider.id}`}>
                <Text style={[styles.groupLabel, { color: foregroundMuted }]}>
                  {group.provider.id}
                  {multiHost && group.provider.hostLabel ? ` — ${group.provider.hostLabel}` : ""}
                </Text>
                {group.models.map((model) => {
                  const active = value === model.id;
                  return (
                    <Pressable
                      key={model.id}
                      style={[styles.row, active && styles.rowActive]}
                      onPress={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                    >
                      <Text style={[styles.rowText, { color: foreground }]} numberOfLines={1}>
                        {active ? "✓ " : ""}{model.label}
                        {model.isDefault ? " ★" : ""}
                      </Text>
                      {model.label !== model.id ? (
                        <Text style={[styles.rowSub, { color: foregroundMuted }]} numberOfLines={1}>
                          {model.id}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  selector: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  selectorText: { flex: 1, fontSize: 13 },
  chevron: { fontSize: 12, marginLeft: 8 },
  dropdown: {
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    maxHeight: 260,
  },
  filter: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    marginBottom: 6,
  },
  list: { maxHeight: 190 },
  empty: { fontSize: 12, paddingVertical: 6 },
  groupLabel: { fontSize: 11, marginTop: 6, marginBottom: 2 },
  row: { paddingVertical: 6, paddingHorizontal: 4, borderRadius: 6 },
  rowActive: { backgroundColor: "rgba(90,140,255,0.25)" },
  rowText: { fontSize: 13 },
  rowSub: { fontSize: 11, opacity: 0.7 },
});
