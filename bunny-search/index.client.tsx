import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { agentReload } from "./shared/contracts";
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

  // Repair action (0.5.2): reopen the selected agent's provider session, which
  // reruns `before("agent.session_open")` and re-contributes the MCP server or the
  // attached `bunny_web_search` tool. The one-click answer to an agent that lost its
  // search tools after an idle runtime release or an OpenCode location eviction —
  // instead of asking the user to recreate the agent. A throw is surfaced by the
  // host as an error toast, so a refused reload is never silent.
  client.addCommandCenterItem({
    id: "repair-search-tools",
    title: "Repair search tools (reopen this agent's session)",
    icon: "Wrench",
    keywords: ["bunny", "search", "web", "mcp", "tools", "missing", "repair", "reload", "reopen"],
    context: "agent",
    async onSelect({ agent, rpc }) {
      const result = await rpc(agentReload, { agentId: agent.id });
      if (!result.ok) {
        throw new Error(result.error ?? "Could not reopen the agent session.");
      }
    },
  });

  return () => {};
}
