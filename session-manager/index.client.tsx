import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SessionManagerPanel } from "./client/session-manager-panel";
import { SessionManagerSettingsScreen } from "./client/settings-screen";
import { setSessionManagerIntent } from "./client/intent";
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
  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Agent session cleanup",
    icon: "Database",
    Component: SessionManagerSettingsScreen,
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
