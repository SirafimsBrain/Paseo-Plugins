import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CommandDefinition } from "../shared/commands";
import { defaultValuesForCommand } from "../shared/commands";
import { executeCommand } from "./executor";
import { loadCommands } from "./store";

/**
 * The `command_center_run` agent tool (0.6.0, recommendation §12.3 item 1).
 *
 * Delivered through Paseo's own tool transport (`defineAgentTool`, new in
 * 0.14.0) on every interactive session open — no MCP config, Zod-validated
 * input, a host-enforced 10-minute call ceiling, and only metadata plus
 * inputs/results cross the process boundary.
 *
 * Semantics:
 *
 * - The saved command is resolved by exact id or case-insensitive name.
 * - Template inputs fall back to the command's stored defaults, then the
 *   caller's `values` override them.
 * - A **shell** command runs in a terminal of the *calling agent's own
 *   workspace* — the same workspace the agent is working in.
 * - A **prompt** command creates a **new** agent in that workspace with the
 *   command's stored provider and MCP servers. It deliberately never targets
 *   the calling agent: an agent prompting itself mid-turn would recurse, and
 *   a tool that can hijack its own caller's context is a footgun.
 * - Every run lands in the shared history, exactly like a run from the UI.
 */

const TOOL_NAME = "command_center_run";

export const commandCenterToolInput = z.object({
  /** Command id or case-insensitive command name. */
  command: z.string().min(1).max(200),
  /** Overrides for the command's template inputs; stored defaults fill the rest. */
  values: z.record(z.string(), z.string()).optional(),
});

export type CommandCenterToolInput = z.output<typeof commandCenterToolInput>;

/** Resolve a stored command by exact id or case-insensitive name. */
export function findCommand(
  commands: CommandDefinition[],
  needle: string,
): CommandDefinition | null {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return null;
  return (
    commands.find((candidate) => candidate.id === trimmed) ??
    commands.find((candidate) => candidate.name.toLowerCase() === trimmed.toLowerCase()) ??
    null
  );
}

/** First names of the library, for the "unknown command" error message. */
function knownNames(commands: CommandDefinition[]): string {
  const names = commands.slice(0, 30).map((command) => command.name);
  return names.join(", ") + (commands.length > 30 ? ", …" : "");
}

export function createCommandCenterTool(): AgentToolDefinition {
  return defineAgentTool({
    name: TOOL_NAME,
    title: "Run a saved command",
    description:
      "Run a saved Command Center command by name or id. Shell commands run in a " +
      "terminal of this agent's workspace; prompt commands create a new agent in " +
      "the same workspace with the command's stored provider and MCP servers (they " +
      "never prompt this agent itself); workflow commands run their saved steps in " +
      "order on this workspace. Inputs fall back to the command's stored defaults; " +
      "pass `values` to override them.",
    input: commandCenterToolInput,
    async execute(input, context) {
      const commands = loadCommands();
      const command = findCommand(commands, input.command);
      if (!command) {
        return {
          isError: true,
          text: `Unknown command "${input.command}". Saved commands: ${knownNames(commands) || "(none)"}.`,
        };
      }

      const values = { ...defaultValuesForCommand(command), ...(input.values ?? {}) };
      const result = await executeCommand(
        command,
        {
          values,
          workspaceId: context.agent.workspaceId ?? undefined,
          newWorktree: false,
        },
        { paseo: context.paseo },
      );

      if (!result.ok) {
        return { isError: true, text: `Command "${command.name}" failed: ${result.error ?? "unknown error"}.` };
      }

      const target =
        result.kind === "terminal"
          ? `terminal ${result.terminalId ?? "?"}`
          : result.kind === "new-agent"
            ? `new agent ${result.agentId ?? "?"}`
            : result.kind === "workflow"
              ? `workflow run in workspace ${result.workspaceId ?? "?"}`
              : `agent ${result.agentId ?? "?"}`;
      return {
        text: `Command "${command.name}" dispatched to ${target}. ` +
          "The outcome is not captured back here — check the workspace (the run is in the Command Center history).",
        structuredContent: {
          commandId: command.id,
          kind: result.kind,
          workspaceId: result.workspaceId,
          agentId: result.agentId,
          terminalId: result.terminalId,
        },
      };
    },
  });
}
