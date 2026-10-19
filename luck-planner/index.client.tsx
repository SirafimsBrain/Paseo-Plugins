import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LuckPlannerPanel } from "./client/tree-panel";
import { LuckPlannerSettingsScreen } from "./client/settings-screen";
import {
  DASHBOARD_PROJECT_PARAM,
  DASHBOARD_WORKSPACE_PARAM,
  LUCK_PLANNER_DASHBOARD_SCREEN_ID,
  LuckPlannerDashboardScreen,
} from "./client/dashboard-screen";
import {
  NEW_GOAL_PLACEHOLDER,
  NEW_GOAL_TEXT,
  bugSeverityFromArgs,
  parseLuckBug,
  parseLuckStatus,
  resolveLeaf,
} from "./client/slash";
import { bugReport, goalCreate, nodeSetStatus, treeSearch } from "./shared/rpc";
import {
  LUCK_PLANNER_TIMELINE_KIND,
  LUCK_PLANNER_TIMELINE_VERSION,
  timelineDataSchema,
} from "./shared/timeline";
import { LuckPlannerTimelineRow } from "./client/timeline-row";

/**
 * Client entry (Paseo app runtime).
 *
 * Contributions by stage (PLAN.md):
 * - E2 (done): native workspace panel (tree outline)
 * - E3 (done): Command Center items + slash commands (`/luck-status`,
 *   `/luck-bug`) writing through the plugin RPCs
 * - E4 (done): settings screen
 * - F1 (done): dashboard HTTP server settings (enable switch; the server itself
 *   runs in the daemon, see `server/http-server.ts`)
 * - F2 (done): "Open dashboard" — panel button + ⌘K item, in-app browser with
 *   an external fallback (`client/open-dashboard.ts`, `client/dashboard-screen.tsx`)
 * - H2 (done): timeline renderer for the daemon-appended rows (goal approved,
 *   leaf done) — registered under the kind/version/schema the server builds
 *   (`shared/timeline.ts`)
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

  // Stage H2: the daemon appends `{ kind, version, data }` rows to an agent's
  // timeline; this registration is the other half of the contract. Kind,
  // version and schema come from the one shared module, so a row can never be
  // built under a `kind` the client does not draw (that mismatch is what
  // renders as "Plugin timeline item unavailable").
  client.addTimelineRenderer({
    kind: LUCK_PLANNER_TIMELINE_KIND,
    version: LUCK_PLANNER_TIMELINE_VERSION,
    schema: timelineDataSchema,
    Component: LuckPlannerTimelineRow,
  });

  // Stage F2: the ⌘K "Open dashboard" item opens this screen, which performs
  // the actual browser opening on mount (a Command Center callback gets no
  // `navigation`, only surfaces/panels/screens do).
  client.addScreen({
    id: LUCK_PLANNER_DASHBOARD_SCREEN_ID,
    title: "Luck Planner dashboard",
    Component: LuckPlannerDashboardScreen,
  });

  // -------------------------------------------------------------------------
  // Command Center (⌘K), stage E3; the dashboard item is stage F2.
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

  // Stage F2. The item opens the dashboard screen rather than the browser: a
  // command callback has no `navigation`, so the screen (which has one) does the
  // opening on mount and shows the address afterwards.
  client.addCommandCenterItem({
    id: "luck-planner-open-dashboard",
    title: "Open luck-planner dashboard",
    icon: "Globe",
    keywords: ["luck", "planner", "dashboard", "tree", "graph", "2d", "3d", "browser"],
    context: "workspace",
    onSelect({ openScreen, workspace }) {
      openScreen({
        screenId: LUCK_PLANNER_DASHBOARD_SCREEN_ID,
        params: {
          [DASHBOARD_PROJECT_PARAM]: workspace.projectRootPath,
          [DASHBOARD_WORKSPACE_PARAM]: workspace.id,
        },
      });
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
