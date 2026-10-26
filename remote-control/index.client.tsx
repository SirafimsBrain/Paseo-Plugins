import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RemoteControlScreen, SCREEN_ID } from "./client/console-screen";
import { RemoteControlSidebarItem } from "./client/console-sidebar-item";
import { consoleUrl } from "./shared/rpc";

export default function contribute(client: PluginClientContext): () => void {
  client.addScreen({
    id: SCREEN_ID,
    title: "Remote Control",
    Component: RemoteControlScreen,
  });

  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Remote Control",
    Component: RemoteControlSidebarItem,
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
