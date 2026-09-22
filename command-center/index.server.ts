import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  clearHistory,
  deleteCommand,
  listCommands,
  listHistory,
  runCommand,
  saveCommand,
  toggleFavorite,
  type CommandDefinition,
  type RunResult,
} from "./shared/commands";
import { commandSchema } from "./shared/commands";
import { clearHistoryStore, loadCommands, loadHistory, saveCommands } from "./server/store";
import { executeCommand } from "./server/executor";

function parseCommand(raw: unknown): CommandDefinition | null {
  const result = commandSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export default function contribute(server: PluginServerContext) {
  server.handle(listCommands, () => ({
    commands: loadCommands(),
  }));

  server.handle(saveCommand, (input) => {
    if (input.deleteId) {
      const remaining = loadCommands().filter((command) => command.id !== input.deleteId);
      saveCommands(remaining);
    }
    const incoming = parseCommand(input.command);
    if (!incoming) {
      return { saved: false, id: null, error: "Command payload failed validation." };
    }
    const commands = loadCommands();
    const existingIndex = commands.findIndex((command) => command.id === incoming.id);
    if (existingIndex >= 0) {
      // Preserve server-owned counters the client editor does not track.
      incoming.useCount = commands[existingIndex].useCount;
      commands[existingIndex] = incoming;
    } else {
      commands.push(incoming);
    }
    commands.sort((a, b) => a.name.localeCompare(b.name));
    saveCommands(commands);
    return { saved: true, id: incoming.id, error: null };
  });

  server.handle(deleteCommand, (input) => {
    saveCommands(loadCommands().filter((command) => command.id !== input.id));
    return { deleted: true };
  });

  server.handle(toggleFavorite, (input) => {
    const commands = loadCommands();
    const target = commands.find((command) => command.id === input.id);
    if (!target) return { ok: false };
    target.favorite = input.favorite;
    saveCommands(commands);
    return { ok: true };
  });

  server.handle(listHistory, () => ({ entries: loadHistory() }));

  server.handle(clearHistory, () => {
    clearHistoryStore();
    return { ok: true };
  });

  server.handle(runCommand, async (input, { paseo }) => {
    const command = loadCommands().find((candidate) => candidate.id === input.commandId);
    if (!command) {
      const miss: RunResult = {
        ok: false,
        kind: "new-agent",
        workspaceId: null,
        agentId: null,
        terminalId: null,
        title: null,
        error: `Unknown command ${input.commandId}.`,
      };
      return miss;
    }
    const result = await executeCommand(
      command,
      {
        values: input.values,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        newWorktree: input.newWorktree ?? false,
      },
      { paseo },
    );
    if (result.ok) {
      const commands = loadCommands();
      const stored = commands.find((candidate) => candidate.id === command.id);
      if (stored) {
        stored.useCount += 1;
        saveCommands(commands);
      }
    }
    return result;
  });

  return () => {};
}
