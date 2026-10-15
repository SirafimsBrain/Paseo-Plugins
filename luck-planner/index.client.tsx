import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LuckPlannerPanel } from "./client/tree-panel";

/**
 * Client entry (Paseo app runtime).
 *
 * Stage E2 of PLAN.md: the native workspace panel (tree outline). Later
 * stages add:
 * - E3: Command Center items and slash commands
 * - E4: settings screen
 * - F2: "Open dashboard" action
 */
export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "luck-planner",
    title: "Luck Planner",
    icon: "GitBranch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: LuckPlannerPanel,
  });

  return () => {};
}
