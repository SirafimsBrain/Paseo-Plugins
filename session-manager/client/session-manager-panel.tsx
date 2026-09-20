import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { listSessions, deleteSession } from "../shared/session-manager";

function ageLabel(iso: string): string {
  if (!iso) return "?";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

export function SessionManagerPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const listRpc = useRpc(listSessions);
  const deleteRpc = useRpc(deleteSession);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [onlyClosed, setOnlyClosed] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["session-manager", "sessions"],
    queryFn: () => listRpc({}),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRpc({ id }),
    onSuccess: (result) => {
      if (result.deleted) {
        toast.show("Session deleted", { variant: "success" });
      } else {
        toast.show("Session not found", { variant: "warning" });
      }
      queryClient.invalidateQueries({ queryKey: ["session-manager", "sessions"] });
    },
    onError: (error) => {
      toast.show(error instanceof Error ? error.message : "Failed to delete", {
        variant: "error",
      });
    },
    onSettled: () => {
      setBusyId(null);
      setConfirmId(null);
    },
  });

  const rows = useMemo(() => {
    const all = data?.sessions ?? [];
    const filtered = onlyClosed ? all.filter((s) => s.closed) : all;
    return [...filtered].sort(
      (a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime(),
    );
  }, [data, onlyClosed]);

  function handleDelete(id: string) {
    setBusyId(id);
    deleteMutation.mutate(id);
  }

  const styles = {
    root: {
      flex: 1,
      padding: layout.compact ? 16 : 24,
      backgroundColor: theme.colors.surface0,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      marginBottom: 12,
    },
    headerText: { color: theme.colors.foreground },
    count: { color: theme.colors.foregroundMuted },
    row: {
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginBottom: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    title: { color: theme.colors.foreground, fontWeight: "600" as const },
    meta: { color: theme.colors.foregroundMuted, marginTop: 2 },
    actions: { flexDirection: "row" as const, gap: 8, marginTop: 8 },
    danger: { color: theme.colors.statusDanger, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted },
  };

  if (isLoading) {
    return (
      <View style={styles.root}>
        <Text style={styles.muted}>Loading sessions...</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Switch value={onlyClosed} onValueChange={setOnlyClosed} />
        <Text style={styles.headerText}>Closed only</Text>
        <Text style={styles.count}>({rows.length})</Text>
      </View>

      <ScrollView>
        {rows.map((session) => (
          <View key={session.id} style={styles.row}>
            <Text style={styles.title}>{session.name ?? session.id}</Text>
            <Text style={styles.meta}>
              {session.agentCommand.split(" ")[0]}
              {" · "}
              {session.closed ? "closed" : "open"}
              {" · "}
              {ageLabel(session.lastUsedAt)} ago
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {session.cwd}
            </Text>

            {confirmId === session.id ? (
              <View style={styles.actions}>
                <Pressable
                  disabled={busyId === session.id}
                  onPress={() => handleDelete(session.id)}
                >
                  <Text style={styles.danger}>Yes, delete</Text>
                </Pressable>
                <Pressable onPress={() => setConfirmId(null)}>
                  <Text style={styles.muted}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.actions}>
                <Pressable
                  disabled={busyId === session.id}
                  onPress={() => setConfirmId(session.id)}
                >
                  <Text style={styles.danger}>Delete...</Text>
                </Pressable>
              </View>
            )}
          </View>
        ))}

        {rows.length === 0 && (
          <Text style={styles.muted}>No sessions match the current filter.</Text>
        )}
      </ScrollView>
    </View>
  );
}
