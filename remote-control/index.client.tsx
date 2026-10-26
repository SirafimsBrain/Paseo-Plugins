import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RemoteControlPanel } from "./client/console-panel";
import { RemoteControlSettingsPanel } from "./client/console-settings-panel";
import { RemoteControlScreen, SCREEN_ID } from "./client/console-screen";
import { consoleUrl } from "./shared/rpc";

export default function contribute(client: PluginClientContext): () => void {
  // Right sidebar (explorer location): live params + open console.
  client.addWorkspacePanel({
    id: "remote-control",
    title: "Remote Control",
    icon: "Terminal",
    locations: ["explorer"],
    Component: RemoteControlPanel,
  } as any);

  // Workspace tab (workspace location): settings & configuration.
  client.addWorkspacePanel({
    id: "remote-control-settings",
    title: "Remote Control Settings",
    icon: "Settings",
    locations: ["workspace"],
    Component: RemoteControlSettingsPanel,
  } as any);

  // Global entry points.
  client.addScreen({
    id: SCREEN_ID,
    title: "Remote Control",
    Component: RemoteControlScreen,
  });

  client.addCommandCenterItem({
    id: "remote-control-open-console",
    title: "Open remote-control console",
    icon: "Globe",
    keywords: ["remote", "control", "console", "terminal", "ssh", "rdp", "vnc"],
    context: "global",
    async onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  return () => {};
}
