import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RemoteControlPanel } from "./client/console-panel";
import { RemoteControlSidebarItem } from "./client/console-sidebar-item";
import { RemoteControlSettingsPanel } from "./client/console-settings-panel";
import { RemoteControlScreen, SCREEN_ID } from "./client/console-screen";
import { state, vaultLock } from "./shared/rpc";

export default function contribute(client: PluginClientContext): () => void {
  // Right sidebar (explorer location): connection list with launch actions
  // (ssh → terminal tab, rdp/vnc → external window) + console access.
  client.addWorkspacePanel({
    id: "remote-control",
    title: "Remote Control",
    icon: "Terminal",
    locations: ["explorer"],
    Component: RemoteControlPanel,
  });

  // Workspace tab (workspace location): settings & configuration.
  client.addWorkspacePanel({
    id: "remote-control-settings",
    title: "Remote Control Settings",
    icon: "Settings",
    locations: ["workspace"],
    Component: RemoteControlSettingsPanel,
  });

  // Stage 0.26.11 (recommendation 4): the sidebar row that has existed in
  // client/console-sidebar-item.tsx since 0.11 and was never registered. It
  // opens the console screen; the Explorer panel stays the connection list.
  client.addSidebarHeaderItem({
    id: "remote-control-console-row",
    title: "Remote Control",
    Component: RemoteControlSidebarItem,
  });

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

  // Stage 0.25.11 (G3): the two entries the plan asks for. "New connection"
  // lands on the console's connection form; "Lock vault" drops the cached
  // master password without opening the console at all.
  client.addCommandCenterItem({
    id: "remote-control-new-connection",
    title: "New remote connection",
    icon: "Server",
    keywords: ["remote", "new", "connection", "ssh", "rdp", "vnc"],
    context: "global",
    async onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID, params: { action: "new" } });
    },
  });

  client.addCommandCenterItem({
    id: "remote-control-lock-vault",
    title: "Lock remote-control vault",
    icon: "Lock",
    keywords: ["remote", "vault", "lock", "secret"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(vaultLock, {});
    },
  });

  // `/remote` (stage 0.25.11, G3): the console, the connection form or the
  // lock action without leaving the composer.
  client.addSlashCommand({
    name: "remote",
    description: "Open the remote-control console, add a connection or lock the storage",
    argumentHint: "console | new | lock",
    context: "workspace",
    async onSubmit({ args, rpc, openScreen }) {
      const subcommand = args.trim().toLowerCase();
      if (subcommand === "lock") {
        await rpc(vaultLock, {});
        return;
      }
      openScreen({
        screenId: SCREEN_ID,
        ...(subcommand === "new" ? { params: { action: "new" } } : {}),
      });
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
