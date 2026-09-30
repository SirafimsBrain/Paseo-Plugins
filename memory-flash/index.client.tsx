import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MemorySurface } from "./client/memory-surface";
import { MemoryFlashSettingsScreen } from "./client/settings-screen";

const SURFACE_ID = "memory-flash";

export default function contribute(client: PluginClientContext) {
  client.addSurface(SURFACE_ID, MemorySurface);

  client.addSidebarItem({
    id: "memory-flash",
    title: "Memory Flash",
    icon: "Database",
    surface: SURFACE_ID,
  });

  client.addCommandCenterItem({
    id: "open-memory-flash",
    title: "Open Memory Flash (shared agent memory)",
    icon: "Database",
    keywords: ["memory", "flash", "shared", "context", "handoff", "knowledge"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });

  client.addCommandCenterItem({
    id: "open-memory-flash-workspace",
    title: "Open Memory Flash (this workspace)",
    icon: "Database",
    keywords: ["memory", "flash", "workspace", "shared", "context"],
    context: "workspace",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
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
