import type { RuntimeSettings } from "../../shared/settings";
import type { McpToolDefinition, ToolOutcome } from "../mcp-tools";
import { planReadTool } from "./read";
import { planSearch } from "./search";
import { planScopeTool } from "./scope";

/**
 * `plan_*` tool catalogue and dispatch.
 *
 * The planning tools share the `obsidian-bridge` MCP server, the same settings
 * file and the same limit gate as the document tools; only their boundary is
 * narrower (`planRoot`, see `paths.ts`). Keeping them in one place means the
 * `initialize` index, `tools/list` and the tests read a single list.
 */

/**
 * Contract every planning tool states. Planning has its own purpose and its own
 * boundary, so it does not reuse the document contract sentence: a plan is not
 * a note an agent may cite at will, and it is not agent memory either.
 */
export const PLAN_CONTRACT_SENTENCE =
  "Planning tool for the project plan inside the configured planning directory (`planRoot`): " +
  "use it for plan nodes, incidents and goals — not to record agent memory (memory-flash) and " +
  "not as a general note search (obsidian_search). Paths are relative to `planRoot`; nothing " +
  "outside it, in `__history` or in `_archive` is reachable from here.";

export const PLAN_TOOLS: McpToolDefinition[] = [
  {
    name: "plan_scope",
    title: "Planning root and availability",
    description:
      `${PLAN_CONTRACT_SENTENCE} Reports whether the planning directory exists, what it contains ` +
      "and whether planning writes are enabled. Call it before any other `plan_*` tool: " +
      "`planning_available: false` means there is no planning tree to read and none is created " +
      "by asking.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "plan_read",
    title: "Read a plan node or project overview",
    description:
      `${PLAN_CONTRACT_SENTENCE} Without \`path\` it returns the project overview: every project ` +
      "with its root node, its trunks, counts, open incidents and proposed goals. With `path` " +
      "it returns one node in context: ancestors, children, siblings, influences in both " +
      "directions, blocking incidents, the goal and growth record, and `beeCycle` when the " +
      "influence edges close a loop.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Node path relative to the planning root, e.g. `centurion/backend/auth/auth`. " +
            "The node file itself may be omitted (`centurion/backend/auth` reads `auth.md`). " +
            "Empty returns the project overview.",
        },
        project: {
          type: "string",
          description: "Optional project folder (first level under the planning root) to focus the overview.",
        },
      },
    },
  },
  {
    name: "plan_search",
    title: "Search the plan",
    description:
      `${PLAN_CONTRACT_SENTENCE} Hybrid search over plan documents only: the result is limited to ` +
      "the planning directory and filtered by `kind`, `status` and `project` read from YAML " +
      "frontmatter, not from the text. Use it to find a node by its name or description; use " +
      "`plan_read` to see it in context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words from a node name, description or body." },
        kind: {
          type: "string",
          description:
            "Restrict to kinds: `root`, `trunk`, `branch`, `subbranch`, `leaf`, `incident`, " +
            "`goal` (comma-separated or a list).",
        },
        status: {
          type: "string",
          description: "Restrict to one or more statuses; matched against the YAML `status` field.",
        },
        project: { type: "string", description: "Restrict to one project folder." },
        limit: { type: "number", description: "Maximum hits, 1–50 (default from plugin settings)." },
      },
      required: ["query"],
    },
  },
];

type PlanHandler = (
  settings: RuntimeSettings,
  input: Record<string, unknown>,
) => ToolOutcome | Promise<ToolOutcome>;

const HANDLERS: Record<string, PlanHandler> = {
  plan_scope: (settings) => planScopeTool(settings),
  plan_read: (settings, input) => planReadTool(settings, input),
  plan_search: (settings, input) => planSearch(settings, input),
};

/**
 * Dispatches a `plan_*` call, or returns `null` when the name is not a planning
 * tool. Planning calls run before the vault index is opened, so `plan_scope`
 * can report a missing or empty root without creating an index; `plan_search`
 * opens the index itself because ranking is its whole purpose.
 */
export async function dispatchPlanTool(
  name: string,
  input: Record<string, unknown>,
  settings: RuntimeSettings,
): Promise<ToolOutcome | null> {
  const handler = HANDLERS[name];
  return handler ? await handler(settings, input) : null;
}
