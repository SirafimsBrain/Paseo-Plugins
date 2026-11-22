import { useCallback, useEffect, useState } from "react";
import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import type { HistoryEntry } from "../shared/commands";
import { listHistory } from "../shared/commands";
import { eventsStream, type CommandEvent } from "../shared/events";

/**
 * Workspace row badge (0.14.4, `addWorkspaceRowBadgeItem`).
 *
 * On the sidebar's workspace rows it answers one question — "has Command Center done
 * anything in this workspace, and did it work?" — from the history the plugin already
 * keeps: the latest entry whose target workspace is this one, as a success/danger badge
 * labelled with the command name. A workspace with no runs renders nothing, so the row
 * stays as it was.
 *
 * The badge follows the live feed (`command-center.events`) instead of polling, and
 * reloads once on mount because a badge mounted after the last run never saw an event.
 */

/** Longest command name shown on the row; the full name stays in the accessible label. */
const MAX_LABEL = 18;

export function CommandCenterWorkspaceBadge({
  workspaceId,
}: PluginWorkspaceRowBadgeItemProps) {
  const historyRpc = useRpc(listHistory);
  const [latest, setLatest] = useState<HistoryEntry | null>(null);

  const reload = useCallback(() => {
    historyRpc({})
      .then((result) => {
        const entry =
          result.entries.find((candidate) => candidate.targetWorkspaceId === workspaceId) ?? null;
        setLatest(entry);
      })
      .catch(() => setLatest(null));
  }, [historyRpc, workspaceId]);

  useEffect(reload, [reload]);

  const onEvent = useCallback(
    (payload: { event: CommandEvent | null }) => {
      if (payload.event && payload.event.kind !== "provisioning") reload();
    },
    [reload],
  );
  useSubscription(eventsStream, {}, onEvent);

  if (!latest) return null;

  const name =
    latest.commandName.length > MAX_LABEL
      ? `${latest.commandName.slice(0, MAX_LABEL - 1)}…`
      : latest.commandName;

  return (
    <WorkspaceRowBadge
      icon={latest.ok ? "CircleCheck" : "CircleAlert"}
      label={name}
      tone={latest.ok ? "success" : "danger"}
      accessibilityLabel={
        latest.ok
          ? `Last Command Center run “${latest.commandName}” succeeded`
          : `Last Command Center run “${latest.commandName}” failed`
      }
    />
  );
}
