import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Provider controls for a draft agent (0.13.0, Paseo 0.16.0
 * `providers.listControls`).
 *
 * The daemon publishes the controls a provider declares (a thinking-level
 * select, boolean flags, …) together with the options the draft would run with.
 * The run dialog and the command editor render them through this component, so a
 * saved command can pin "thinking: high" as part of its own shape instead of
 * relying on whatever the provider defaults to on the day it runs.
 *
 * Only `select` and `toggle` exist in the protocol; an unknown control type is
 * skipped rather than guessed at, and a provider error is shown as a single line
 * while the rest of the dialog keeps working.
 */

export type ProviderOptionValues = Record<string, string | number | boolean | null>;

interface SelectControl {
  type: "select";
  key: string;
  label: string;
  description?: string;
  defaultValue?: string;
  choices: { value: string; label: string; description?: string }[];
}

interface ToggleControl {
  type: "toggle";
  key: string;
  label: string;
  description?: string;
  defaultValue?: boolean;
}

type Control = SelectControl | ToggleControl;

interface Props {
  theme: PluginTheme;
  /** `provider/model`, or null when nothing is picked yet. */
  provider: string | null;
  /** Current values (command-pinned or run-time picks). */
  values: ProviderOptionValues;
  onChange: (next: ProviderOptionValues) => void;
  /** Label above the group; omit to render the controls bare. */
  title?: string;
  /** Workspace directory the draft would run in; providers may read it. */
  cwd?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows the daemon payload to the two control kinds this plugin renders. */
function normalizeControls(raw: unknown): Control[] {
  if (!Array.isArray(raw)) return [];
  const controls: Control[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = typeof entry["key"] === "string" ? entry["key"] : "";
    const label = typeof entry["label"] === "string" ? entry["label"] : key;
    const description = typeof entry["description"] === "string" ? entry["description"] : undefined;
    if (key.length === 0) continue;
    if (entry["type"] === "select" && Array.isArray(entry["choices"])) {
      const choices = entry["choices"]
        .filter(isRecord)
        .map((choice) => ({
          value: typeof choice["value"] === "string" ? choice["value"] : "",
          label: typeof choice["label"] === "string" ? choice["label"] : String(choice["value"]),
          description:
            typeof choice["description"] === "string" ? choice["description"] : undefined,
        }))
        .filter((choice) => choice.value.length > 0);
      if (choices.length === 0) continue;
      controls.push({
        type: "select",
        key,
        label,
        description,
        defaultValue: typeof entry["defaultValue"] === "string" ? entry["defaultValue"] : undefined,
        choices,
      });
      continue;
    }
    if (entry["type"] === "toggle") {
      controls.push({
        type: "toggle",
        key,
        label,
        description,
        defaultValue: typeof entry["defaultValue"] === "boolean" ? entry["defaultValue"] : undefined,
      });
    }
  }
  return controls;
}

export function ProviderControls({ theme, provider, values, onChange, title, cwd }: Props) {
  const paseo = usePaseo();
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const { foreground, foregroundMuted, accent } = theme.colors;

  const [controls, setControls] = useState<Control[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!provider) {
      setControls([]);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    paseo.providers
      .listControls({ provider, cwd: cwd ?? "" })
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setControls([]);
          setError(result.error);
          return;
        }
        setControls(normalizeControls(result.controls));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setControls([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, provider, cwd]);

  if (!provider) return null;
  if (error) {
    return (
      <Text style={{ color: foregroundMuted, fontSize: font(10), ...uiFontStyle }} numberOfLines={2}>
        Provider controls unavailable: {error}
      </Text>
    );
  }
  if (controls.length === 0) return null;

  return (
    <View style={styles.group}>
      {title ? (
        <Text style={{ color: foregroundMuted, fontSize: font(10), fontWeight: "600", ...uiFontStyle }}>
          {title}
        </Text>
      ) : null}
      {controls.map((control) => {
        if (control.type === "toggle") {
          const current =
            typeof values[control.key] === "boolean"
              ? (values[control.key] as boolean)
              : (control.defaultValue ?? false);
          return (
            <View key={control.key} style={styles.row}>
              <Pressable
                onPress={() => onChange({ ...values, [control.key]: !current })}
                style={[
                  styles.toggle,
                  { borderColor: current ? accent : foregroundMuted },
                  current ? { backgroundColor: accent } : null,
                ]}
              >
                <Text
                  style={{
                    color: current ? "#ffffff" : foreground,
                    fontSize: font(10),
                    ...uiFontStyle,
                  }}
                >
                  {control.label}
                </Text>
              </Pressable>
              {control.description ? (
                <Text
                  style={{ color: foregroundMuted, fontSize: font(9), ...uiFontStyle }}
                  numberOfLines={1}
                >
                  {control.description}
                </Text>
              ) : null}
            </View>
          );
        }
        const current =
          typeof values[control.key] === "string"
            ? (values[control.key] as string)
            : (control.defaultValue ?? control.choices[0]?.value ?? "");
        return (
          <View key={control.key} style={styles.row}>
            <Text style={{ color: foregroundMuted, fontSize: font(10), ...uiFontStyle }}>
              {control.label}
            </Text>
            <View style={styles.chips}>
              {control.choices.map((choice) => {
                const selected = choice.value === current;
                return (
                  <Pressable
                    key={choice.value}
                    onPress={() => onChange({ ...values, [control.key]: choice.value })}
                    style={[
                      styles.chip,
                      { borderColor: selected ? accent : foregroundMuted },
                      selected ? { backgroundColor: accent } : null,
                    ]}
                  >
                    <Text
                      style={{
                        color: selected ? "#ffffff" : foreground,
                        fontSize: font(9),
                        ...uiFontStyle,
                      }}
                    >
                      {choice.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 4 },
  row: { gap: 3 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  toggle: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" },
});
