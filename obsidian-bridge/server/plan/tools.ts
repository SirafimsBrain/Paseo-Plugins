import type { RuntimeSettings } from "../../shared/settings";
import type { McpToolDefinition, ToolOutcome } from "../mcp-tools";
import { planScopeTool } from "./scope";

/**
 * `plan_*` tool catalogue and dispatch.
 *
 * The planning tools share the `obsidian-bridge` MCP server, the same settings
 * file and the same limit gate as the document tools; only their boundary is
 * narrower (`planRoot`, see `paths.ts`). Keeping them in one place means the
 * `initialize` index, `tools/list` and the tests read a single list.
 */

export const PLAN_TOOLS: McpToolDefinition[] = [
  {
    name: "plan_scope",
    title: "Planning root and availability",
    description:
      "Reports whether the planning directory (`planRoot`, default `Workspaces`) exists, what " +
      "it contains and whether planning writes are enabled. Call it before any other `plan_*` " +
      "tool: `planning_available: false` means there is no planning tree to read and none is " +
      "created by asking. Planning tools never leave `planRoot` and never touch a path above " +
      "the configured vault.",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS: Record<string, (settings: RuntimeSettings) => ToolOutcome> = {
  plan_scope: planScopeTool,
};

/**
 * Dispatches a `plan_*` call, or returns `null` when the name is not a planning
 * tool. Planning calls run before the vault index is opened, so `plan_scope`
 * can report a missing or empty root without creating an index.
 */
export function dispatchPlanTool(
  name: string,
  settings: RuntimeSettings,
): ToolOutcome | null {
  const handler = HANDLERS[name];
  return handler ? handler(settings) : null;
}
