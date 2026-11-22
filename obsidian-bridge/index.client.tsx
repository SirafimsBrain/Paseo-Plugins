import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { KnowledgeSurface } from "./client/surface";
import { ObsidianCiteComposerItem } from "./client/composer-item";
import { KnowledgeWorkspacePanel } from "./client/workspace-panel";
import { ObsidianFilePanel } from "./client/file-panel";
import { ObsidianWorkspaceBadge } from "./client/workspace-badge";
import { ObsidianBridgeSettingsScreen } from "./client/settings-screen";
import { notesAttachmentSource } from "./shared/attachments";

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

  client.addWorkspacePanel({
    id: "knowledge-base",
    title: "Obsidian",
    icon: "BookOpen",
    Component: KnowledgeWorkspacePanel,
  });

  // 0.22.18: a note opened from Paseo (or from a search hit) as a file tab.
  client.addFilePanel({
    id: "obsidian-note",
    title: "Obsidian note",
    icon: "FileText",
    files: { extensions: ["md", "markdown"] },
    Component: ObsidianFilePanel,
  });

  // Index state on the workspace row, only while there is something to say.
  client.addWorkspaceRowBadgeItem({
    id: "obsidian-index-state",
    title: "Obsidian index",
    icon: "BookOpen",
    Component: ObsidianWorkspaceBadge,
  });

  // Attach one note to a prompt as an explicit text snapshot.
  client.addAttachmentSource(notesAttachmentSource);

  // The smaller gesture: turn the draft into citations without attaching a note.
  client.addComposerItem({
    id: "obsidian-cite",
    Component: ObsidianCiteComposerItem,
  });

  client.addSettingsScreen({
    id: "obsidian-bridge-settings",
    title: "Obsidian Bridge",
    icon: "BookOpen",
    Component: ObsidianBridgeSettingsScreen,
  });

  // `/obsidian <query>` opens the knowledge base with the search already run.
  client.addSlashCommand({
    name: "obsidian",
    description: "Search the Obsidian knowledge base",
    argumentHint: "<query>",
    context: "workspace",
    onSubmit({ args, openScreen }) {
      const query = args.trim();
      openScreen({ screenId: SCREEN_ID, params: query.length > 0 ? { query } : {} });
    },
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
