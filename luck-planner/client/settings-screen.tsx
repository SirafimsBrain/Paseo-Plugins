import { Pressable, StyleSheet, Text, View } from "react-native";
import { useCallback, useEffect, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { scaledFont } from "./host-font-scale";
import { useHostFontScale } from "./use-host-typography";
import {
  DEFAULT_HTTP_PORT,
  generateAccessToken,
  luckPlannerSettings,
} from "../shared/settings";
import {
  agentMcpRegister,
  agentMcpStatus,
  agentMcpUnregister,
  type AgentMcpTargetId,
} from "../shared/rpc";

/**
 * Plugin settings screen (Paseo Settings → Plugins → Luck Planner,
 * PLAN.md stages E4 + F1 + D4). Edits the six host-scoped settings registered by
 * the server: MCP injection, reported server name, whether the dashboard HTTP
 * server runs, its port (0 = auto), its access token (regenerate), and
 * audit-history retention (0 = keep forever). Every save goes through
 * `settings.save` — the host persists the doc, so values survive daemon
 * restarts, and the server re-reads them live (`agent.create` per creation,
 * retention and the dashboard endpoint on `subscribe`), so no daemon restart
 * is needed — a plugin reload suffices.
 *
 * **Stage D4** adds the agent config files: the plugin can register its MCP
 * server in the agents' *own* config files (OpenCode, Kilo, Cline, Cursor,
 * Codex CLI) — the only registration that survives OpenCode's per-directory
 * eviction and the only one the terminal agents read at all. Those files
 * belong to the user and change the behaviour of every session of that agent
 * on the machine, so the plugin never writes them by itself: each target has
 * its own button here, and one pair of buttons for all of them.
 */
export function LuckPlannerSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(luckPlannerSettings);
  const fontScale = useHostFontScale();
  const font = (base: number) => scaledFont(base, fontScale);
  const fg = theme.colors.foreground;
  const danger = theme.colors.statusDanger;
  const accent = theme.colors.accent;
  // The host's compact layout is true on phones and narrow windows: the
  // spacing follows it, the host's own `SettingsCard`/`SettingsSection`
  // components adapt the rest.
  const compact = layout.compact;
  const containerStyle = {
    padding: compact ? 8 : 12,
    gap: compact ? 6 : 8,
  };

  const agentStatusRpc = useRpc(agentMcpStatus);
  const agentRegisterRpc = useRpc(agentMcpRegister);
  const agentUnregisterRpc = useRpc(agentMcpUnregister);
  const [agentRows, setAgentRows] = useState<AgentRow[]>([]);
  const [agentMessage, setAgentMessage] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);

  const refreshAgentRows = useCallback(() => {
    void agentStatusRpc({})
      .then((result) => {
        setAgentRows(
          result.targets.map((row: any) => ({
            id: row.id,
            label: row.label,
            path: row.path,
            detected: row.detected,
            installed: row.installed,
            upToDate: row.upToDate,
          })),
        );
      })
      .catch((cause: unknown) => {
        setAgentMessage(cause instanceof Error ? cause.message : String(cause));
      });
  }, [agentStatusRpc]);

  useEffect(() => {
    refreshAgentRows();
  }, [refreshAgentRows]);

  /** Registers or removes the entry, then re-reads the state. */
  const runAgentAction = useCallback(
    (target: AgentMcpTargetId | "all", action: "register" | "unregister") => {
      setAgentBusy(true);
      const call = action === "register" ? agentRegisterRpc : agentUnregisterRpc;
      void call({ target })
        .then((result) => {
          const failed = result.results.filter((row: any) => !row.ok);
          setAgentMessage(
            failed.length === 0
              ? action === "register"
                ? "Registered in the agent config file(s)."
                : "Removed from the agent config file(s)."
              : failed.map((row: any) => `${row.label}: ${row.error}`).join("; "),
          );
        })
        .catch((cause: unknown) => {
          setAgentMessage(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          setAgentBusy(false);
          refreshAgentRows();
        });
    },
    [agentRegisterRpc, agentUnregisterRpc, refreshAgentRows],
  );

  if (settings.status === "loading") {
    return (
      <View style={[styles.container, containerStyle]}>
        <Text style={{ color: fg, fontSize: font(13) }}>Loading settings…</Text>
      </View>
    );
  }
  if (settings.status !== "ready") {
    return (
      <View style={[styles.container, containerStyle]}>
        <Text style={{ color: danger, fontSize: font(12) }}>
          Settings are invalid: {settings.error}
        </Text>
        <Pressable onPress={() => void settings.reset()} style={styles.resetButton}>
          <Text style={{ color: accent, fontSize: font(12), textDecorationLine: "underline" }}>
            Reset to defaults
          </Text>
        </Pressable>
      </View>
    );
  }

  const values = settings.values;
  const patch = (partial: Partial<typeof values>) => {
    void settings.save({ ...values, ...partial }, settings.revision);
  };

  return (
    <View style={[styles.container, containerStyle]}>
      {settings.saveError ? (
        <Text style={{ color: danger, fontSize: font(12), marginBottom: 4 }}>
          {settings.saveError}
        </Text>
      ) : null}
      <SettingsCard>
        <SettingsSection title="Agents">
          <SettingsSwitch
            label="Inject MCP server into agents"
            hint="Adds luck-planner to every agent created through Paseo. Applies to the next agent; no daemon restart needed."
            value={values.injectIntoAgents}
            onValueChange={(enabled: boolean) => patch({ injectIntoAgents: enabled })}
          />
          <SettingsInput
            label="Reported server name"
            hint="Name the injected server reports in MCP initialize. The config key (and tool prefixes) stay luck-planner."
            initialValue={values.mcpServerName}
            onChangeText={(text: string) => patch({ mcpServerName: text })}
          />
        </SettingsSection>
        <SettingsSection title="Dashboard HTTP (stage F1)">
          <SettingsSwitch
            label="Serve the dashboard HTTP endpoint"
            hint="Read-only dashboard API + web app on 127.0.0.1 (loopback only), protected by the access token below. Applies without a daemon restart."
            value={values.httpEnabled}
            onValueChange={(enabled: boolean) => patch({ httpEnabled: enabled })}
          />
          <SettingsInput
            label="Port"
            hint={`1–65535, or 0 for auto (ephemeral). Default ${DEFAULT_HTTP_PORT}.`}
            initialValue={String(values.httpPort)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text.trim(), 10);
              if (
                Number.isInteger(parsed) &&
                parsed >= 0 &&
                parsed <= 65535 &&
                String(parsed) === text.trim()
              ) {
                patch({ httpPort: parsed });
              }
            }}
          />
          <SettingsRow
            label="Access token"
            hint="Sent by every dashboard request (query ?token=). Empty = a random per-session token."
          >
            <Text
              selectable
              style={{ color: fg, fontSize: font(12) }}
              numberOfLines={2}
            >
              {values.accessToken || "(auto — random each plugin load)"}
            </Text>
          </SettingsRow>
          <SettingsAction
            label="Token"
            actionLabel={values.accessToken ? "Regenerate" : "Generate"}
            hint="Replaces the token — previously opened dashboard tabs stop working."
            onPress={() => patch({ accessToken: generateAccessToken() })}
          />
        </SettingsSection>
        <SettingsSection title="Agent config files (stage D4)">
          <SettingsRow
            label="Register the MCP server in the agents' own config files"
            hint="OpenCode and Kilo keep the session entry in memory and drop it when an idle directory is evicted; Cline, Cursor, Qwen Code and Codex CLI ignore session-delivered MCP servers altogether. A config-file entry survives both. Your files are only touched when you press a button — every other key, server and comment is preserved."
          >
            <Text style={{ color: fg, fontSize: font(11) }}>
              {agentMessage !== "" ? agentMessage : " "}
            </Text>
          </SettingsRow>
          {agentRows.map((row) => (
            <SettingsRow
              key={row.id}
              label={row.label}
              hint={agentRowHint(row)}
            >
              <View style={styles.agentRowActions}>
                <Pressable
                  onPress={() => runAgentAction(row.id, "register")}
                  disabled={agentBusy}
                  style={styles.agentButton}
                >
                  <Text style={{ color: accent, fontSize: font(12) }}>
                    {row.installed && row.upToDate === true ? "Re-register" : "Register"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => runAgentAction(row.id, "unregister")}
                  disabled={agentBusy || !row.installed}
                  style={styles.agentButton}
                >
                  <Text
                    style={{
                      color: row.installed ? danger : fg,
                      fontSize: font(12),
                    }}
                  >
                    Remove
                  </Text>
                </Pressable>
              </View>
            </SettingsRow>
          ))}
          <SettingsAction
            label="All agents"
            actionLabel="Register in all"
            hint="Adds the entry to every agent config file found on this machine. A file that cannot be parsed is reported, never overwritten."
            onPress={() => runAgentAction("all", "register")}
            disabled={agentBusy}
          />
          <SettingsAction
            label="All agents"
            actionLabel="Remove from all"
            hint="Removes the entry again; the rest of every file stays untouched."
            onPress={() => runAgentAction("all", "unregister")}
            disabled={agentBusy}
          />
        </SettingsSection>
        <SettingsSection title="History">
          <SettingsInput
            label="History retention (days)"
            hint="Audit rows older than this are pruned at plugin load and on every settings change. 0 = keep forever."
            initialValue={String(values.historyRetentionDays)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text.trim(), 10);
              if (
                Number.isInteger(parsed) &&
                parsed >= 0 &&
                parsed <= 3650 &&
                String(parsed) === text.trim()
              ) {
                patch({ historyRetentionDays: parsed });
              }
            }}
          />
        </SettingsSection>
      </SettingsCard>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  resetButton: { marginTop: 6, alignSelf: "flex-start" },
  agentRowActions: { flexDirection: "row", gap: 12, alignItems: "center" },
  agentButton: { paddingVertical: 2 },
});

/** One agent's registration state, as the section shows it. */
interface AgentRow {
  readonly id: AgentMcpTargetId;
  readonly label: string;
  readonly path: string;
  readonly detected: boolean;
  readonly installed: boolean;
  readonly upToDate: boolean | null;
}

/** The one line that says what state the registration is in. */
function agentRowHint(row: AgentRow): string {
  if (!row.detected) return `${row.path} — not found on this machine`;
  if (!row.installed) return `${row.path} — not registered`;
  if (row.upToDate === true) return `${row.path} — registered`;
  return `${row.path} — registered with an older command; re-register to refresh it`;
}
