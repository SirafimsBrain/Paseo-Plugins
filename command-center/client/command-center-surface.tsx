import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";
import {
  clearHistory,
  deleteCommand,
  listCommands,
  listHistory,
  runCommand,
  saveCommand,
  toggleFavorite,
} from "../shared/commands";
import { CommandForm, type CommandFormResult } from "./command-form";
import { RunDialog } from "./run-dialog";

type Tab = "library" | "history";

interface WorkspaceOption {
  id: string;
  name: string;
}

interface AgentOption {
  id: string;
  title: string | null;
  status: string;
}

interface ProviderOption {
  id: string;
  enabled: boolean;
}

export function CommandCenterSurface(_props: PluginSurfaceProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const listRpc = useRpc(listCommands);
  const historyRpc = useRpc(listHistory);
  const clearHistoryRpc = useRpc(clearHistory);
  const deleteRpc = useRpc(deleteCommand);
  const favoriteRpc = useRpc(toggleFavorite);
  const saveRpc = useRpc(saveCommand);
  const runRpc = useRpc(runCommand);

  const [tab, setTab] = useState<Tab>("library");
  const [editing, setEditing] = useState<CommandDefinition | null>(null);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<CommandDefinition | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [historyVisible, setHistoryVisible] = useState(false);

  const [commands, setCommands] = useState<CommandDefinition[] | null>(null);
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);

  const refresh = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listRpc({})
      .then((result) => {
        if (!cancelled) {
          setCommands(result.commands);
          setCommandsError(null);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setCommandsError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [listRpc, reloadKey]);

  useEffect(() => {
    if (!historyVisible) return;
    let cancelled = false;
    historyRpc({})
      .then((result) => {
        if (!cancelled) setHistory(result.entries);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [historyRpc, historyVisible, reloadKey]);

  useEffect(() => {
    let cancelled = false;

    const loadWorkspaces = async () => {
      const result = await paseo.workspaces.list();
      const entries = result.entries.map((entry) => {
        const name = entry.projectCustomName ?? entry.title ?? entry.name;
        return { id: entry.id, name: name.length > 0 ? name : entry.id };
      });
      if (!cancelled) setWorkspaces(entries);
    };

    const loadAgents = async () => {
      const result = await paseo.agents
        .list({ scope: "active", filter: { includeArchived: false } })
        .catch(() => null);
      const entries = (result?.entries ?? [])
        .map((entry) => {
          const record = entry as {
            id?: string;
            title?: string | null;
            status?: string;
          };
          return {
            id: typeof record.id === "string" ? record.id : "",
            title: typeof record.title === "string" ? record.title : null,
            status: typeof record.status === "string" ? record.status : "unknown",
          };
        })
        .filter((agent) => agent.id !== "");
      if (!cancelled) setAgents(entries);
    };

    const loadProviders = async () => {
      const snapshot = await paseo.providers.snapshot().catch(() => null);
      const seen = new Map<string, ProviderOption>();
      for (const entry of snapshot?.entries ?? []) {
        const id = entry.provider;
        if (typeof id !== "string" || id.length === 0) continue;
        const enabled = entry.enabled !== false;
        const existing = seen.get(id);
        seen.set(id, { id, enabled: (existing?.enabled ?? true) && enabled });
      }
      if (!cancelled) setProviders([...seen.values()]);
    };

    void loadWorkspaces();
    void loadAgents();
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, [paseo, reloadKey]);

  const sorted = useMemo(() => {
    const favoriteFirst = (a: CommandDefinition, b: CommandDefinition) =>
      Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name);
    return [...(commands ?? [])].sort(favoriteFirst);
  }, [commands]);

  const handleSave = async (form: CommandFormResult) => {
    const now = new Date().toISOString();
    const base = editing;
    const id = base?.id ?? `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      const result = await saveRpc({
        command: {
          id,
          name: form.name,
          type: form.type,
          template: form.template,
          provider: form.provider ?? undefined,
          terminalName: form.terminalName ?? undefined,
          scope: form.scope,
          variables: [],
          favorite: base?.favorite ?? false,
          createdAt: base?.createdAt ?? now,
          updatedAt: now,
          useCount: base?.useCount ?? 0,
        },
      });
      if (result.saved) {
        toast.show("Command saved", { variant: "success" });
        setEditing(null);
        setCreating(false);
        refresh();
      } else if (result.error) {
        toast.error(result.error);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async (command: CommandDefinition) => {
    try {
      await deleteRpc({ id: command.id });
      toast.show("Command deleted");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleFavorite = async (command: CommandDefinition) => {
    try {
      await favoriteRpc({ id: command.id, favorite: !command.favorite });
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRun = async (input: {
    command: CommandDefinition;
    values: Record<string, string>;
    workspaceId: string | undefined;
    agentId: string | undefined;
    newWorktree: boolean;
  }) => {
    try {
      const result = await runRpc({
        commandId: input.command.id,
        values: input.values,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        newWorktree: input.newWorktree,
      });
      setRunning(null);
      setRunError(null);
      if (result.ok) {
        if (result.kind === "terminal") {
          toast.show("Command written to a new terminal", { variant: "success" });
        } else if (result.kind === "existing-agent") {
          toast.show("Prompt sent to the agent", { variant: "success" });
        } else {
          toast.show("Agent created", { variant: "success" });
        }
        refresh();
      } else if (result.error) {
        setRunError(result.error);
      }
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  if (creating || editing) {
    return (
      <ScrollView contentContainerStyle={styles.formContainer}>
        <Text style={styles.heading}>{editing ? "Edit command" : "New command"}</Text>
        <CommandForm
          initial={editing}
          providers={providers}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSubmit={(form) => void handleSave(form)}
        />
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.tabRow}>
        {(["library", "history"] as Tab[]).map((option) => (
          <Pressable
            key={option}
            style={[styles.tab, tab === option && styles.tabActive]}
            onPress={() => setTab(option)}
          >
            <Text style={[styles.tabText, tab === option && styles.tabTextActive]}>
              {option === "library" ? "Commands" : "History"}
            </Text>
          </Pressable>
        ))}
        <View style={styles.spacer} />
        <Pressable
          style={styles.smallButton}
          onPress={() => {
            if (tab === "history" && historyVisible) {
              void clearHistoryRpc({}).then(() => {
                toast.show("History cleared");
                refresh();
              });
            } else {
              setHistoryVisible((value) => !value);
              refresh();
            }
          }}
        >
          <Text style={styles.smallButtonText}>{tab === "history" ? "Clear" : "History"}</Text>
        </Pressable>
        <Pressable style={[styles.smallButton, styles.primarySmallButton]} onPress={() => setCreating(true)}>
          <Text style={[styles.smallButtonText, styles.primarySmallButtonText]}>+ New</Text>
        </Pressable>
      </View>

      {tab === "library" ? (
        <ScrollView contentContainerStyle={styles.list}>
          {commands === null && commandsError === null ? <Text style={styles.muted}>Loading…</Text> : null}
          {commandsError ? <Text style={styles.errorText}>Failed to load commands: {commandsError}</Text> : null}
          {commands !== null && sorted.length === 0 ? (
            <Text style={styles.muted}>
              No commands yet. Create one with “+ New” — for example a review prompt or a build shell line.
            </Text>
          ) : null}
          {sorted.map((command) => (
            <View key={command.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Pressable style={styles.star} onPress={() => void handleFavorite(command)}>
                  <Text style={styles.starText}>{command.favorite ? "★" : "☆"}</Text>
                </Pressable>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {command.name}
                </Text>
                <Text style={styles.badge}>{command.type === "shell" ? "shell" : command.provider ?? "prompt"}</Text>
              </View>
              <Text style={styles.cardTemplate} numberOfLines={2}>
                {command.template}
              </Text>
              <View style={styles.cardActions}>
                <Pressable
                  style={[styles.actionButton, styles.runButton]}
                  onPress={() => {
                    setRunError(null);
                    setRunning(command);
                  }}
                >
                  <Text style={[styles.actionText, styles.runText]}>Run</Text>
                </Pressable>
                <Pressable style={styles.actionButton} onPress={() => setEditing(command)}>
                  <Text style={styles.actionText}>Edit</Text>
                </Pressable>
                <Pressable style={styles.actionButton} onPress={() => void handleDelete(command)}>
                  <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
                </Pressable>
                <Text style={styles.useCount}>{command.useCount} runs</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {history === null ? <Text style={styles.muted}>Loading…</Text> : null}
          {history !== null && history.length === 0 ? <Text style={styles.muted}>Nothing has run yet.</Text> : null}
          {(history ?? []).map((entry: HistoryEntry) => (
            <View key={entry.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {entry.commandName}
                </Text>
                <Text style={[styles.badge, !entry.ok && styles.badgeError]}>
                  {entry.ok ? entry.kind : "failed"}
                </Text>
              </View>
              <Text style={styles.cardTemplate} numberOfLines={3}>
                {entry.rendered}
              </Text>
              <Text style={styles.timestamp}>{new Date(entry.at).toLocaleString()}</Text>
              {entry.error ? <Text style={styles.errorText}>{entry.error}</Text> : null}
            </View>
          ))}
        </ScrollView>
      )}

      <Modal
        open={running !== null}
        onOpenChange={(open) => !open && setRunning(null)}
        title={`Run “${running?.name ?? ""}”`}
      >
        <Modal.Content>
          {running ? (
            <RunDialog
              command={running}
              workspaces={workspaces}
              agents={agents}
              busy={false}
              errorText={runError}
              onCancel={() => setRunning(null)}
              onRun={(input) =>
                void handleRun({
                  command: running,
                  values: input.values,
                  workspaceId: input.workspaceId,
                  agentId: input.agentId,
                  newWorktree: input.newWorktree,
                })
              }
            />
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heading: { fontSize: 18, fontWeight: "700", marginBottom: 10 },
  formContainer: { padding: 4 },
  tabRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  tab: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  tabActive: { backgroundColor: "rgba(90,140,255,0.2)" },
  tabText: { fontSize: 13 },
  tabTextActive: { fontWeight: "700" },
  spacer: { flex: 1 },
  smallButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.2)",
  },
  primarySmallButton: { backgroundColor: "rgba(90,140,255,0.9)" },
  primarySmallButtonText: { color: "white", fontWeight: "600" },
  smallButtonText: { fontSize: 12 },
  list: { gap: 10, paddingBottom: 24 },
  card: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.3)",
    padding: 12,
    gap: 6,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  star: { padding: 2 },
  starText: { fontSize: 16 },
  cardTitle: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
  badge: {
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "rgba(128,128,128,0.2)",
    overflow: "hidden",
  },
  badgeError: { backgroundColor: "rgba(220,80,80,0.25)" },
  cardTemplate: { fontSize: 12, opacity: 0.75, fontFamily: "monospace" },
  cardActions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  actionButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.18)",
  },
  runButton: { backgroundColor: "rgba(90,140,255,0.25)" },
  actionText: { fontSize: 12 },
  runText: { fontWeight: "700" },
  deleteText: { color: "rgb(220,80,80)" },
  useCount: { fontSize: 11, opacity: 0.5, marginLeft: "auto" },
  timestamp: { fontSize: 11, opacity: 0.5 },
  muted: { opacity: 0.6, fontSize: 13 },
  errorText: { color: "rgb(220,80,80)", fontSize: 12 },
});
