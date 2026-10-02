import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ConnectionsSurface } from "./client/connections-surface";
import { ConnectionsSettingsScreen } from "./client/settings-screen";

const SURFACE_ID = "memory-flash-client";

export default function contribute(client: PluginClientContext) {
  client.addSurface(SURFACE_ID, ConnectionsSurface);

  client.addSidebarItem({
    id: "memory-flash-client",
    title: "Memory Hosts",
    icon: "Database",
    surface: SURFACE_ID,
  });

  client.addCommandCenterItem({
    id: "open-memory-flash-client",
    title: "Open remote memory hosts (memory-flash-client)",
    icon: "Database",
    keywords: [
      "memory",
      "remote",
      "host",
      "client",
      "api key",
      "mcp",
      "http",
      "connect",
    ],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });

  client.addSettingsScreen({
    id: "memory-flash-client-settings",
    title: "Memory Flash Client",
    icon: "Database",
    Component: ConnectionsSettingsScreen,
  });

  return () => {};
}
