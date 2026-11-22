import { useState } from "react";
import { useSubscription } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { statusStream, type VaultStatus } from "../shared/contracts";

/**
 * One item on a workspace row's meta line (0.22.18).
 *
 * The badge speaks only when there is something to say: an index error or a
 * running scan. A healthy, idle vault renders nothing, so the row stays quiet.
 * The live `status-stream` subscription from 0.9.11 supplies the state; an
 * older host simply leaves the badge empty.
 */
export function ObsidianWorkspaceBadge() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  useSubscription(statusStream, {}, (event) => setStatus(event.status));

  if (!status?.configured) return null;
  if (status.error) {
    return <WorkspaceRowBadge label="Obsidian error" tone="danger" />;
  }
  if (status.indexRunning) {
    return <WorkspaceRowBadge label="Indexing" tone="warning" />;
  }
  return null;
}
