import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RemoteControlPanel } from "./client/console-panel";
import { consoleUrl } from "./shared/rpc";

export default function contribute(client: PluginClientContext): () => void {
  client.addWorkspacePanel({
    id: "remote-control",
    title: "Remote Control",
    icon: "Terminal",
    locations: ["workspace", "explorer"],
    Component: RemoteControlPanel,
  } as any);

  client.addCommandCenterItem({
    id: "remote-control-open-console",
    title: "Open remote-control console",
    icon: "Globe",
    keywords: ["remote", "control", "console", "terminal"],
    context: "workspace",
    async onSelect({ rpc }) {
      await rpc(consoleUrl, {});
    },
  });

  return () => {};
}
