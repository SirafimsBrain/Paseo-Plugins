import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { MemorySurface } from "./client/memory-surface";
import { MemoryFlashSettingsScreen } from "./client/settings-screen";

const SCREEN_ID = "memory-flash";

/**
 * Sidebar header row for the Memory Flash screen.
 *
 * Paseo 0.11+ renders sidebar items as plugin components: the item decides
 * what a press does, the host owns the row's layout and highlight.
 */
function MemoryFlashSidebarItem({
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
    title: "Memory Flash",
    Component: MemorySurface,
  });

  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Memory Flash",
    Component: MemoryFlashSidebarItem,
  });

  client.addCommandCenterItem({
    id: "open-memory-flash",
    title: "Open Memory Flash (shared agent memory)",
    icon: "Database",
    keywords: ["memory", "flash", "shared", "context", "handoff", "knowledge"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  client.addCommandCenterItem({
    id: "open-memory-flash-workspace",
    title: "Open Memory Flash (this workspace)",
    icon: "Database",
    keywords: ["memory", "flash", "workspace", "shared", "context"],
    context: "workspace",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  client.addSettingsScreen({
    id: "memory-flash-settings",
    title: "Memory Flash",
    icon: "Database",
    Component: MemoryFlashSettingsScreen,
  });

  return () => {};
}
