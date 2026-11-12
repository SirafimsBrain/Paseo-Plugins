import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { KnowledgeSurface } from "./client/surface";
import { ObsidianBridgeSettingsScreen } from "./client/settings-screen";

const SCREEN_ID = "obsidian-bridge";

/**
 * Sidebar header row for the knowledge-base screen.
 *
 * Paseo renders sidebar items as plugin components: the item decides what a
 * press does, the host owns layout and highlight.
 */
function ObsidianBridgeSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="BookOpen"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: SCREEN_ID,
    title: "Obsidian Bridge",
    Component: KnowledgeSurface,
  });

  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Obsidian Bridge",
    Component: ObsidianBridgeSidebarItem,
  });

  client.addSettingsScreen({
    id: "obsidian-bridge-settings",
    title: "Obsidian Bridge",
    icon: "BookOpen",
    Component: ObsidianBridgeSettingsScreen,
  });

  client.addCommandCenterItem({
    id: "open-obsidian-bridge",
    title: "Open Obsidian knowledge base",
    icon: "BookOpen",
    keywords: ["obsidian", "vault", "notes", "knowledge", "research", "docs"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  client.addCommandCenterItem({
    id: "open-obsidian-bridge-workspace",
    title: "Open Obsidian knowledge base (this workspace)",
    icon: "BookOpen",
    keywords: ["obsidian", "vault", "notes", "workspace"],
    context: "workspace",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  return () => {};
}
