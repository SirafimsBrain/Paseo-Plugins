import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { upsertLeafInputSchema } from "../shared/tools";
import { MCP_TOOLS, dispatchMcpTool } from "./mcp-tools";
import type { LuckPlannerStore } from "./store";

/**
 * The native `luck_tree_upsert_leaf` agent tool (0.35.1, recommendation
 * §10.8 item 2).
 *
 * Delivered through Paseo's own tool transport (`defineAgentTool`, new in
 * 0.14.0) on session opens where the MCP server could not be contributed —
 * a provider without MCP support, or an agent whose saved-server state is
 * unknown. It is the fallback that keeps the loop alive for those agents:
 * one tool instead of eleven, but the same call the skill tells agents to
 * make most often, against the same store, with the same validation and the
 * same audit trail.
 *
 * Deliberately a thin adapter over `dispatchMcpTool`: the input schema comes
 * from `shared/tools.ts` (the one source of truth both transports validate
 * with), the execution is the MCP dispatcher itself, and the audit actor
 * defaults to the calling agent's id — the same stamp the MCP server gets
 * from `LUCK_PLANNER_AGENT_ID` in its session environment.
 *
 * The tool can never coexist with the MCP server of the same name: the
 * session-open decision (server/session-open.ts) attaches it exactly where
 * no MCP contribution is made and the saved config does not already carry
 * the server.
 */

/** Same name as the MCP tool: agents see one surface either way. */
export const UPSERT_LEAF_TOOL_NAME = "luck_tree_upsert_leaf";

/** The MCP description, so both transports tell agents the same thing. */
const MCP_DESCRIPTION =
  MCP_TOOLS.find((tool) => tool.name === UPSERT_LEAF_TOOL_NAME)?.description ??
  "Record a planned or confirmed fact leaf.";

export function createUpsertLeafTool(store: LuckPlannerStore): AgentToolDefinition {
  return defineAgentTool({
    name: UPSERT_LEAF_TOOL_NAME,
    title: "Create or update a fact leaf",
    description:
      MCP_DESCRIPTION +
      " Available natively when this provider cannot load MCP servers — same " +
      "store, same validation and same audit trail as the MCP tool of this name.",
    input: upsertLeafInputSchema,
    async execute(input, context) {
      const result = dispatchMcpTool(UPSERT_LEAF_TOOL_NAME, input, {
        store,
        defaultActor: context.agent.id,
      });
      const text = result.content.map((part) => part.text).join("\n");
      return result.isError ? { text, isError: true } : { text };
    },
  });
}
