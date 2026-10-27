import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RemoteControlPanel } from "./client/console-panel";
import { RemoteControlSettingsPanel } from "./client/console-settings-panel";
import { RemoteControlScreen, SCREEN_ID } from "./client/console-screen";
import { state } from "./shared/rpc";

export default function contribute(client: PluginClientContext): () => void {
  // Right sidebar (explorer location): connection list with launch actions
  // (ssh → terminal tab, rdp/vnc → external window) + console access.
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
    keywords: ["remote", "control", "console", "ssh", "rdp", "vnc"],
    context: "global",
    async onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  // Opening sessions lives in the sidebar panel, which lists the
  // connections: ssh opens a terminal tab, rdp/vnc an external window.

  // The daemon-side Paseo API (needed by the console to open terminals) only
  // reaches plugin code with an RPC handler context, so refresh it from the
  // client even when no panel is mounted — otherwise a console opened right
  // after a plugin reload gets 503 until some UI happens to call an RPC.
  const ping = (): void => {
    void client.rpc(state, {}).catch(() => {
      // The daemon may be reconnecting; the next tick retries.
    });
  };
  ping();
  const heartbeat = setInterval(ping, 10_000);

  return () => clearInterval(heartbeat);
}
