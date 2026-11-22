/**
 * Agent instructions appended on a session open (Paseo 0.17.x `appendSystemPrompt`).
 *
 * Why this exists: a working `web_search` tool does not make an agent use it. Every
 * agent has to discover the tool by itself, and in practice most turns answer from
 * memory. Since 0.17.0 `agent.open.before` may return `appendSystemPrompt`, which
 * Paseo appends to that one session without saving it on the agent, so the plugin can
 * say what the tool is for at the moment it contributes it.
 *
 * Kept in `shared/` because it is pure and used from both sides of the plugin: the
 * settings screen (hint text) and the server hook. No Node APIs, no imports.
 */

/** The two tool names an agent can end up with. */
export type SearchToolName = "web_search" | "bunny_web_search";

/** Tool name the MCP server registers. */
export const MCP_TOOL_NAME: SearchToolName = "web_search";

/** Tool name of the attached `bunny_web_search` agent tool. */
export const ATTACHED_TOOL_NAME: SearchToolName = "bunny_web_search";

/** `{tool}` in the template is replaced with the tool the agent actually received. */
export const TOOL_PLACEHOLDER = "{tool}";

/**
 * Default instruction text. Deliberately short and conditional: it asks for a search
 * only when the answer depends on the world outside the repository, so ordinary coding
 * turns are not turned into searches.
 */
export const DEFAULT_AGENT_INSTRUCTIONS =
  "When a task depends on current library versions, public APIs, documentation or " +
  "error messages that are not in this repository, search the web with `{tool}` " +
  "before answering, and cite the URLs you used.";

/**
 * Renders the instruction for a session open.
 *
 * Returns `null` for an empty (or whitespace-only) template, which is how the
 * "Agent instructions" setting is switched off. The text is trimmed and every
 * `{tool}` occurrence is replaced, so a user can mention the tool twice or not at all.
 */
export function renderAgentInstructions(
  template: string,
  toolName: SearchToolName,
): string | null {
  const trimmed = template.trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(TOOL_PLACEHOLDER).join(toolName);
}
