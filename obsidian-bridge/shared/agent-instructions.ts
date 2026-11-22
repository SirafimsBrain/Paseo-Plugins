/**
 * Agent instructions appended on a session open (Paseo 0.17.x `appendSystemPrompt`).
 *
 * The tools alone do not tell an agent *when* the vault matters, and the skill is
 * only one of the ways the plugin reaches an agent (MCP injection, a provider's
 * own config file and the attached fallback tools all deliver the same surface).
 * One instruction per open covers every path, rides on that session only, is
 * never saved on the agent, and costs no file write.
 *
 * Tool names carry the MCP server prefix in Paseo (`<server>_obsidian_search`),
 * and the prefix differs between the MCP server (`obsidian-bridge`) and the
 * attached fallback tools (`obsidian_bridge_obsidian_search`), so the default text
 * uses `{server}` and `renderAgentInstructions` substitutes the prefix this open
 * actually used.
 *
 * Kept in `shared/` because it is pure and used from both sides: the settings
 * screen shows the default, the server hook returns the rendered text. No Node
 * APIs, no imports.
 */

export const DEFAULT_AGENT_INSTRUCTIONS =
  "This agent can read the user's Obsidian knowledge base through the `{server}` MCP tools. " +
  "Search it (`{server}_obsidian_search`) before answering from memory when a task depends on " +
  "the user's notes, plans or written documents, read the note (`{server}_obsidian_read`) " +
  "before quoting it, and cite the note path and heading you used. Write only when the user " +
  "asks, and never invent a note path.";

/** Placeholder replaced with the MCP server prefixes this open used. */
export const SERVER_PLACEHOLDER = "{server}";

/**
 * Renders the instruction for a session open.
 *
 * Returns `null` for an empty (or whitespace-only) template, which is how the
 * "Agent instructions" setting is switched off. Every `{server}` becomes the
 * prefix the agent's tools carry (`obsidian-bridge` for the MCP server,
 * `obsidian_bridge` for the attached tools), so a renamed server or the fallback
 * path never names a tool the agent does not have.
 */
export function renderAgentInstructions(
  template: string,
  serverName: string,
): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(SERVER_PLACEHOLDER).join(serverName);
}

/** What this open left the agent with, as far as the vault is concerned. */
export interface InstructionTarget {
  /** `injectIntoAgents` setting — the single switch for "may this plugin reach agents". */
  injectIntoAgents: boolean;
  /** `interactive` | `history` */
  purpose: string;
  /** `create` | `resume` | `refresh` | `import` */
  reason: string;
  /** This open contributes the full MCP server. */
  injectMcp: boolean;
  /** This open contributes the attached fallback tools. */
  attachTool: boolean;
  /** The provider's own config file already carries the server. */
  configCovered: boolean;
  /** The agent's saved configuration already carries the server. */
  savedHasServer: boolean;
}

/**
 * Whether this open should append the instruction.
 *
 * True when the agent ends up with at least one working vault surface: the MCP
 * server contributed by this open, the attached fallback tools, a provider
 * config file or a saved server. `reason === "create"` counts because the create
 * hook has just written the server (or the config already covered it), even
 * though the open hook itself contributes nothing there. `history` opens never
 * run a turn, and an agent the user switched off gets nothing.
 */
export function instructionApplies(input: InstructionTarget): boolean {
  if (!input.injectIntoAgents) return false;
  if (input.purpose === "history") return false;
  return (
    input.injectMcp ||
    input.attachTool ||
    input.configCovered ||
    input.savedHasServer ||
    input.reason === "create"
  );
}
