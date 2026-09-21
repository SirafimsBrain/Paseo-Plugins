import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SessionManagerPanel } from "./client/session-manager-panel";
import { SessionManagerSettingsScreen } from "./client/settings-screen";
import { setSessionManagerIntent } from "./client/intent";

const SETTINGS_SCREEN_ID = "session-manager-settings";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "session-manager",
    title: "Agent Sessions",
    icon: "Database",
    context: "workspace",
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
