import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ConnectionsSurface } from "./client/connections-surface";
import { ConnectionsSettingsScreen } from "./client/settings-screen";

const SCREEN_ID = "memory-flash-client";

/**
 * Sidebar header row for the Memory Hosts screen.
 *
 * Paseo 0.11+ renders sidebar items as plugin components: the item decides
 * what a press does, the host owns the row's layout and highlight. The
 * contribution `title` is the Settings → Sidebar row label and the row's
 * default label, so the row itself needs no `label`.
 */
function MemoryHostsSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Database"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: SCREEN_ID,
    title: "Memory Hosts",
    Component: ConnectionsSurface,
  });

  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Memory Hosts",
    Component: MemoryHostsSidebarItem,
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
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
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
