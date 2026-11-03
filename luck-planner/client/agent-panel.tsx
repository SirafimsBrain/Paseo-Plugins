import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { agentActivity } from "../shared/rpc";
import type { HistoryEntry, Node } from "../shared/tree";
import { formatTimelineTime } from "../shared/timeline";
import { scaledFont } from "./host-font-scale";
import { useHostFontScale } from "./use-host-typography";

/**
 * Agent-scoped panel: what *this* agent did to the project tree (0.40.8,
 * `__doc.md` §10.11 item 4).
 *
 * The workspace panel answers "what is the state of the tree"; this one
 * answers the question an operator asks while looking at one agent — which
 * leaves did it write, which incident did it report, what did it approve.
 * The answer is not new data: every mutation already writes an audit row that
 * names its actor, so the panel is one `luck-planner.agent-activity` read over
 * the same `history` table the change feed polls, resolved to node names on
 * the server.
 *
 * Reached through the Command Center item "Open this agent's luck-planner
 * activity"; an agent panel receives the id as `params.agentId`, so the
 * component never touches the deprecated `agentId` prop of the same props
 * object.
 *
 * Cross-platform rules apply verbatim: React Native primitives, colors from
 * `theme.colors`, padding and typography from `layout.compact`, no DOM, and
 * no dependency on the panel being the active tab.
 */

/** Human wording for one audit action — the only place these labels live. */
const ACTION_LABELS: Record<HistoryEntry["action"], string> = {
  create: "created",
  update: "edited",
  status: "moved",
  link: "linked",
  unlink: "unlinked",
  approve: "approved",
  reject: "rejected",
  materialize: "materialized",
  supersede: "superseded",
  archive: "archived",
  restore: "restored",
};

interface ActivityRow {
  entry: HistoryEntry;
  node: Node | null;
}

export function LuckPlannerAgentPanel(props: PluginAgentPanelProps) {
  const { theme, layout, workspaceId } = props;
  const fontScale = useHostFontScale();
  const font = (base: number) => scaledFont(base, fontScale);
  const compact = layout.compact;

  const agentId = props.params?.agentId ?? "";
  const projectRootPath = useWorkspace(workspaceId, (workspace) => workspace.projectRootPath);
  const activityRpc = useRpc(agentActivity);

  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectRootPath || !agentId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await activityRpc({ projectKey: projectRootPath, agentId });
      setRows(result.entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectRootPath, agentId, activityRpc]);

  // Reload on mount, when the panel's host hands a new revision, and after an
  // explicit refresh. No polling: an agent panel is read while the operator
  // looks at the agent, and the Refresh button is one press away.
  useEffect(() => {
    void load();
  }, [load, props.revision]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          padding: compact ? 12 : 20,
          gap: compact ? 8 : 12,
          backgroundColor: theme.colors.surface0,
        },
        header: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        },
        title: {
          color: theme.colors.foreground,
          fontSize: font(compact ? 16 : 18),
          fontWeight: "600",
        },
        meta: {
          color: theme.colors.foregroundMuted,
          fontSize: font(12),
        },
        refresh: {
          paddingVertical: compact ? 6 : 8,
          paddingHorizontal: compact ? 10 : 12,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
        },
        refreshText: {
          color: theme.colors.foreground,
          fontSize: font(13),
        },
        list: {
          flex: 1,
        },
        listContent: {
          gap: compact ? 6 : 8,
          paddingBottom: 8,
        },
        row: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingVertical: compact ? 8 : 10,
          paddingHorizontal: compact ? 10 : 12,
          gap: 2,
        },
        rowTitle: {
          color: theme.colors.foreground,
          fontSize: font(14),
          fontWeight: "600",
        },
        rowMeta: {
          color: theme.colors.foregroundMuted,
          fontSize: font(12),
        },
        empty: {
          color: theme.colors.foregroundMuted,
          fontSize: font(14),
          lineHeight: font(20),
        },
        error: {
          color: theme.colors.statusDanger,
          fontSize: font(13),
        },
      }),
    [theme, compact, fontScale],
  );

  const emptyText = !agentId
    ? "This panel needs an agent: open it from an agent's Command Center."
    : rows.length === 0 && !loading
      ? "This agent has not written anything to the tree yet."
      : null;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title}>Tree activity</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {projectRootPath === null || projectRootPath === undefined
              ? "Resolving the workspace project…"
              : `${rows.length} audit row${rows.length === 1 ? "" : "s"} · ${projectRootPath}`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh this agent's tree activity"
          onPress={() => void load()}
          style={styles.refresh}
        >
          <Text style={styles.refreshText}>{loading ? "Loading…" : "Refresh"}</Text>
        </Pressable>
      </View>

      {error === null ? null : <Text style={styles.error}>{error}</Text>}

      {emptyText === null ? null : <Text style={styles.empty}>{emptyText}</Text>}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {rows.map((row) => {
          const name =
            row.node?.name ??
            `${row.entry.entityType} ${row.entry.entityId.slice(0, 8)}`;
          const label = ACTION_LABELS[row.entry.action] ?? row.entry.action;
          const status = row.node === null ? "" : ` · ${row.node.kind}/${row.node.status}`;
          return (
            <View
              key={`${row.entry.id}`}
              style={styles.row}
              accessibilityLabel={`${label} ${name}, ${formatTimelineTime(row.entry.at)}`}
            >
              <Text style={styles.rowTitle} numberOfLines={1}>
                {label} {name}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {`${formatTimelineTime(row.entry.at)} · revision ${row.entry.revision}${status}`}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
