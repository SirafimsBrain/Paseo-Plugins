/**
 * Agent instructions appended on a session open (Paseo 0.17.x `appendSystemPrompt`).
 *
 * The remote servers are contributed launch-only and can be withheld entirely
 * (a shared OpenCode v2 service) or replaced by the agent's own config. A
 * working `memory_*` tool does not make an agent use it: the skill is a separate
 * install, so one instruction per open tells the agent what the injected remote
 * tools are for. It rides on that session only, is never saved on the agent, and
 * needs no file writes.
 *
 * Kept in `shared/` because it is pure and used from both sides: the settings
 * screen shows the default, the server hook returns the rendered text. No Node
 * APIs, no imports.
 */

export const DEFAULT_AGENT_INSTRUCTIONS =
  "A shared remote memory base is connected to this agent through the memory-flash " +
  "tools. Search it (memory_search) before the first edit of a non-trivial task, " +
  "save every bugfix the moment it is fixed (memory_save), and leave a handoff " +
  "(memory_handoff) before you stop.";

/**
 * Renders the instruction for a session open.
 *
 * Returns `null` for an empty (or whitespace-only) template, which is how the
 * "Agent instructions" setting is switched off. The text is trimmed.
 */
export function renderAgentInstructions(template: string): string | null {
  const trimmed = template.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** What this open left the agent with, as far as the remote servers are concerned. */
export interface ClientInstructionTarget {
  /** `injectIntoAgents` setting — the single switch for "may this plugin reach agents". */
  injectIntoAgents: boolean;
  /** `interactive` | `history` */
  purpose: string;
  /** How many remote servers this open contributes. */
  injectedNames: number;
  /** The agent's saved configuration already carries one of the configured names. */
  savedHasServer: boolean;
}

/**
 * Whether this open should append the instruction.
 *
 * True when the agent is left with at least one remote server, either
 * contributed by this open or already saved on it. `history` opens never run a
 * turn, and an agent the user switched off gets nothing.
 */
export function instructionApplies(input: ClientInstructionTarget): boolean {
  if (!input.injectIntoAgents) return false;
  if (input.purpose === "history") return false;
  return input.injectedNames > 0 || input.savedHasServer;
}
