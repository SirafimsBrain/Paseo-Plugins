import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CommandCenterSurface } from "./client/command-center-surface";
import { listCommands, runCommand } from "./shared/commands";

const SURFACE_ID = "command-center";

export default function contribute(client: PluginClientContext) {
  client.addSurface(SURFACE_ID, CommandCenterSurface);

  client.addSidebarItem({
    id: "command-center",
    title: "Command Center",
    icon: "TerminalSquare",
    surface: SURFACE_ID,
  });

  client.addCommandCenterItem({
    id: "open-command-center",
    title: "Open Command Center",
    icon: "TerminalSquare",
    keywords: ["command", "center", "prompt", "shell", "orchestration"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });

  client.addCommandCenterItem({
    id: "open-command-center-workspace",
    title: "Open Command Center (this workspace)",
    icon: "TerminalSquare",
    keywords: ["command", "center", "workspace"],
    context: "workspace",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });

  client.addSlashCommand({
    name: "cc",
    description: "Run a Command Center command by name",
    argumentHint: "<command name>",
    context: "agent",
    async onSubmit({ args, rpc, openSurface }) {
      const target = args.trim();
      if (target.length === 0) {
        openSurface(SURFACE_ID);
        return;
      }
      const { commands } = await rpc(listCommands, {});
      const match = commands.find(
        (command) => command.name.toLowerCase() === target.toLowerCase(),
      );
      if (!match) {
        openSurface(SURFACE_ID);
        return;
      }
      // Without a dialog the command runs with defaults: empty inputs fall back
      // to template defaults, workspace picks the first active one server-side.
      await rpc(runCommand, { commandId: match.id, values: {} });
    },
  });

  return () => {};
}
