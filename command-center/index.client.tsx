import type { PluginClientContext } from "@getpaseo/plugin/client";
import { defineAttachmentSource } from "@getpaseo/plugin";
import { CommandCenterSurface } from "./client/command-center-surface";
import { CommandCenterSettingsScreen } from "./client/settings-screen";
import {
  listCommands,
  listHistory,
  runCommand,
  searchCommandsForAttachment,
} from "./shared/commands";
import { createSchedule } from "./shared/schedules";

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

  // Composer pills are per-agent (the SDK requires workspaceId + agentId), so
  // they are attached from the agent-panel context instead of at startup.
  // We register them via addHeaderButton-like per-workspace hook when the
  // surface opens: see attachComposerPill in CommandCenterSurface's host app.
  // For now the Command Center stays reachable from chats via /cc and the
  // Command Center items (⌘K).

  // Attachment source: search saved commands from the composer picker and
  // insert their template text into the message.
  client.addAttachmentSource(
    defineAttachmentSource({
      id: "cc-commands",
      title: "Command Center",
      icon: "TerminalSquare",
      pickerTitle: "Command Center",
      searchPlaceholder: "Search commands…",
      search: searchCommandsForAttachment,
    }),
  );

  client.addSettingsScreen({
    id: "command-center-settings",
    title: "Command Center",
    icon: "TerminalSquare",
    Component: CommandCenterSettingsScreen,
  });

  client.addSlashCommand({
    name: "cc",
    description: "Run a Command Center command by name",
    argumentHint: "list | history | schedule <name> <cron> | <command name>",
    context: "agent",
    async onSubmit({ args, rpc, openSurface }) {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);

      if (trimmed.length === 0 || sub === "list") {
        const { commands } = await rpc(listCommands, {});
        const lines = commands.map((command) => `• ${command.name}${command.category ? ` — ${command.category}` : ""}`);
        openSurface(SURFACE_ID);
        return;
      }

      if (sub === "history") {
        // The history tab is the surface for run history; the slash-command
        // context has no message channel to print a listing into.
        openSurface(SURFACE_ID);
        return;
      }

      if (sub === "schedule") {
        const [name, cron] = [rest[0] ?? "", rest.slice(1).join(" ")];
        const { commands } = await rpc(listCommands, {});
        const match = commands.find((command) => command.name.toLowerCase() === name.toLowerCase());
        if (!match || match.type !== "prompt" || !match.provider) {
          openSurface(SURFACE_ID);
          return;
        }
        const scheduleName = rest.slice(2).join(" ") || match.name;
        await rpc(createSchedule, {
          commandId: match.id,
          name: scheduleName,
          values: {},
          provider: match.provider,
          newWorktree: false,
          archiveOnFinish: true,
          cron: cron || "0 9 * * *",
          runOnCreate: false,
        });
        openSurface(SURFACE_ID);
        return;
      }

      const target = trimmed;
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
