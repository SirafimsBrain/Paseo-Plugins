import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { MemorySurface } from "./client/memory-surface";
import { MemoryFlashSettingsScreen } from "./client/settings-screen";
import { agentReload } from "./shared/memories";

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

  // Repair action (0.9.4): reopen the selected agent's provider session, which
  // reruns `before("agent.session_open")` and re-registers the MCP server. This is
  // the one-click answer to the documented transient case where an agent lost its
  // `memory-flash_*` tools after an idle location eviction — instead of the old
  // advice to recreate the agent. A throw is surfaced by the host as an error
  // toast, so a refused reload is never silent.
  client.addCommandCenterItem({
    id: "repair-memory-tools",
    title: "Repair memory tools (reopen this agent's session)",
    icon: "Wrench",
    keywords: ["memory", "flash", "mcp", "tools", "missing", "repair", "reload", "reopen"],
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
