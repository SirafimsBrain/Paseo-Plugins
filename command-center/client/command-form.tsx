import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { CommandDefinition } from "../shared/commands";
import { inputVariablesOf } from "../shared/template";

export interface CommandFormResult {
  name: string;
  type: "prompt" | "shell";
  template: string;
  provider: string | null;
  terminalName: string | null;
  scope: "global" | "workspace";
}

interface Props {
  initial?: CommandDefinition | null;
  /** Provider ids known to the daemon (e.g. cline, kilo, qwen-code). */
  providers: { id: string; enabled: boolean }[];
  onCancel: () => void;
  onSubmit: (result: CommandFormResult) => void;
}

function fieldStyle(errors: string | null) {
  return errors ? [styles.input, styles.inputError] : styles.input;
}

export function CommandForm({ initial, providers, onCancel, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<"prompt" | "shell">(initial?.type ?? "prompt");
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [terminalName, setTerminalName] = useState(initial?.terminalName ?? "");
  const [scope, setScope] = useState<"global" | "workspace">(initial?.scope ?? "global");

  const variables = useMemo(() => inputVariablesOf(template), [template]);
  const nameError = name.trim().length === 0 ? "Name is required." : null;
  const templateError = template.trim().length === 0 ? "Template is required." : null;
  const providerError = type === "prompt" && provider.trim().length === 0 ? "Provider is required." : null;
  const valid = !nameError && !templateError && !providerError;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Name</Text>
      <TextInput style={fieldStyle(nameError)} value={name} onChangeText={setName} placeholder="Review pull request" />

      <Text style={styles.label}>Type</Text>
      <View style={styles.row}>
        {(["prompt", "shell"] as const).map((option) => (
          <Pressable
            key={option}
            style={[styles.chip, type === option && styles.chipActive]}
            onPress={() => setType(option)}
          >
            <Text style={[styles.chipText, type === option && styles.chipTextActive]}>
              {option === "prompt" ? "Prompt → agent" : "Shell → terminal"}
            </Text>
          </Pressable>
        ))}
      </View>

      {type === "prompt" ? (
        <>
          <Text style={styles.label}>Provider (provider/model)</Text>
          <TextInput
            style={fieldStyle(providerError)}
            value={provider}
            onChangeText={setProvider}
            placeholder="provider/model, e.g. cline"
            autoCapitalize="none"
          />
          {providers.length > 0 ? (
            <View style={styles.row}>
              {providers.slice(0, 10).map((option) => (
                <Pressable
                  key={option.id}
                  style={[styles.chip, provider === option.id && styles.chipActive]}
                  onPress={() => setProvider(option.id)}
                >
                  <Text style={[styles.chipText, !option.enabled && styles.chipTextDisabled]} numberOfLines={1}>
                    {option.id}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.label}>Terminal name (optional)</Text>
          <TextInput style={styles.input} value={terminalName} onChangeText={setTerminalName} placeholder="build" />
        </>
      )}

      <Text style={styles.label}>Scope</Text>
      <View style={styles.row}>
        {(["global", "workspace"] as const).map((option) => (
          <Pressable
            key={option}
            style={[styles.chip, scope === option && styles.chipActive]}
            onPress={() => setScope(option)}
          >
            <Text style={[styles.chipText, scope === option && styles.chipTextActive]}>
              {option === "global" ? "Global" : "This workspace only"}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Template</Text>
      <TextInput
        style={[styles.input, styles.multiline, templateError ? styles.inputError : null]}
        value={template}
        onChangeText={setTemplate}
        placeholder={"Review {{input:pr}} and fix the failing tests."}
        multiline
      />
      <Text style={styles.hint}>
        Variables: {"{{input:name|default}}"}, {"{{workspace.name}}"}, {"{{workspace.path}}"}, {"{{date}}"}, {"{{time}}"}
      </Text>
      {variables.length > 0 ? (
        <Text style={styles.hint}>
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
