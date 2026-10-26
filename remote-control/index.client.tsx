import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RemoteControlPanel } from "./client/console-panel";
import { RemoteControlScreen, SCREEN_ID } from "./client/console-screen";
import { consoleUrl } from "./shared/rpc";

export default function contribute(client: PluginClientContext): () => void {
  // Right sidebar (workspace) panel: status + Open console in an in-app tab.
  client.addWorkspacePanel({
    id: "remote-control",
    title: "Remote Control",
    icon: "Terminal",
    locations: ["workspace", "explorer"],
    Component: RemoteControlPanel,
  } as any);

  // Global entry points: a screen (for in-app browser opening via navigation)
  // and a command-center item.
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
