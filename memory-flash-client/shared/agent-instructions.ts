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
 * Paseo prefixes MCP tool names with the server name, and this plugin's names are
 * derived from the connection set (`memory-flash` with one connection,
 * `memory-flash-<connectionId>` with several). The default text therefore uses
 * `{server}` / `{servers}` placeholders; `renderAgentInstructions` substitutes
 * the names this open actually registered, so the instruction never names a tool
 * the agent does not have.
 *
 * Kept in `shared/` because it is pure and used from both sides: the settings
 * screen shows the default, the server hook returns the rendered text. No Node
 * APIs, no imports.
 */

export const DEFAULT_AGENT_INSTRUCTIONS =
  "A shared remote memory base is connected to this agent through the `{servers}` " +
  "MCP server(s). Their tools are prefixed with the server name — search " +
  "(`{server}_memory_search`) before the first edit of a non-trivial task, save " +
  "every bugfix the moment it is fixed (`{server}_memory_save`), and leave a " +
  "handoff (`{server}_memory_handoff`) before you stop.";

/** Placeholder replaced with the first configured server name (the example tools). */
export const SERVER_PLACEHOLDER = "{server}";

/** Placeholder replaced with the full, backticked list of configured server names. */
export const SERVERS_PLACEHOLDER = "{servers}";

/**
 * Renders the instruction for a session open.
 *
 * Returns `null` for an empty (or whitespace-only) template, which is how the
 * "Agent instructions" setting is switched off. `{server}` becomes the first
 * registered name (used in the tool examples) and `{servers}` the full list, so a
 * renamed or suffixed server set still produces instructions that match what
 * Paseo exposes. With no name to substitute, `memory-flash` is used as the
 * documented default prefix.
 */
export function renderAgentInstructions(
  template: string,
  serverNames: readonly string[],
): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null;
  const names = serverNames.length > 0 ? [...serverNames] : ["memory-flash"];
  const first = names[0] ?? "memory-flash";
  return trimmed
    .split(SERVER_PLACEHOLDER)
    .join(first)
    .split(SERVERS_PLACEHOLDER)
    .join(names.map((name) => `\`${name}\``).join(", "));
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
