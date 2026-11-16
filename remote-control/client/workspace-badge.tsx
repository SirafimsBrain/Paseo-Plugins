import { useEffect, useState } from "react";
import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useRemoteActivity } from "./use-activity";
import { workspaceActivity } from "../shared/rpc";

/**
 * Sidebar workspace badge (stage 1.1.0, Paseo 0.16.0
 * `addWorkspaceRowBadgeItem`).
 *
 * Shows `N remote` on a workspace row while that workspace has live remote
 * sessions — ssh terminals this plugin opened plus RDP/VNC windows the console
 * launched from it. The count comes from `remote-control.workspace.activity`;
 * the activity snapshot is only the trigger, so the badge never polls.
 *
 * A workspace with nothing remote renders nothing, which keeps the row's meta
 * line as it was.
 */
export function RemoteControlWorkspaceBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const activityRpc = useRpc(workspaceActivity);
  const activity = useRemoteActivity();
  const [count, setCount] = useState(0);
  const [connectionName, setConnectionName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    activityRpc({ workspaceId })
      .then((result) => {
        if (cancelled) return;
        setCount(result.sessions);
        setConnectionName(result.connectionName);
      })
      .catch(() => {
        // The daemon may be reconnecting; the next activity push retries.
      });
    return () => {
      cancelled = true;
    };
  }, [activityRpc, workspaceId, activity?.at]);

  if (count === 0) return null;
  return (
    <WorkspaceRowBadge
      icon="Terminal"
      label={`${count} remote`}
      tone="info"
      accessibilityLabel={
        connectionName ? `${count} remote sessions, newest ${connectionName}` : `${count} remote sessions`
      }
    />
  );
}
