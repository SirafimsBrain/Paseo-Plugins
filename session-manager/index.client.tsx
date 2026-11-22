import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentSessionsPanel } from "./client/agent-sessions-panel";
import { SessionManagerPanel } from "./client/session-manager-panel";
import { parseSessionArgs } from "./client/session-slash";
import { SessionManagerSettingsScreen } from "./client/settings-screen";
import { setSessionManagerIntent } from "./client/intent";
import { SessionManagerSidebarItem } from "./client/sidebar-item";
import { refreshSession } from "./shared/session-manager";

const SETTINGS_SCREEN_ID = "session-manager-settings";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "session-manager",
    title: "Agent Sessions",
    icon: "Database",
    locations: ["workspace", "explorer"],
    Component: SessionManagerPanel,
  });
  // 0.7.0: the same listing, scoped to one agent. `params.agentId` is the only
  // target it can act on, so it cannot delete another agent's transcripts.
  client.addAgentPanel({
    id: "session-manager-agent",
    title: "Agent sessions",
    icon: "Database",
    Component: AgentSessionsPanel,
  });
  // 0.7.0: `/sessions [old [days]] | archived | settings` — the chat-side entry
  // point. It writes the same intent the Command Center items use, so the panel
  // applies the filter with one code path (see `client/session-slash.ts`).
  client.addSlashCommand({
    name: "sessions",
    description: "Open the agent session cleanup panel, filtered",
    argumentHint: "[old [days]] | archived | settings",
    context: "workspace",
    onSubmit({ args, openPanel, openSettings }) {
      const parsed = parseSessionArgs(args);
      if (parsed.openSettings) {
        openSettings(SETTINGS_SCREEN_ID);
        return;
      }
      if (parsed.intent) setSessionManagerIntent(parsed.intent);
      openPanel("session-manager");
    },
  });
  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Agent session cleanup",
    icon: "Database",
    Component: SessionManagerSettingsScreen,
  });
  // 0.5.0 sidebar entry point (§19.3 item 3): a footer status/count row. It
  // opens a summary popover, not the workspace panel: a sidebar item gets
  // `openPopover`/`openScreen` and no `openPanel`, so the panel keeps the
  // destructive flow and the row is the read-only overview.
  client.addSidebarFooterItem({
    id: "session-manager-status",
    title: "Agent sessions",
    Component: SessionManagerSidebarItem,
  });
  client.addCommandCenterItem({
    id: "open-session-manager",
    title: "Open agent sessions",
    icon: "Database",
    keywords: ["session", "delete", "cleanup", "history"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("session-manager");
    },
  });
  client.addCommandCenterItem({
    id: "open-session-manager-old",
    title: "Agent sessions older than 30 days",
    icon: "Database",
    keywords: ["session", "cleanup", "old", "delete"],
    context: "workspace",
    onSelect({ openPanel }) {
      setSessionManagerIntent({ ageDays: 30, selectShown: true });
      openPanel("session-manager");
    },
  });
  client.addCommandCenterItem({
    id: "open-session-manager-archived",
    title: "Clean up archived agent sessions",
    icon: "Database",
    keywords: ["session", "archived", "cleanup", "delete"],
    context: "workspace",
    onSelect({ openPanel }) {
      setSessionManagerIntent({ archivedOnly: true, selectShown: true });
      openPanel("session-manager");
    },
  });
  // Refresh action (0.3.3): reopen the selected agent's provider session so
  // `agent.session_open` runs again, then rescan with a cold listing cache — the
  // supported answer to a stale "still running" flag instead of waiting out the
  // 30-second TTL (§18.3 item 3). A throw is surfaced by the host as an error toast,
  // so a refused reload is never silent.
  client.addCommandCenterItem({
    id: "refresh-session-list",
    title: "Refresh session list (reopen this agent's session)",
    icon: "RefreshCw",
    keywords: ["session", "refresh", "reload", "reopen", "stale", "runtime", "list"],
    context: "agent",
    async onSelect({ agent, rpc, openPanel }) {
      const result = await rpc(refreshSession, { agentId: agent.id });
      if (!result.ok) {
        throw new Error(result.error ?? "Could not reopen the agent session.");
      }
      setSessionManagerIntent({ refresh: true });
      openPanel("session-manager");
    },
  });
  client.addCommandCenterItem({
    id: "open-session-manager-settings",
    title: "Agent session cleanup settings",
    icon: "Database",
    keywords: ["session", "settings", "cleanup", "export"],
    context: "workspace",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_SCREEN_ID);
    },
  });
  return () => {};
}
