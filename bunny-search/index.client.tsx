import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BunnySearchSettingsScreen } from "./client/settings-screen";
import { BunnySearchSurface } from "./client/surface";

const SURFACE_ID = "bunny-search";

export default function contribute(client: PluginClientContext) {
  // Sidebar surface: connection status indicator + quick search.
  client.addSurface(SURFACE_ID, BunnySearchSurface);

  client.addSidebarItem({
    id: "bunny-search",
    title: "Bunny Search",
    icon: "Globe",
    surface: SURFACE_ID,
  });

  client.addCommandCenterItem({
    id: "open-bunny-search",
    title: "Bunny Search settings (web search MCP)",
    icon: "Globe",
    keywords: ["bunny", "search", "searxng", "web", "mcp", "internet"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
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
