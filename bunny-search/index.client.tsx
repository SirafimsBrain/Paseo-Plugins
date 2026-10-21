import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BunnySearchSettingsScreen } from "./client/settings-screen";
import { BunnySearchSurface } from "./client/surface";

const SCREEN_ID = "bunny-search";

/**
 * Sidebar header row for the Bunny Search screen.
 *
 * Paseo 0.11+ renders sidebar items as plugin components: the item owns the
 * press and the highlight, the host owns the row's layout.
 */
function BunnySearchSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Globe"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  // Sidebar screen: connection status indicator + quick search.
  client.addScreen({
    id: SCREEN_ID,
    title: "Bunny Search",
    Component: BunnySearchSurface,
  });

  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Bunny Search",
    Component: BunnySearchSidebarItem,
  });

  client.addCommandCenterItem({
    id: "open-bunny-search",
    title: "Bunny Search settings (web search MCP)",
    icon: "Globe",
    keywords: ["bunny", "search", "duckduckjs", "searxng", "web", "mcp", "internet"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  client.addSettingsScreen({
    id: "bunny-search-settings",
    title: "Bunny Search",
    icon: "Globe",
    Component: BunnySearchSettingsScreen,
  });

  return () => {};
}
