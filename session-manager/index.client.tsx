import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SessionManagerPanel } from "./client/session-manager-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "session-manager",
    title: "Agent Sessions",
    icon: "Database",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: SessionManagerPanel,
  });
  client.addCommandCenterItem({
    id: "open-session-manager",
    title: "Open agent sessions",
    icon: "Database",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("session-manager");
    },
  });
  return () => {};
}
