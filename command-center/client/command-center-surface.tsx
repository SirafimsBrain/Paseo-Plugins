import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CommandDefinition, HistoryEntry, ProviderWithModels } from "../shared/commands";
import { normalizeProviderModels } from "../shared/commands";
import {
  appendHistory,
  clearHistory,
  deleteCommand,
  listCommands,
  listHistory,
  runBatch,
  runCommand,
  saveCommand,
  toggleFavorite,
} from "../shared/commands";
import { CommandForm, type CommandFormResult } from "./command-form";
import { dispatchRemoteTarget } from "./dispatch";
import { RunDialog, type BatchItemResult, type BatchTarget } from "./run-dialog";

type Tab = "library" | "history";

interface WorkspaceOption {
  id: string;
  name: string;
  serverId: string;
  hostLabel: string;
  directory: string | null;
}

interface AgentOption {
  id: string;
  title: string | null;
  status: string;
  workspaceId: string | null;
  serverId: string;
  hostLabel: string;
}

export function workspaceKey(option: { serverId: string; id: string }): string {
  return JSON.stringify([option.serverId, option.id]);
}

export function splitWorkspaceKey(key: string): { serverId: string; workspaceId: string } {
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { serverId: parsed[0] as string, workspaceId: parsed[1] as string };
    }
  } catch {
    // fall through to plain-id key
  }
  return { serverId: '', workspaceId: key };
}

export function CommandCenterSurface({ theme, host }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const listRpc = useRpc(listCommands);
  const historyRpc = useRpc(listHistory);
  const clearHistoryRpc = useRpc(clearHistory);
  const deleteRpc = useRpc(deleteCommand);
  const favoriteRpc = useRpc(toggleFavorite);
  const saveRpc = useRpc(saveCommand);
  const runBatchRpc = useRpc(runBatch);
  const appendHistoryRpc = useRpc(appendHistory);

  // All configured app hosts (multi-host fan-out). Older hosts may not provide
  // the loader — fall back to single-host mode instead of crashing.
  let hosts: readonly { serverId: string; label: string; status: string }[] = [];
  try {
    hosts = useHosts();
  } catch {
    hosts = [];
  }
  const localServerId = host?.id ?? "";
  // Stable key for the hosts array: the loader may return a fresh array
  // identity every render, which must not retrigger the loaders effect.
  const hostsKey = JSON.stringify(hosts.map((item) => [item.serverId, item.label, item.status]));

  const [tab, setTab] = useState<Tab>("library");
  const [editing, setEditing] = useState<CommandDefinition | null>(null);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<CommandDefinition | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [historyVisible, setHistoryVisible] = useState(false);

  const [commands, setCommands] = useState<CommandDefinition[] | null>(null);
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [providers, setProviders] = useState<ProviderWithModels[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

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

    const apiFor = (serverId: string) =>
      serverId !== "" && serverId === localServerId ? paseo : getPaseoClient(serverId);

    const loadWorkspaces = async () => {
      if (hosts.length === 0) {
        const result = await paseo.workspaces.list().catch(() => null);
        if (cancelled) return;
        setWorkspaces(
          (result?.entries ?? []).map((entry) => {
            const record = entry as {
              id: string;
              projectCustomName?: string | null;
              title?: string | null;
              name: string;
              workspaceDirectory?: string | null;
              directory?: string | null;
              projectRootPath?: string | null;
            };
            const name = record.projectCustomName ?? record.title ?? record.name;
            return {
              id: record.id,
              name: name && name.length > 0 ? name : record.id,
              serverId: localServerId,
              hostLabel: "",
              directory:
                record.workspaceDirectory ?? record.directory ?? record.projectRootPath ?? null,
            };
          }),
        );
        return;
      }
      const all: WorkspaceOption[] = [];
      for (const item of hosts) {
        try {
          const api = apiFor(item.serverId);
          const result = await api.workspaces.list();
          for (const entry of result.entries) {
            const record = entry as {
              id: string;
              projectCustomName?: string | null;
              title?: string | null;
              name: string;
              workspaceDirectory?: string | null;
              directory?: string | null;
              projectRootPath?: string | null;
            };
            const name = record.projectCustomName ?? record.title ?? record.name;
            all.push({
              id: record.id,
              name: name && name.length > 0 ? name : record.id,
              serverId: item.serverId,
              hostLabel: item.label,
              directory:
                record.workspaceDirectory ?? record.directory ?? record.projectRootPath ?? null,
            });
          }
        } catch {
          // Unreachable host — skipped, its workspaces simply cannot be targeted.
        }
      }
      if (!cancelled) setWorkspaces(all);
    };

    const loadAgents = async () => {
      const collect = async (
        serverId: string,
        hostLabel: string,
        list: () => Promise<{ entries: unknown[] }>,
      ): Promise<AgentOption[]> => {
        const result = await list().catch(() => null);
        return (result?.entries ?? [])
          .map((entry) => {
            const record = entry as {
              id?: string;
              title?: string | null;
              status?: string;
              workspaceId?: string | null;
            };
            return {
              id: typeof record.id === "string" ? record.id : "",
              title: typeof record.title === "string" ? record.title : null,
              status: typeof record.status === "string" ? record.status : "unknown",
              workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
              serverId,
              hostLabel,
            };
          })
          .filter((agent) => agent.id !== "");
      };
      if (hosts.length === 0) {
        const entries = await collect(localServerId, "", () =>
          paseo.agents.list({ scope: "active", filter: { includeArchived: false } }),
        );
        if (!cancelled) setAgents(entries);
        return;
      }
      const all: AgentOption[] = [];
      for (const item of hosts) {
        try {
          const api = apiFor(item.serverId);
          const entries = await collect(item.serverId, item.label, () =>
            api.agents.list({ scope: "active", filter: { includeArchived: false } }),
          );
          all.push(...entries);
        } catch {
          // Unreachable host — skipped.
        }
      }
      if (!cancelled) setAgents(all);
    };

    const loadProviders = async () => {
      // Models are resolved here — before the run modal can open — so the
      // provider picker always offers full `provider/model` references.
      // Disabled providers are hidden entirely, not dimmed.
      setModelsLoading(true);
      try {
        const collect = async (
          serverId: string,
          hostLabel: string,
          api: {
            providers: {
              snapshot: () => Promise<{ entries: unknown[] } | null>;
              listModels: (provider: string) => Promise<{ models?: unknown[] } | null>;
            };
          },
        ): Promise<ProviderWithModels[]> => {
          const snapshot = await api.providers.snapshot().catch(() => null);
          const seen = new Map<string, ProviderWithModels>();
          const modelFetches: Promise<void>[] = [];
          for (const entry of snapshot?.entries ?? []) {
            const record = entry as {
              provider?: unknown;
              enabled?: unknown;
              models?: unknown;
            };
            const id = typeof record.provider === "string" ? record.provider : "";
            if (id.length === 0 || record.enabled === false) continue;
            if (seen.has(id)) continue;
            const provider: ProviderWithModels = { id, serverId, hostLabel, models: [] };
            seen.set(id, provider);
            const inline = normalizeProviderModels(record.models, id);
            if (inline) {
              provider.models = inline;
            } else {
              modelFetches.push(
                api.providers
                  .listModels(id)
                  .then((result) => {
                    provider.models = normalizeProviderModels(result?.models, id) ?? [];
                  })
                  .catch(() => {
                    provider.models = [];
                  }),
              );
            }
          }
          await Promise.all(modelFetches);
          return [...seen.values()].filter((provider) => provider.models.length > 0);
        };
        if (hosts.length === 0) {
          const entries = await collect(localServerId, "", paseo);
          if (!cancelled) setProviders(entries);
          return;
        }
        const all: ProviderWithModels[] = [];
        for (const item of hosts) {
          try {
            const api = apiFor(item.serverId);
            const entries = await collect(item.serverId, item.label, api);
            all.push(...entries);
          } catch {
            // Unreachable host — skipped.
          }
        }
        if (!cancelled) setProviders(all);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };

    void loadWorkspaces();
    void loadAgents();
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, [paseo, hostsKey, localServerId, reloadKey]);

  const sorted = useMemo(() => {
    const favoriteFirst = (a: CommandDefinition, b: CommandDefinition) =>
      Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name);
    return [...(commands ?? [])].sort(favoriteFirst);
  }, [commands]);

  const { foreground, foregroundMuted } = theme.colors;

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

  /**
   * Fan-out run. Local targets go through the daemon-side `run-batch` RPC;
   * targets on other hosts are dispatched from the client via their host API
   * (the daemon cannot reach other daemons) and reported back through
   * `history-append`. Returns per-target outcomes in target order.
   */
  const handleRunBatch = async (input: {
    command: CommandDefinition;
    values: Record<string, string>;
    targets: BatchTarget[];
  }): Promise<BatchItemResult[]> => {
    const resolved = input.targets.map((target) => {
      const workspace =
        target.workspaceKey !== null
          ? (workspaces.find((candidate) => workspaceKey(candidate) === target.workspaceKey) ?? null)
          : null;
      const parsed = target.workspaceKey
        ? splitWorkspaceKey(target.workspaceKey)
        : { serverId: localServerId, workspaceId: undefined as string | undefined };
      return { target, workspace, serverId: parsed.serverId, workspaceId: parsed.workspaceId };
    });

    const outcomes: BatchItemResult[] = resolved.map(({ workspace }) => ({
      key: "",
      workspaceName: workspace?.name ?? "Best-guess workspace",
      hostLabel: workspace?.hostLabel ?? "",
      ok: false,
      kind: input.command.type === "shell" ? "terminal" : "new-agent",
      error: null,
    }));
    resolved.forEach(({ target }, index) => {
      outcomes[index]!.key = target.workspaceKey ?? `target:${index}`;
    });

    const isLocalServer = (serverId: string) => serverId === "" || serverId === localServerId;
    const localIndices: number[] = [];
    const remoteIndices: number[] = [];
    resolved.forEach(({ serverId }, index) => {
      (isLocalServer(serverId) ? localIndices : remoteIndices).push(index);
    });

    // 1. Local targets — a single daemon-side batch call.
    if (localIndices.length > 0) {
      try {
        const { results } = await runBatchRpc({
          commandId: input.command.id,
          values: input.values,
          targets: localIndices.map((index) => ({
            workspaceId: resolved[index]!.workspaceId,
            agentId: resolved[index]!.target.agentId,
            provider: resolved[index]!.target.provider,
            newWorktree: resolved[index]!.target.newWorktree,
          })),
        });
        results.forEach((result, position) => {
          const index = localIndices[position];
          if (index === undefined) return;
          outcomes[index] = { ...outcomes[index]!, ok: result.ok, kind: result.kind, error: result.error };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const index of localIndices) {
          outcomes[index] = { ...outcomes[index]!, ok: false, error: message };
        }
      }
    }

    // 2. Remote targets — client-side dispatch per host, history reported back.
    for (const index of remoteIndices) {
      const { target, workspace, serverId, workspaceId } = resolved[index]!;
      try {
        const api = getPaseoClient(serverId);
        const dispatched = await dispatchRemoteTarget(
          api,
          input.command,
          input.values,
          {
            workspaceId,
            agentId: target.agentId,
            provider: target.provider,
            newWorktree: target.newWorktree,
          },
          workspace
            ? { id: workspace.id, name: workspace.name, directory: workspace.directory }
            : null,
        );
        try {
          await appendHistoryRpc({
            entry: {
              commandId: input.command.id,
              commandName: input.command.name,
              rendered: dispatched.rendered.length > 0 ? dispatched.rendered : "(no output)",
              targetWorkspaceId: dispatched.workspaceId,
              targetAgentId: dispatched.agentId,
              kind: dispatched.kind,
              ok: dispatched.ok,
              error: dispatched.error,
            },
          });
        } catch {
          // History is best-effort for remote targets; the run itself succeeded.
        }
        outcomes[index] = {
          ...outcomes[index]!,
          ok: dispatched.ok,
          kind: dispatched.kind,
          error: dispatched.error,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcomes[index] = { ...outcomes[index]!, ok: false, error: message };
      }
    }

    const succeeded = outcomes.filter((outcome) => outcome.ok).length;
    if (succeeded === outcomes.length && outcomes.length > 0) {
      if (input.command.type === "shell") {
        toast.show(
          outcomes.length === 1 ? "Command written to a new terminal" : `Written to terminals on ${outcomes.length} targets`,
          { variant: "success" },
        );
      } else if (outcomes.every((outcome) => outcome.kind === "existing-agent")) {
        toast.show("Prompt sent to the agent", { variant: "success" });
      } else if (outcomes.length === 1) {
        toast.show("Agent created", { variant: "success" });
      } else {
        toast.show(`Agents created on ${outcomes.length} targets`, { variant: "success" });
      }
    } else if (succeeded > 0) {
      toast.show(`Ran on ${succeeded} of ${outcomes.length} targets — see errors in the dialog`);
    }
    refresh();
    return outcomes;
  };

  if (creating || editing) {
    return (
      <ScrollView contentContainerStyle={styles.formContainer}>
        <Text style={[styles.heading, { color: foreground }]}>{editing ? "Edit command" : "New command"}</Text>
        <CommandForm
          initial={editing}
          providers={providers}
          modelsLoading={modelsLoading}
          multiHost={hosts.length > 1}
          theme={theme}
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
            <Text style={[styles.tabText, { color: foreground }, tab === option && styles.tabTextActive]}>
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
          <Text style={[styles.smallButtonText, { color: foreground }]}>
            {tab === "history" ? "Clear" : "History"}
          </Text>
        </Pressable>
        <Pressable style={[styles.smallButton, styles.primarySmallButton]} onPress={() => setCreating(true)}>
          <Text style={[styles.smallButtonText, styles.primarySmallButtonText]}>+ New</Text>
        </Pressable>
      </View>

      {tab === "library" ? (
        <ScrollView contentContainerStyle={styles.list}>
          {commands === null && commandsError === null ? (
            <Text style={[styles.muted, { color: foregroundMuted }]}>Loading…</Text>
          ) : null}
          {commandsError ? <Text style={styles.errorText}>Failed to load commands: {commandsError}</Text> : null}
          {commands !== null && sorted.length === 0 ? (
            <Text style={[styles.muted, { color: foregroundMuted }]}>
              No commands yet. Create one with “+ New” — for example a review prompt or a build shell line.
            </Text>
          ) : null}
          {sorted.map((command) => (
            <View key={command.id} style={[styles.card, { borderColor: theme.colors.border }]}>
              <View style={styles.cardHeader}>
                <Pressable style={styles.star} onPress={() => void handleFavorite(command)}>
                  <Text style={[styles.starText, { color: foreground }]}>
                    {command.favorite ? "★" : "☆"}
                  </Text>
                </Pressable>
                <Text style={[styles.cardTitle, { color: foreground }]} numberOfLines={1}>
                  {command.name}
                </Text>
                <Text style={[styles.badge, { color: foreground }]}>
                  {command.type === "shell" ? "shell" : command.provider ?? "prompt"}
                </Text>
              </View>
              <Text style={[styles.cardTemplate, { color: foregroundMuted }]} numberOfLines={2}>
                {command.template}
              </Text>
              <View style={styles.cardActions}>
                <Pressable
                  style={[styles.actionButton, styles.runButton]}
                  onPress={() => {
                    setRunning(command);
                  }}
                >
                  <Text style={[styles.actionText, styles.runText, { color: foreground }]}>Run</Text>
                </Pressable>
                <Pressable style={styles.actionButton} onPress={() => setEditing(command)}>
                  <Text style={[styles.actionText, { color: foreground }]}>Edit</Text>
                </Pressable>
                <Pressable style={styles.actionButton} onPress={() => void handleDelete(command)}>
                  <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
                </Pressable>
                <Text style={[styles.useCount, { color: foregroundMuted }]}>{command.useCount} runs</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {history === null ? (
            <Text style={[styles.muted, { color: foregroundMuted }]}>Loading…</Text>
          ) : null}
          {history !== null && history.length === 0 ? (
            <Text style={[styles.muted, { color: foregroundMuted }]}>Nothing has run yet.</Text>
          ) : null}
          {(history ?? []).map((entry: HistoryEntry) => (
            <View key={entry.id} style={[styles.card, { borderColor: theme.colors.border }]}>
              <View style={styles.cardHeader}>
                <Text style={[styles.cardTitle, { color: foreground }]} numberOfLines={1}>
                  {entry.commandName}
                </Text>
                <Text style={[styles.badge, { color: foreground }, !entry.ok && styles.badgeError]}>
                  {entry.ok ? entry.kind : "failed"}
                </Text>
              </View>
              <Text style={[styles.cardTemplate, { color: foregroundMuted }]} numberOfLines={3}>
                {entry.rendered}
              </Text>
              <Text style={[styles.timestamp, { color: foregroundMuted }]}>
                {new Date(entry.at).toLocaleString()}
              </Text>
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
              providers={providers}
              modelsLoading={modelsLoading}
              multiHost={hosts.length > 1}
              theme={theme}
              onCancel={() => setRunning(null)}
              onRun={(input) => handleRunBatch({ command: running, values: input.values, targets: input.targets })}
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
