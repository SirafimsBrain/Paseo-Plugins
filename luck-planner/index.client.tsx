import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LuckPlannerPanel } from "./client/tree-panel";
import { LuckPlannerSettingsScreen } from "./client/settings-screen";
import {
  NEW_GOAL_PLACEHOLDER,
  NEW_GOAL_TEXT,
  bugSeverityFromArgs,
  parseLuckBug,
  parseLuckStatus,
  resolveLeaf,
} from "./client/slash";
import { bugReport, goalCreate, nodeSetStatus, treeSearch } from "./shared/rpc";

/**
 * Client entry (Paseo app runtime).
 *
 * Contributions by stage (PLAN.md):
 * - E2 (done): native workspace panel (tree outline)
 * - E3 (done): Command Center items + slash commands (`/luck-status`,
 *   `/luck-bug`) writing through the plugin RPCs
 * - E4 (done): settings screen (five host-scoped settings)
 * - F2: "Open dashboard" action
 */

const PANEL_ID = "luck-planner";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Luck Planner",
    icon: "GitBranch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: LuckPlannerPanel,
  });

  client.addSettingsScreen({
    id: "luck-planner-settings",
    title: "Luck Planner",
    icon: "GitBranch",
    Component: LuckPlannerSettingsScreen,
  });

  // -------------------------------------------------------------------------
  // Command Center (⌘K), stage E3
  // -------------------------------------------------------------------------

  client.addCommandCenterItem({
    id: "luck-planner-open-tree",
    title: "Open luck-planner tree",
    icon: "GitBranch",
    keywords: ["luck", "planner", "tree", "plan", "project", "goal"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(PANEL_ID);
    },
  });

  client.addCommandCenterItem({
    id: "luck-planner-new-goal",
    title: "New high goal",
    icon: "Target",
    keywords: ["luck", "planner", "goal", "plan", "task", "high"],
    context: "workspace",
    async onSelect({ rpc, workspace, openPanel }) {
      // The SDK has no dialog API: seed a draft goal with placeholder text
      // that the user refines with an agent (`luck_tree_set_goal`) — the
      // goal stays out of the tree until approved (ADR-7).
      const result = await rpc(goalCreate, {
        projectKey: workspace.projectRootPath,
        formalText: NEW_GOAL_TEXT,
        plan: NEW_GOAL_PLACEHOLDER,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to create the draft goal");
      }
      openPanel(PANEL_ID);
    },
  });

  // -------------------------------------------------------------------------
  // Slash commands (composer), stage E3. Errors surface as thrown readable
  // messages — the host reports a failed onSubmit; successes open the panel
  // where the change is visible in the audit trail.
  // -------------------------------------------------------------------------

  client.addSlashCommand({
    name: "luck-status",
    description: "Move a luck-planner leaf to a status",
    argumentHint: "<leaf name or id> <status>",
    context: "agent",
    async onSubmit({ args, rpc, workspace, openPanel }) {
      const parsed = parseLuckStatus(args);
      if (!parsed.ok) throw new Error(parsed.error);
      const projectKey = workspace.projectRootPath;
      const resolved = await resolveLeaf(
        (input) => rpc(treeSearch, input),
        projectKey,
        parsed.value.leafRef,
      );
      if (!resolved.ok) throw new Error(resolved.error);
      const result = await rpc(nodeSetStatus, {
        projectKey,
        nodeId: resolved.value.nodeId,
        status: parsed.value.status,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "Status change failed");
      }
      openPanel(PANEL_ID);
    },
  });

  client.addSlashCommand({
    name: "luck-bug",
    description: "Report a luck-planner incident (bug)",
    argumentHint: "<title>",
    context: "agent",
    async onSubmit({ args, rpc, workspace, openPanel }) {
      const parsed = parseLuckBug(args);
      if (!parsed.ok) throw new Error(parsed.error);
      const result = await rpc(bugReport, {
        projectKey: workspace.projectRootPath,
        title: parsed.value.title,
        severity: bugSeverityFromArgs(args),
      });
      if (!result.ok) {
        throw new Error(result.error ?? "Bug report failed");
      }
      openPanel(PANEL_ID);
    },
  });

  return () => {};
}
