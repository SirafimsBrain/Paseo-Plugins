/**
 * Agent instructions appended on a session open (Paseo 0.17.x `appendSystemPrompt`).
 *
 * Why this exists: the MCP server can be present while nothing tells the agent
 * when to use it. The skill is a separate install, and a config-file registration
 * may bypass this plugin's hooks entirely. One instruction returned on every open
 * reaches every agent whose memory wiring this plugin can see, is re-derived per
 * open like the rest of the wiring, is never saved on the agent, and needs no
 * file writes.
 *
 * Tool names carry the MCP server prefix in Paseo (`<server>_memory_save`), and
 * the server name is configurable, so the default text uses `{server}` instead of
 * a hard-coded `memory-flash`. `renderAgentInstructions` substitutes the name the
 * open actually used.
 *
 * Kept in `shared/` because it is pure and used from both sides: the settings
 * screen shows the default, the server hook returns the rendered text. No Node
 * APIs, no imports.
 */

/**
 * Default instruction text. Deliberately short: it names the tools the agent can
 * call and the three moments memory pays off (before the first edit, when a
 * bugfix lands, before stopping), without turning ordinary turns into writes.
 */
export const DEFAULT_AGENT_INSTRUCTIONS =
  "This host has a shared memory base served by the `{server}` MCP server. " +
  "Search it (`{server}_memory_search`) before the first edit of a non-trivial " +
  "task, save every bugfix the moment it is fixed (`{server}_memory_save`), and " +
  "leave a handoff (`{server}_memory_handoff`) before you stop.";

/** Placeholder replaced with the configured MCP server name. */
export const SERVER_PLACEHOLDER = "{server}";

/**
 * Renders the instruction for a session open.
 *
 * Returns `null` for an empty (or whitespace-only) template, which is how the
 * "Agent instructions" setting is switched off. The text is trimmed and every
 * `{server}` occurrence is replaced with the server name this open registered
 * (the same name Paseo prefixes the tools with), so a renamed server never
 * produces instructions that name a tool the agent does not have.
 */
export function renderAgentInstructions(
  template: string,
  serverName: string,
): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(SERVER_PLACEHOLDER).join(serverName);
}

/** What this open left the agent with, as far as memory is concerned. */
export interface InstructionTarget {
  /** `injectIntoAgents` setting — the single switch for "may memory reach agents". */
  injectIntoAgents: boolean;
  /** `interactive` | `history` */
  purpose: string;
  /** This open contributes the full MCP server. */
  injectMcp: boolean;
  /** `agentConfigCoversProvider` — the agent's own config file carries the server. */
  configCovered: boolean;
  /** The agent's saved configuration already carries the server. */
  savedHasServer: boolean;
}

/**
 * Whether this open should append the instruction.
 *
 * Only a full memory server qualifies. A recall-only open (the attached
 * read-only `memory_flash_recall` tool) gets nothing: telling an agent to save a
 * bugfix through a tool that cannot write would be wrong. `history` opens never
 * run a turn, and a gated-off agent must not be advertised a tool the user
 * switched off.
 */
export function instructionApplies(input: InstructionTarget): boolean {
  if (!input.injectIntoAgents) return false;
  if (input.purpose === "history") return false;
  return input.injectMcp || input.configCovered || input.savedHasServer;
}
