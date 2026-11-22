import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";
import { listCommands, listHistory, runCommand } from "../shared/commands";
import { eventsStream, type CommandEvent } from "../shared/events";
import { scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Command Center panel for one agent (0.14.4).
 *
 * The History tab answers "what ran", but not "what ran *on this agent*, and what else
 * may I run here". This panel is registered with `addAgentPanel`, so the host scopes it
 * to `params.agentId`:
 *
 * - the prompt commands of the library, each running straight into this agent with its
 *   stored provider and template defaults (no dialog: the first input an existing agent
 *   target needs — a workspace — is already implied by the agent);
 * - the last runs whose target was this agent, each repeatable with the values it
 *   recorded.
 *
 * Nothing here can change the target: a panel of agent A never sends to agent B or
 * creates a new agent, which is the opposite guarantee of the run dialog.
 */

/** How many of the agent's runs the panel lists. */
const RECENT_LIMIT = 5;

export function CommandCenterAgentPanel(props: PluginAgentPanelProps) {
  const { theme, params } = props;
  const agentId = params.agentId;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);

  const listRpc = useRpc(listCommands);
  const historyRpc = useRpc(listHistory);
  const runRpc = useRpc(runCommand);

  const [commands, setCommands] = useState<CommandDefinition[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const success = theme.colors.statusSuccess;
  const danger = theme.colors.statusDanger;

  const reload = useCallback(() => {
    listRpc({})
      .then((result) => setCommands(result.commands))
      .catch(() => setCommands([]));
    historyRpc({})
      .then((result) => setHistory(result.entries))
      .catch(() => setHistory([]));
  }, [historyRpc, listRpc]);

  useEffect(reload, [reload]);

  // Live feed: a run anywhere invalidates the list, so the panel follows the same
  // rule as the screen's tabs instead of polling.
  const onEvent = useCallback(
    (payload: { event: CommandEvent | null }) => {
      if (payload.event && payload.event.kind !== "provisioning") reload();
    },
    [reload],
  );
  useSubscription(eventsStream, {}, onEvent);

  const promptCommands = useMemo(
    () => (commands ?? []).filter((command) => command.type === "prompt"),
    [commands],
  );
  const recent = useMemo(
    () =>
      (history ?? [])
        .filter((entry) => entry.targetAgentId === agentId)
        .slice(0, RECENT_LIMIT),
    [agentId, history],
  );

  const run = useCallback(
    async (command: CommandDefinition, values: Record<string, string>) => {
      setBusyId(command.id);
      setMessage(null);
      try {
        const result = await runRpc({ commandId: command.id, values, agentId });
        setMessage(
          result.ok
            ? { ok: true, text: `Sent “${command.name}” to this agent.` }
            : { ok: false, text: result.error ?? `“${command.name}” failed.` },
        );
      } catch (cause) {
        setMessage({
          ok: false,
          text: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusyId(null);
      }
    },
    [agentId, runRpc],
  );

  return (
    <ScrollView style={styles.container}>
      <Text style={{ color: fgMuted, fontSize: font(11) }}>
        Runs target this agent only — its stored provider and workspace are kept.
      </Text>

      {message ? (
        <Text style={{ color: message.ok ? success : danger, fontSize: font(11) }}>
          {message.text}
        </Text>
      ) : null}

      <Text style={{ color: fgMuted, fontSize: font(10), fontWeight: "600" }}>
        Run a command here
      </Text>
      {commands === null ? (
        <Text style={{ color: fgMuted, fontSize: font(11) }}>Loading…</Text>
      ) : null}
      {commands !== null && promptCommands.length === 0 ? (
        <Text style={{ color: fgMuted, fontSize: font(11) }}>
          No prompt commands saved yet — create one in the Command Center screen.
        </Text>
      ) : null}
      {promptCommands.map((command) => (
        <Pressable
          key={command.id}
          disabled={busyId !== null}
          onPress={() => void run(command, {})}
          style={[styles.row, { borderColor: theme.colors.border, opacity: busyId === null ? 1 : 0.6 }]}
        >
          <View style={styles.rowText}>
            <Text style={{ color: fg, fontSize: font(12) }} numberOfLines={1}>
              {command.name}
            </Text>
            {command.category ? (
              <Text style={{ color: fgMuted, fontSize: font(9) }} numberOfLines={1}>
                {command.category}
              </Text>
            ) : null}
          </View>
          <Text style={{ color: accent, fontSize: font(11) }}>
            {busyId === command.id ? "Sending…" : "Run"}
          </Text>
        </Pressable>
      ))}

      <Text style={{ color: fgMuted, fontSize: font(10), fontWeight: "600" }}>
        Recent runs on this agent
      </Text>
      {recent.length === 0 ? (
        <Text style={{ color: fgMuted, fontSize: font(11) }}>
          Nothing has been sent to this agent yet.
        </Text>
      ) : null}
      {recent.map((entry) => {
        const command = (commands ?? []).find((candidate) => candidate.id === entry.commandId);
        return (
          <View key={entry.id} style={[styles.row, { borderColor: theme.colors.border }]}>
            <View style={styles.rowText}>
              <Text
                style={{ color: entry.ok ? fg : danger, fontSize: font(11) }}
                numberOfLines={1}
              >
                {entry.commandName} · {entry.ok ? "ok" : "failed"}
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(9) }} numberOfLines={1}>
                {new Date(entry.at).toLocaleString()}
              </Text>
            </View>
            <Pressable
              disabled={!command || busyId !== null}
              onPress={() => command && void run(command, entry.values ? { ...entry.values } : {})}
              style={{ opacity: command ? 1 : 0.4 }}
            >
              <Text style={{ color: accent, fontSize: font(11) }}>Again</Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  rowText: { flex: 1, gap: 1 },
});
