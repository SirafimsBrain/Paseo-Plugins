import { useEffect, useMemo, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  CommandCategory,
  CommandDefinition,
  ProviderWithModels,
  WorkflowStep,
  WorkflowStepCondition,
} from "../shared/commands";
import { isFullModelRef, resolveModelRef } from "../shared/commands";
import { inputVariablesOf } from "../shared/template";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";
import { commandCenterSettings } from "../shared/settings";
import { ProviderModelPicker } from "./provider-model-picker";

export interface CommandFormResult {
  name: string;
  type: "prompt" | "shell" | "workflow";
  /** Empty for workflows, which have no template of their own. */
  template: string;
  /** Workflow steps in execution order; empty for prompt/shell commands. */
  steps: WorkflowStep[];
  provider: string | null;
  terminalName: string | null;
  scope: "global" | "workspace";
  /** Chosen from the stored list, or a brand-new label typed in. Empty = none. */
  category: string | null;
}

const WORKFLOW_CONDITIONS: { label: string; value: WorkflowStepCondition }[] = [
  { label: "Always", value: "always" },
  { label: "On success", value: "on-success" },
  { label: "On failure", value: "on-failure" },
];

interface Props {
  initial?: CommandDefinition | null;
  /** The saved library, for the workflow step picker. */
  commands: CommandDefinition[];
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
  commands,
  providers,
  modelsLoading,
  multiHost,
  categories,
  theme,
  onCancel,
  onSubmit,
}: Props) {
  const settings = useSettings(commandCenterSettings);
  const defaultProviderFromSettings =
    settings.status === "ready" ? settings.values.defaultProvider.trim() : "";
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<"prompt" | "shell" | "workflow">(initial?.type ?? "prompt");
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [steps, setSteps] = useState<WorkflowStep[]>(initial?.steps ?? []);
  const [provider, setProvider] = useState(initial?.provider ?? defaultProviderFromSettings);
  const [terminalName, setTerminalName] = useState(initial?.terminalName ?? "");
  const [scope, setScope] = useState<"global" | "workspace">(initial?.scope ?? "global");
  const [category, setCategory] = useState(initial?.category ?? "");

  // Migrate stale stored values (bare ids, pre-compose refs) against the live
  // catalog. Explicit picks that are still known survive unchanged; the
  // settings default fills brand-new commands once the catalog loads.
  useEffect(() => {
    setProvider((current) =>
      resolveModelRef(providers, current || initial?.provider || defaultProviderFromSettings),
    );
  }, [providers, initial?.provider, defaultProviderFromSettings]);

  const variables = useMemo(() => inputVariablesOf(template), [template]);
  const stepCandidates = useMemo(
    () => commands.filter((command) => command.type !== "workflow" && command.id !== initial?.id),
    [commands, initial?.id],
  );
  const nameError = name.trim().length === 0 ? "Name is required." : null;
  const templateError =
    type !== "workflow" && template.trim().length === 0 ? "Template is required." : null;
  const stepsError =
    type === "workflow" && steps.length === 0
      ? "Add at least one step — a workflow is built from saved commands."
      : null;
  const providerError =
    type === "prompt"
      ? provider.trim().length === 0
        ? "Provider/model is required."
        : !isFullModelRef(provider)
          ? "Pick a full provider/model reference, e.g. cline/claude-opus-4-6."
          : null
      : null;
  const valid = !nameError && !templateError && !providerError && !stepsError;

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
        {(["prompt", "shell", "workflow"] as const).map((option) => (
          <Pressable
            key={option}
            style={[styles.chip, { borderColor: theme.colors.border }, type === option && styles.chipActive]}
            onPress={() => setType(option)}
          >
            <Text style={[styles.chipText, { color: foreground }, type === option && styles.chipTextActive]}>
              {option === "prompt"
                ? "Prompt → agent"
                : option === "shell"
                  ? "Shell → terminal"
                  : "Workflow → steps"}
            </Text>
          </Pressable>
        ))}
      </View>

      {type === "workflow" ? null : type === "prompt" ? (
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

      {type === "workflow" ? (
        <>
          <Text style={[styles.label, { color: foregroundMuted }]}>
            Steps (run in this order)
          </Text>
          {steps.map((step, index) => {
            const stepCommand = commands.find((command) => command.id === step.commandId);
            return (
              <View key={`${step.commandId}-${index}`} style={[styles.stepCard, { borderColor: theme.colors.border }]}>
                <View style={styles.stepHeader}>
                  <Text style={[styles.stepTitle, { color: foreground }]} numberOfLines={1}>
                    {index + 1}. {stepCommand?.name ?? "Missing command"}
                  </Text>
                  <View style={styles.row}>
                    <Pressable
                      style={[styles.smallAction, index === 0 && styles.disabled]}
                      disabled={index === 0}
                      onPress={() =>
                        setSteps((current) => {
                          const next = [...current];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          return next;
                        })
                      }
                    >
                      <Text style={[styles.smallActionText, { color: foreground }]}>↑</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.smallAction, index === steps.length - 1 && styles.disabled]}
                      disabled={index === steps.length - 1}
                      onPress={() =>
                        setSteps((current) => {
                          const next = [...current];
                          [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                          return next;
                        })
                      }
                    >
                      <Text style={[styles.smallActionText, { color: foreground }]}>↓</Text>
                    </Pressable>
                    <Pressable
                      style={styles.smallAction}
                      onPress={() => setSteps((current) => current.filter((_, position) => position !== index))}
                    >
                      <Text style={[styles.smallActionText, styles.errorText]}>✕</Text>
                    </Pressable>
                  </View>
                </View>
                <View style={styles.row}>
                  {WORKFLOW_CONDITIONS.map((condition) => (
                    <Pressable
                      key={condition.value}
                      style={[
                        styles.chip,
                        { borderColor: theme.colors.border },
                        step.condition === condition.value && styles.chipActive,
                      ]}
                      onPress={() =>
                        setSteps((current) =>
                          current.map((candidate, position) =>
                            position === index ? { ...candidate, condition: condition.value } : candidate,
                          ),
                        )
                      }
                    >
                      <Text
                        style={[
                          styles.chipText,
                          { color: foreground },
                          step.condition === condition.value && styles.chipTextActive,
                        ]}
                      >
                        {condition.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            );
          })}
          <Text style={[styles.hint, { color: foregroundMuted }]}>
            A step runs when its condition matches the step before it; a failed step does not stop the
            steps that follow an “Always” step.
          </Text>
          <Text style={[styles.label, { color: foregroundMuted }]}>Add step</Text>
          {stepCandidates.length === 0 ? (
            <Text style={[styles.hint, { color: foregroundMuted }]}>
              Save a prompt or shell command first — a workflow is built from saved commands.
            </Text>
          ) : (
            <View style={styles.row}>
              {stepCandidates.map((candidate) => (
                <Pressable
                  key={candidate.id}
                  style={[styles.chip, { borderColor: theme.colors.border }]}
                  onPress={() =>
                    setSteps((current) => [...current, { commandId: candidate.id, condition: "always" }])
                  }
                >
                  <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
                    + {candidate.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </>
      ) : (
        <>
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
        </>
      )}

      {nameError || templateError || providerError || stepsError ? (
        <Text style={styles.errorText}>{nameError ?? templateError ?? providerError ?? stepsError}</Text>
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
              template: type === "workflow" ? "" : template,
              steps: type === "workflow" ? steps : [],
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
  stepCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginTop: 6,
    gap: 6,
  },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  stepTitle: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  smallAction: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: "rgba(128,128,128,0.2)",
  },
  smallActionText: { fontSize: 12 },
  disabled: { opacity: 0.35 },
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
