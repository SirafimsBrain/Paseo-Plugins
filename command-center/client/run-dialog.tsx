import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { CommandDefinition } from "../shared/commands";
import { inputVariablesOf } from "../shared/template";
import { renderPreview } from "./preview";

interface WorkspaceOption {
  id: string;
  name: string;
}

interface AgentOption {
  id: string;
  title: string | null;
  status: string;
}

interface Props {
  command: CommandDefinition;
  workspaces: WorkspaceOption[];
  agents: AgentOption[];
  busy: boolean;
  errorText: string | null;
  theme: PluginTheme;
  onRun: (input: {
    values: Record<string, string>;
    workspaceId: string | undefined;
    agentId: string | undefined;
    newWorktree: boolean;
  }) => void;
  onCancel: () => void;
}

export function RunDialog({ command, workspaces, agents, busy, errorText, theme, onRun, onCancel }: Props) {
  const declared = command.variables;
  const discovered = useMemo(() => inputVariablesOf(command.template), [command.template]);
  const merged = useMemo(() => {
    const byName = new Map(declared.map((variable) => [variable.name, variable]));
    for (const variable of discovered) {
      if (!byName.has(variable.name)) byName.set(variable.name, { name: variable.name, prompt: variable.name, defaultValue: variable.defaultValue });
    }
    return [...byName.values()];
  }, [declared, discovered]);

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(merged.map((variable) => [variable.name, variable.defaultValue ?? ""])),
  );
  const [workspaceId, setWorkspaceId] = useState<string>(
    workspaces.length > 0 ? (workspaces[0] as WorkspaceOption).id : "",
  );
  const [agentId, setAgentId] = useState<string>("");
  const [newWorktree, setNewWorktree] = useState(false);

  const isShell = command.type === "shell";
  const needsWorkspace = isShell || command.scope === "workspace" || newWorktree;
  const openAgents = agents.filter((agent) => agent.status !== "closed");
  const preview = renderPreview(command.template, values, workspaceId, workspaces);
  const { foreground, foregroundMuted } = theme.colors;

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: foreground }]}>{command.name}</Text>
      <Text style={[styles.subtitle, { color: foregroundMuted }]}>
        {isShell
          ? "Runs in a new terminal of the selected workspace."
          : command.scope === "workspace"
            ? "Runs in the selected workspace."
            : "Creates a new agent."}
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

      {needsWorkspace ? (
        <View style={styles.field}>
          <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Workspace</Text>
          <View style={styles.row}>
            {workspaces.slice(0, 6).map((workspace) => (
              <Pressable
                key={workspace.id}
                style={[
                  styles.chip,
                  { borderColor: theme.colors.border },
                  workspaceId === workspace.id && styles.chipActive,
                ]}
                onPress={() => setWorkspaceId(workspace.id)}
              >
                <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
                  {workspace.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {!isShell ? (
        <>
          <View style={styles.field}>
            <Pressable style={styles.checkRow} onPress={() => setNewWorktree((value) => !value)}>
              <Text style={[styles.check, { color: foreground }]}>{newWorktree ? "☑" : "☐"}</Text>
              <Text style={[styles.checkLabel, { color: foreground }]}>Branch off into a new worktree</Text>
            </Pressable>
          </View>
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Send to an existing agent (optional)</Text>
            <View style={styles.row}>
              <Pressable
                style={[styles.chip, { borderColor: theme.colors.border }, agentId === "" && styles.chipActive]}
                onPress={() => setAgentId("")}
              >
                <Text style={[styles.chipText, { color: foreground }]}>New agent</Text>
              </Pressable>
              {openAgents.slice(0, 5).map((agent) => (
                <Pressable
                  key={agent.id}
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
          </View>
        </>
      ) : null}

      <View style={styles.previewBox}>
        <Text style={[styles.previewLabel, { color: foregroundMuted }]}>Preview</Text>
        <Text style={[styles.previewText, { color: foreground }]}>{preview || "—"}</Text>
      </View>

      {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}

      <View style={styles.row}>
        <Pressable style={[styles.button, styles.secondaryButton]} onPress={onCancel} disabled={busy}>
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.button, busy && styles.buttonDisabled]}
          disabled={busy}
          onPress={() =>
            onRun({
              values,
              workspaceId: needsWorkspace ? workspaceId || undefined : undefined,
              agentId: !isShell && agentId !== "" ? agentId : undefined,
              newWorktree: !isShell && newWorktree,
            })
          }
        >
          <Text style={styles.buttonText}>{busy ? "Running…" : isShell ? "Run in terminal" : "Run"}</Text>
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
  errorText: { color: "rgb(220,80,80)", fontSize: 12, marginTop: 6 },
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
