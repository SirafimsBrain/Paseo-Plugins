import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { CommandDefinition, ProviderWithModels, RunResult } from "../shared/commands";
import { inputVariablesOf } from "../shared/template";
import { isFullModelRef, resolveModelRef } from "../shared/commands";
import { renderPreview } from "./preview";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";
import { ProviderModelPicker } from "./provider-model-picker";

export interface DialogWorkspaceOption {
  id: string;
  name: string;
  serverId: string;
  hostLabel: string;
  directory: string | null;
}

export interface DialogAgentOption {
  id: string;
  title: string | null;
  status: string;
  workspaceId: string | null;
  serverId: string;
  hostLabel: string;
}

export interface DialogProviderOption {
  id: string;
  enabled: boolean;
  serverId: string;
  hostLabel: string;
}
/** One fan-out target: a workspace on a host, plus per-run overrides. */
export interface BatchTarget {
  /** JSON key from `workspaceKey()`; null means "let the server pick". */
  workspaceKey: string | null;
  agentId?: string;
  provider?: string;
  newWorktree: boolean;
}

export interface BatchItemResult {
  key: string;
  workspaceName: string;
  hostLabel: string;
  ok: boolean;
  kind: RunResult["kind"];
  error: string | null;
}

interface Props {
  command: CommandDefinition;
  workspaces: DialogWorkspaceOption[];
  agents: DialogAgentOption[];
  providers: ProviderWithModels[];
  modelsLoading: boolean;
  multiHost: boolean;
  theme: PluginTheme;
  /** Repeat preset from a history entry; overrides template defaults. */
  initialValues?: Record<string, string>;
  initialProvider?: string | null;
  /** JSON workspace key; null/unknown falls back to the default target. */
  initialWorkspaceKey?: string | null;
  initialAgentId?: string | null;
  onRun: (input: { values: Record<string, string>; targets: BatchTarget[] }) => Promise<BatchItemResult[]>;
  onCancel: () => void;
}

function isKnownWorkspaceKey(workspaces: DialogWorkspaceOption[], key: string): boolean {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed)) return false;
    return workspaces.some((option) => option.serverId === parsed[0] && option.id === parsed[1]);
  } catch {
    return false;
  }
}

export function RunDialog({
  command,
  workspaces,
  agents,
  providers,
  modelsLoading,
  multiHost,
  theme,
  initialValues,
  initialProvider,
  initialWorkspaceKey,
  initialAgentId,
  onRun,
  onCancel,
}: Props) {
  const declared = command.variables;
  const discovered = useMemo(() => inputVariablesOf(command.template), [command.template]);
  const merged = useMemo(() => {
    const byName = new Map(declared.map((variable) => [variable.name, variable]));
    for (const variable of discovered) {
      if (!byName.has(variable.name)) byName.set(variable.name, { name: variable.name, prompt: variable.name, defaultValue: variable.defaultValue });
    }
    return [...byName.values()];
  }, [declared, discovered]);

  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(merged.map((variable) => [variable.name, variable.defaultValue ?? ""])),
    ...initialValues,
  }));
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => {
    if (initialWorkspaceKey && isKnownWorkspaceKey(workspaces, initialWorkspaceKey)) {
      return [initialWorkspaceKey];
    }
    return workspaces.length > 0 ? [JSON.stringify([workspaces[0]!.serverId, workspaces[0]!.id])] : [];
  });
  const [provider, setProvider] = useState<string>(() =>
    resolveModelRef(providers, initialProvider ?? command.provider),
  );
  const [agentId, setAgentId] = useState<string>(() =>
    initialAgentId && agents.some((agent) => agent.id === initialAgentId && agent.status !== "closed")
      ? initialAgentId
      : "",
  );
  const [newWorktree, setNewWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchItemResult[] | null>(null);

  // Re-resolve when the model catalog arrives/changes. Safe: a picked value
  // that is still known is returned unchanged, so explicit picks survive.
  useEffect(() => {
    setProvider((current) => resolveModelRef(providers, current || initialProvider || command.provider));
  }, [providers, command.provider, initialProvider]);

  const isShell = command.type === "shell";
  const openAgents = agents.filter((agent) => agent.status !== "closed");

  const selectedWorkspaces = useMemo(
    () =>
      selectedKeys
        .map((key) => {
          try {
            const parsed: unknown = JSON.parse(key);
            if (!Array.isArray(parsed)) return null;
            return workspaces.find((option) => option.serverId === parsed[0] && option.id === parsed[1]) ?? null;
          } catch {
            return null;
          }
        })
        .filter((option): option is DialogWorkspaceOption => option !== null),
    [selectedKeys, workspaces],
  );

  const groupedWorkspaces = useMemo(() => {
    const groups = new Map<string, { label: string; options: DialogWorkspaceOption[] }>();
    for (const option of workspaces) {
      const groupKey = option.serverId;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          label: option.hostLabel.length > 0 ? option.hostLabel : "This host",
          options: [],
        };
        groups.set(groupKey, group);
      }
      group.options.push(option);
    }
    return [...groups.values()];
  }, [workspaces]);

  // Existing-agent picker is only meaningful for a single target.
  const singleTargetServer = selectedWorkspaces.length === 1 ? (selectedWorkspaces[0]?.serverId ?? null) : null;
  const agentsForTarget = useMemo(() => {
    if (selectedWorkspaces.length !== 1) return [];
    if (singleTargetServer === null) return openAgents;
    return openAgents.filter((agent) => agent.serverId === singleTargetServer);
  }, [openAgents, selectedWorkspaces.length, singleTargetServer]);

  const firstWorkspace = selectedWorkspaces[0] ?? null;
  const preview = renderPreview(
    command.template,
    values,
    firstWorkspace?.id,
    workspaces.map((option) => ({ id: option.id, name: option.name })),
  );

  const { foreground, foregroundMuted } = theme.colors;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const monoFont = monoFontFamily(typography);

  const toggleWorkspace = (key: string) => {
    setResults(null);
    setSelectedKeys((previous) =>
      previous.includes(key) ? previous.filter((candidate) => candidate !== key) : [...previous, key],
    );
  };

  const targetCount = Math.max(selectedKeys.length, 1);
  const providerValid = isShell || isFullModelRef(provider);
  const canRun = !busy && providerValid;
  const runLabel = busy ? "Running…" : isShell ? `Run in terminal on ${targetCount}` : targetCount > 1 ? `Run on ${targetCount} targets` : "Run";

  const handleRun = () => {
    if (!canRun) return;
    const targets: BatchTarget[] =
      selectedKeys.length === 0
        ? [{ workspaceKey: null, agentId: agentId !== "" ? agentId : undefined, provider: provider || undefined, newWorktree }]
        : selectedKeys.map((workspaceKey) => ({
            workspaceKey,
            agentId: selectedKeys.length === 1 && agentId !== "" ? agentId : undefined,
            provider: provider || undefined,
            newWorktree,
          }));
    setBusy(true);
    setResults(null);
    void onRun({ values, targets })
      .then((items) => setResults(items))
      .catch((error: unknown) =>
        setResults([
          {
            key: "error",
            workspaceName: "",
            hostLabel: "",
            ok: false,
            kind: isShell ? "terminal" : "new-agent",
            error: error instanceof Error ? error.message : String(error),
          },
        ]),
      )
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: foreground }, uiFont ? { fontFamily: uiFont } : null, { fontSize: font(16) }]}>
        {command.name}
      </Text>
      <Text style={[styles.subtitle, { color: foregroundMuted, fontSize: font(12) }]}>
        {isShell
          ? `Runs in a new terminal on each selected workspace (${targetCount}).`
          : targetCount > 1
            ? `Creates a new agent on each of the ${targetCount} selected workspaces.`
            : command.scope === "workspace"
              ? "Runs in the selected workspace."
              : "Creates a new agent in the selected workspace."}
      </Text>

      {merged.length > 0 ? (
        <>
          <Text style={[styles.label, { color: foregroundMuted }]}>Inputs</Text>
          {merged.map((variable) => (
            <View key={variable.name} style={styles.field}>
              <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>{variable.prompt || variable.name}</Text>
              <TextInput
                style={[styles.input, { color: foreground, borderColor: theme.colors.border }]}
                value={values[variable.name] ?? ""}
                onChangeText={(text) => setValues((previous) => ({ ...previous, [variable.name]: text }))}
                placeholder={variable.defaultValue ?? variable.name}
                placeholderTextColor={foregroundMuted}
              />
            </View>
          ))}
        </>
      ) : null}

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>
          Workspaces{targetCount > 1 ? ` (${targetCount} selected)` : ""} — tap to select several
        </Text>
        {workspaces.length === 0 ? (
          <Text style={[styles.hint, { color: foregroundMuted }]}>
            No workspaces found — the run will use the server&apos;s best guess.
          </Text>
        ) : null}
        {groupedWorkspaces.map((group) => (
          <View key={group.label} style={styles.group}>
            {multiHost ? <Text style={[styles.groupLabel, { color: foregroundMuted }]}>{group.label}</Text> : null}
            <View style={styles.row}>
              {group.options.map((option) => {
                const key = JSON.stringify([option.serverId, option.id]);
                const active = selectedKeys.includes(key);
                return (
                  <Pressable
                    key={key}
                    style={[styles.chip, { borderColor: theme.colors.border }, active && styles.chipActive]}
                    onPress={() => toggleWorkspace(key)}
                  >
                    <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
                      {active ? "✓ " : ""}{option.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </View>

      {!isShell ? (
        <>
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Provider / model</Text>
            <ProviderModelPicker
              providers={providers}
              value={provider}
              loading={modelsLoading}
              multiHost={multiHost}
              theme={theme}
              onChange={(next) => {
                setProvider(next);
                setResults(null);
              }}
            />
            {!providerValid ? (
              <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>
                Pick a provider/model — Paseo requires the full format, e.g. cline/claude-opus-4-6.
              </Text>
            ) : null}
          </View>
          <View style={styles.field}>
            <Pressable style={styles.checkRow} onPress={() => setNewWorktree((value) => !value)}>
              <Text style={[styles.check, { color: foreground }]}>{newWorktree ? "☑" : "☐"}</Text>
              <Text style={[styles.checkLabel, { color: foreground }]}>Branch off into a new worktree</Text>
            </Pressable>
          </View>
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>
              {selectedWorkspaces.length <= 1 ? "Send to an existing agent (optional)" : "Existing agent (single target only)"}
            </Text>
            {selectedWorkspaces.length <= 1 ? (
              <View style={styles.row}>
                <Pressable
                  style={[styles.chip, { borderColor: theme.colors.border }, agentId === "" && styles.chipActive]}
                  onPress={() => setAgentId("")}
                >
                  <Text style={[styles.chipText, { color: foreground }]}>New agent</Text>
                </Pressable>
                {agentsForTarget.map((agent) => (
                  <Pressable
                    key={`${agent.serverId}:${agent.id}`}
                    style={[
                      styles.chip,
                      { borderColor: theme.colors.border },
                      agentId === agent.id && styles.chipActive,
                    ]}
                    onPress={() => setAgentId(agent.id)}
                  >
                    <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
                      {agent.title ?? agent.id.slice(0, 10)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={[styles.hint, { color: foregroundMuted }]}>
                Each target gets a new agent — pick a single workspace to reuse an existing one.
              </Text>
            )}
          </View>
        </>
      ) : null}

      <View style={styles.previewBox}>
        <Text style={[styles.previewLabel, { color: foregroundMuted }]}>
          Preview{firstWorkspace ? ` — ${firstWorkspace.name}` : ""}{targetCount > 1 ? ` (+${targetCount - 1} more)` : ""}
        </Text>
        <Text style={[styles.previewText, { color: foreground, fontSize: font(12) }, monoFont ? { fontFamily: monoFont } : null]}>
          {preview || "—"}
        </Text>
      </View>

      {results ? (
        <View style={styles.field}>
          {results.map((item) => (
            <Text
              key={item.key}
              style={[styles.resultLine, { color: item.ok ? foreground : theme.colors.statusDanger }]}
            >
              {item.ok ? "✓" : "✗"} {item.hostLabel.length > 0 ? `${item.hostLabel} / ` : ""}{item.workspaceName}
              {item.error ? ` — ${item.error}` : ""}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.row}>
        <Pressable style={[styles.button, styles.secondaryButton]} onPress={onCancel} disabled={busy}>
          <Text style={styles.buttonText}>{results ? "Close" : "Cancel"}</Text>
        </Pressable>
        <Pressable style={[styles.button, !canRun && styles.buttonDisabled]} disabled={!canRun} onPress={handleRun}>
          <Text style={styles.buttonText}>{runLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 4 },
  title: { fontSize: 16, fontWeight: "700" },
  subtitle: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
  label: { marginTop: 10, fontSize: 12, opacity: 0.7 },
  field: { marginTop: 8 },
  fieldLabel: { fontSize: 12, opacity: 0.7, marginBottom: 3 },
  group: { marginTop: 4 },
  groupLabel: { fontSize: 11, opacity: 0.7, marginBottom: 2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    maxWidth: 220,
  },
  chipActive: { backgroundColor: "rgba(90,140,255,0.25)", borderColor: "rgba(90,140,255,0.8)" },
  chipText: { fontSize: 12 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  check: { fontSize: 14 },
  checkLabel: { fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  previewBox: {
    marginTop: 10,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.12)",
    padding: 10,
  },
  previewLabel: { fontSize: 11, opacity: 0.6, marginBottom: 2 },
  previewText: { fontSize: 12, fontFamily: "monospace" },
  hint: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  resultLine: { fontSize: 12, marginTop: 2 },
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
