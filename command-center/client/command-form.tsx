import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { CommandCategory, CommandDefinition, ProviderWithModels } from "../shared/commands";
import { isFullModelRef, resolveModelRef } from "../shared/commands";
import { inputVariablesOf } from "../shared/template";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";
import { ProviderModelPicker } from "./provider-model-picker";

export interface CommandFormResult {
  name: string;
  type: "prompt" | "shell";
  template: string;
  provider: string | null;
  terminalName: string | null;
  scope: "global" | "workspace";
  /** Chosen from the stored list, or a brand-new label typed in. Empty = none. */
  category: string | null;
}

interface Props {
  initial?: CommandDefinition | null;
  /** Enabled providers with models, for the `provider/model` picker. */
  providers: ProviderWithModels[];
  modelsLoading: boolean;
  multiHost: boolean;
  /** Stored category labels; the picker also offers creating a new one. */
  categories: CommandCategory[];
  theme: PluginTheme;
  onCancel: () => void;
  onSubmit: (result: CommandFormResult) => void;
}

function fieldStyle(errors: string | null) {
  return errors ? [styles.input, styles.inputError] : styles.input;
}

export function CommandForm({
  initial,
  providers,
  modelsLoading,
  multiHost,
  categories,
  theme,
  onCancel,
  onSubmit,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<"prompt" | "shell">(initial?.type ?? "prompt");
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [terminalName, setTerminalName] = useState(initial?.terminalName ?? "");
  const [scope, setScope] = useState<"global" | "workspace">(initial?.scope ?? "global");
  const [category, setCategory] = useState(initial?.category ?? "");

  // Migrate stale stored values (bare ids, pre-compose refs) against the live
  // catalog. Explicit picks that are still known survive unchanged.
  useEffect(() => {
    setProvider((current) => resolveModelRef(providers, current || initial?.provider));
  }, [providers, initial?.provider]);

  const variables = useMemo(() => inputVariablesOf(template), [template]);
  const nameError = name.trim().length === 0 ? "Name is required." : null;
  const templateError = template.trim().length === 0 ? "Template is required." : null;
  const providerError =
    type === "prompt"
      ? provider.trim().length === 0
        ? "Provider/model is required."
        : !isFullModelRef(provider)
          ? "Pick a full provider/model reference, e.g. cline/claude-opus-4-6."
          : null
      : null;
  const valid = !nameError && !templateError && !providerError;

  const { foreground, foregroundMuted } = theme.colors;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const monoFont = monoFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: foregroundMuted, fontSize: font(12) }]}>Name</Text>
      <TextInput
        style={[fieldStyle(nameError), { color: foreground, borderColor: theme.colors.border, fontSize: font(13) }, uiFontStyle]}
        value={name}
        onChangeText={setName}
        placeholder="Review pull request"
        placeholderTextColor={foregroundMuted}
      />

      <Text style={[styles.label, { color: foregroundMuted }]}>Type</Text>
      <View style={styles.row}>
        {(["prompt", "shell"] as const).map((option) => (
          <Pressable
            key={option}
            style={[styles.chip, { borderColor: theme.colors.border }, type === option && styles.chipActive]}
            onPress={() => setType(option)}
          >
            <Text style={[styles.chipText, { color: foreground }, type === option && styles.chipTextActive]}>
              {option === "prompt" ? "Prompt → agent" : "Shell → terminal"}
            </Text>
          </Pressable>
        ))}
      </View>

      {type === "prompt" ? (
        <>
          <Text style={[styles.label, { color: foregroundMuted }]}>Provider / model</Text>
          <ProviderModelPicker
            providers={providers}
            value={isFullModelRef(provider) ? provider.trim() : ""}
            loading={modelsLoading}
            multiHost={multiHost}
            theme={theme}
            onChange={setProvider}
          />
          {provider.trim().length > 0 && !isFullModelRef(provider) ? (
            <Text style={[styles.hint, { color: foregroundMuted }]}>
              Stored value “{provider.trim()}” is not a full reference — pick a model above to migrate it.
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={[styles.label, { color: foregroundMuted }]}>Terminal name (optional)</Text>
          <TextInput
            style={[styles.input, { color: foreground, borderColor: theme.colors.border }]}
            value={terminalName}
            onChangeText={setTerminalName}
            placeholder="build"
            placeholderTextColor={foregroundMuted}
          />
        </>
      )}

      <Text style={[styles.label, { color: foregroundMuted }]}>Category</Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.chip, { borderColor: theme.colors.border }, category.trim().length === 0 && styles.chipActive]}
          onPress={() => setCategory("")}
        >
          <Text
            style={[
              styles.chipText,
              { color: foreground },
              category.trim().length === 0 && styles.chipTextActive,
            ]}
          >
            None
          </Text>
        </Pressable>
        {categories.map((entry) => (
          <Pressable
            key={entry.sortKey}
            style={[
              styles.chip,
              { borderColor: theme.colors.border },
              category.trim().toLowerCase() === entry.sortKey && styles.chipActive,
            ]}
            onPress={() => setCategory(entry.name)}
          >
            <Text
              style={[
                styles.chipText,
                { color: foreground },
                category.trim().toLowerCase() === entry.sortKey && styles.chipTextActive,
              ]}
            >
              {entry.name}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={[styles.input, { color: foreground, borderColor: theme.colors.border }]}
        value={category}
        onChangeText={setCategory}
        placeholder="Or type a new category name"
        placeholderTextColor={foregroundMuted}
      />
      {category.trim().length > 0 && !categories.some((entry) => entry.sortKey === category.trim().toLowerCase()) ? (
        <Text style={[styles.hint, { color: foregroundMuted }]}>
          “{category.trim()}” is new — it is added to the category list when the command is saved.
        </Text>
      ) : null}

      <Text style={[styles.label, { color: foregroundMuted }]}>Scope</Text>
      <View style={styles.row}>
        {(["global", "workspace"] as const).map((option) => (
          <Pressable
            key={option}
            style={[styles.chip, { borderColor: theme.colors.border }, scope === option && styles.chipActive]}
            onPress={() => setScope(option)}
          >
            <Text style={[styles.chipText, { color: foreground }, scope === option && styles.chipTextActive]}>
              {option === "global" ? "Global" : "This workspace only"}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.label, { color: foregroundMuted, fontSize: font(12) }]}>Template</Text>
      <TextInput
        style={[
          styles.input,
          styles.multiline,
          { color: foreground, borderColor: theme.colors.border, fontSize: font(13) },
          monoFont ? { fontFamily: monoFont } : null,
          templateError ? styles.inputError : null,
        ]}
        value={template}
        onChangeText={setTemplate}
        placeholder={"Review {{input:pr}} and fix the failing tests."}
        placeholderTextColor={foregroundMuted}
        multiline
      />
      <Text style={[styles.hint, { color: foregroundMuted }]}>
        Variables: {"{{input:name|default}}"}, {"{{workspace.name}}"}, {"{{workspace.path}}"}, {"{{date}}"}, {"{{time}}"}
      </Text>
      {variables.length > 0 ? (
        <Text style={[styles.hint, { color: foregroundMuted }]}>
          Inputs detected: {variables.map((variable) => variable.name).join(", ")}
        </Text>
      ) : null}

      {nameError || templateError || providerError ? (
        <Text style={styles.errorText}>{nameError ?? templateError ?? providerError}</Text>
      ) : null}

      <View style={styles.row}>
        <Pressable style={[styles.button, styles.secondaryButton]} onPress={onCancel}>
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.button, !valid && styles.buttonDisabled]}
          disabled={!valid}
          onPress={() =>
            onSubmit({
              name: name.trim(),
              type,
              template,
              provider: type === "prompt" ? provider.trim() || null : null,
              terminalName: type === "shell" ? terminalName.trim() || null : null,
              scope,
              category: category.trim() || null,
            })
          }
        >
          <Text style={styles.buttonText}>Save command</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  label: { marginTop: 8, marginBottom: 2, fontSize: 12, opacity: 0.7 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
  },
  chipActive: { backgroundColor: "rgba(90,140,255,0.25)", borderColor: "rgba(90,140,255,0.8)" },
  chipText: { fontSize: 12 },
  chipTextActive: { fontWeight: "600" },
  chipTextDisabled: { opacity: 0.45 },
  input: {
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  inputError: { borderColor: "rgb(220,80,80)" },
  multiline: { minHeight: 90, textAlignVertical: "top" },
  hint: { fontSize: 11, opacity: 0.6, marginTop: 2 },
  errorText: { color: "rgb(220,80,80)", fontSize: 12, marginTop: 4 },
  button: {
    flex: 1,
    marginTop: 12,
    backgroundColor: "rgba(90,140,255,0.9)",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  secondaryButton: { backgroundColor: "rgba(128,128,128,0.3)" },
  buttonText: { color: "white", fontWeight: "600" },
});
