import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LuckPlannerAgentPanel } from "./client/agent-panel";
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
import { requestFocus } from "./client/focus";
import {
  agentReload,
  bugReport,
  goalCreate,
  nodeSetStatus,
  treeSearch,
} from "./shared/rpc";
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
 * - 0.40.8: agent-scoped panel showing the audit rows *this* agent wrote
 *   (`client/agent-panel.tsx`, `addAgentPanel` with `params.agentId`)
 */

const PANEL_ID = "luck-planner";
const AGENT_PANEL_ID = "luck-planner-agent-activity";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Luck Planner",
    icon: "GitBranch",
    locations: ["workspace", "explorer"],
    Component: LuckPlannerPanel,
  } as any);

  // 0.40.8 (§10.11 item 4): the same tree data, sliced by actor. An agent
  // panel is opened for one agent and the host hands it `params.agentId`; the
  // component reads the project key from its workspace and asks the server
  // for the agent's audit rows. Registered separately from the workspace
  // panel so it lives where the operator already is — the agent.
  client.addAgentPanel({
    id: AGENT_PANEL_ID,
    title: "Luck Planner activity",
    icon: "History",
    Component: LuckPlannerAgentPanel,
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
      // No focus request: a draft goal is not a node yet — it materializes
      // into the tree only when a human approves it — and the panel renders
      // nodes (see __doc.md §10.9 for the API-grounded limit).
      openPanel(PANEL_ID);
    },
  });

  // "Refresh luck-planner tools on this agent" (0.35.1, §10.8 item 3): the
  // new `agents.ref(id).reload()` reopens the agent's session, rerunning
  // `agent.open.before` so the launch-only MCP server or the native
  // `luck_tree_upsert_leaf` fallback is re-derived — the one-click answer to
  // an agent that lost its tools after an idle runtime release, an OpenCode
  // eviction or a settings change. A refused reload throws into the host's
  // error toast, so a failed repair is never silent.
  // 0.40.8: the agent panel's entry point. An agent-context item opens the
  // panel in the current agent, which is exactly the actor the panel lists.
  client.addCommandCenterItem({
    id: "luck-planner-agent-activity",
    title: "Open this agent's luck-planner activity",
    icon: "History",
    keywords: ["luck", "planner", "agent", "activity", "audit", "tree"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(AGENT_PANEL_ID);
    },
  });

  client.addCommandCenterItem({
    id: "refresh-luck-planner-tools",
    title: "Refresh luck-planner tools on this agent",
    icon: "RefreshCw",
    keywords: ["luck", "planner", "tools", "refresh", "reload", "mcp"],
    context: "agent",
    async onSelect({ agent, rpc }) {
      const result = await rpc(agentReload, { agentId: agent.id });
      if (!result.ok) {
        throw new Error(result.error ?? "The agent session could not be reloaded.");
      }
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
      // Land the panel on the leaf this command just moved (0.35.1, §10.8
      // item 5): `openPanel` carries no params in 0.14.0, so the request
      // travels through the client focus mailbox the panel subscribes to.
      requestFocus(projectKey, resolved.value.nodeId);
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
      // No focus request: `/luck-bug` reports an unattached incident (the
      // command takes a title only), so there is no node to land on — bugs
      // appear in a node's details once an agent attaches them.
      openPanel(PANEL_ID);
    },
  });

  return () => {};
}
