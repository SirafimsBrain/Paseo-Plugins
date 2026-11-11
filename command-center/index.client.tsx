import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { defineAttachmentSource } from "@getpaseo/plugin";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { CommandCenterSurface } from "./client/command-center-surface";
import { CommandCenterSettingsScreen } from "./client/settings-screen";
import {
  agentReload,
  listCommands,
  listHistory,
  runCommand,
  searchCommandsForAttachment,
} from "./shared/commands";
import { createSchedule } from "./shared/schedules";
import { SCREEN_ID, screenParams, toOpenScreenParams } from "./shared/screen-params";

/**
 * Sidebar header row for the Command Center screen.
 *
 * Paseo 0.11+ renders sidebar items as plugin components: the item decides
 * what a press does, the host owns the row's layout and highlight.
 */
function CommandCenterSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="TerminalSquare"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: SCREEN_ID,
    title: "Command Center",
    Component: CommandCenterSurface,
  });

  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Command Center",
    Component: CommandCenterSidebarItem,
  });

  client.addCommandCenterItem({
    id: "open-command-center",
    title: "Open Command Center",
    icon: "TerminalSquare",
    keywords: ["command", "center", "prompt", "shell", "orchestration"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  client.addCommandCenterItem({
    id: "open-command-center-dashboard",
    title: "Open Command Center dashboard",
    icon: "TerminalSquare",
    keywords: ["command", "center", "dashboard", "stats", "runs", "history"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({
        screenId: SCREEN_ID,
        params: toOpenScreenParams(screenParams("dashboard")),
      });
    },
  });

  client.addCommandCenterItem({
    id: "open-command-center-workspace",
    title: "Open Command Center (this workspace)",
    icon: "TerminalSquare",
    keywords: ["command", "center", "workspace"],
    context: "workspace",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  // "Refresh Command Center tools" (0.6.0, recommendation §12.3 item 2): the
  // new `agents.ref(id).reload()` reopens the agent's session, rerunning
  // `agent.session_open` so the `command_center_run` tool and the launch-only
  // MCP servers of the last command run against this agent are re-derived.
  client.addCommandCenterItem({
    id: "refresh-command-center-tools",
    title: "Refresh Command Center tools on this agent",
    icon: "RefreshCw",
    keywords: ["command", "center", "tools", "refresh", "reload", "mcp"],
    context: "agent",
    async onSelect({ agent, rpc }) {
      const result = await rpc(agentReload, { agentId: agent.id });
      if (!result.ok) {
        throw new Error(result.error ?? "The agent session could not be reloaded.");
      }
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
    argumentHint: "list | history | dashboard | schedule <name> <cron> | <command name>",
    context: "agent",
    async onSubmit({ args, rpc, openScreen }) {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);

      if (trimmed.length === 0 || sub === "list") {
        // The slash-command context has no message channel to print a listing
        // into; the library tab is the screen for it. Deep link (0.6.0):
        // params tell the screen which tab to open.
        openScreen({ screenId: SCREEN_ID, params: toOpenScreenParams(screenParams("library")) });
        return;
      }

      if (sub === "history") {
        openScreen({ screenId: SCREEN_ID, params: toOpenScreenParams(screenParams("history")) });
        return;
      }

      if (sub === "dashboard") {
        openScreen({ screenId: SCREEN_ID, params: toOpenScreenParams(screenParams("dashboard")) });
        return;
      }

      if (sub === "schedule") {
        const [name, cron] = [rest[0] ?? "", rest.slice(1).join(" ")];
        const { commands } = await rpc(listCommands, {});
        const match = commands.find((command) => command.name.toLowerCase() === name.toLowerCase());
        if (!match || match.type !== "prompt" || !match.provider) {
          openScreen({ screenId: SCREEN_ID });
          return;
        }
        const scheduleName = rest.slice(2).join(" ") || match.name;
        const created = await rpc(createSchedule, {
          commandId: match.id,
          name: scheduleName,
          values: {},
          provider: match.provider,
          newWorktree: false,
          archiveOnFinish: true,
          cron: cron || "0 9 * * *",
          runOnCreate: false,
        });
        // Deep link (0.6.0): land on the schedules tab with the new schedule
        // expanded — the same link the schedules tab itself uses.
        openScreen({
          screenId: SCREEN_ID,
          params: toOpenScreenParams(
            created.id
              ? screenParams("schedules", { scheduleId: created.id })
              : screenParams("schedules"),
          ),
        });
        return;
      }

      const target = trimmed;
      const { commands } = await rpc(listCommands, {});
      const match = commands.find(
        (command) => command.name.toLowerCase() === target.toLowerCase(),
      );
      if (!match) {
        // Unknown name: open the library. A known name runs with defaults and
        // stays out of the way — the run lands in the history tab.
        openScreen({ screenId: SCREEN_ID, params: toOpenScreenParams(screenParams("library")) });
        return;
      }
      // Without a dialog the command runs with defaults: empty inputs fall back
      // to template defaults, workspace picks the first active one server-side.
      await rpc(runCommand, { commandId: match.id, values: {} });
    },
  });

  return () => {};
}
