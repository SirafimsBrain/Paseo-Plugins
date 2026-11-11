import type { ActiveTurnBehavior } from "./commands";

/** One run target: a workspace on a host, plus per-run overrides. */
export interface BatchTarget {
  /** JSON key from `workspaceKey()`; null means "let the server pick". */
  workspaceKey: string | null;
  /**
   * Host that owns an agent target (0.9.0). The workspace key normally carries
   * the host, but an agent can be selected without a matching workspace in the
   * loaded list — without this field such a target would be dispatched to the
   * local daemon instead of its own host.
   */
  serverId?: string;
  agentId?: string;
  provider?: string;
  newWorktree: boolean;
  /**
   * Turn-aware dispatch (0.6.0), only for targets with an existing `agentId`:
   * `interrupt` stops the running turn (the daemon default when omitted),
   * `steer` delivers the prompt into the running turn.
   */
  activeTurnBehavior?: ActiveTurnBehavior;
}

/** A selected existing agent and the workspace key it lives in (when known). */
export interface AgentTargetRef {
  id: string;
  serverId: string;
  workspaceKey: string | null;
}

/**
 * Per-agent fan-out (0.9.0): builds the target list from the selected
 * workspaces and the selected existing agents.
 *
 * - A selected agent implies its workspace, so that workspace is not started
 *   again with a new agent (the agent target wins).
 * - Agents whose workspace is not in the loaded list still produce a target:
 *   `serverId` routes it to the right host even when `workspaceKey` is null.
 * - Nothing selected keeps the legacy single best-guess target, so a run is
 *   never a no-op.
 * - Workflows force `newWorktree` off for the new-agent targets exactly like
 *   the run dialog does; agent targets never branch off.
 *
 * Pure and client-safe so the dialog and the tests share one definition.
 */
export function planTargets(input: {
  selectedWorkspaceKeys: string[];
  selectedAgents: AgentTargetRef[];
  provider?: string;
  newWorktree: boolean;
  workflow: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
}): BatchTarget[] {
  const covered = new Set(
    input.selectedAgents
      .map((agent) => agent.workspaceKey)
      .filter((key): key is string => key !== null),
  );
  const newAgentKeys = input.selectedWorkspaceKeys.filter((key) => !covered.has(key));
  const targets: BatchTarget[] = [
    ...newAgentKeys.map((workspaceKey) => ({
      workspaceKey,
      provider: input.provider,
      newWorktree: input.workflow ? false : input.newWorktree,
    })),
    ...input.selectedAgents.map((agent) => ({
      workspaceKey: agent.workspaceKey,
      serverId: agent.serverId,
      agentId: agent.id,
      provider: input.provider,
      newWorktree: false,
      activeTurnBehavior: input.activeTurnBehavior,
    })),
  ];
  if (targets.length === 0) {
    targets.push({
      workspaceKey: null,
      provider: input.provider,
      newWorktree: input.workflow ? false : input.newWorktree,
    });
  }
  return targets;
}
