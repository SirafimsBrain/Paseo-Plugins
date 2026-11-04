import type { Node, NodeKind } from "../shared/tree";
import type {
  AddBeeInput,
  ApproveGoalInput,
  ArchiveNodeInput,
  ContextSection,
  ExportInput,
  FindBugsInput,
  FindGoalsInput,
  GetContextInput,
  HistoryInput,
  ImportInput,
  MoveNodeInput,
  ReportBugInput,
  SearchInput,
  SetGoalInput,
  UpdateGrowthInput,
  UpsertLeafInput,
  UpsertNodeInput,
} from "../shared/tools";
import {
  CONTEXT_SECTIONS,
  addBeeInputSchema,
  approveGoalInputSchema,
  archiveNodeInputSchema,
  exportInputSchema,
  findBugsInputSchema,
  findGoalsInputSchema,
  getContextInputSchema,
  historyInputSchema,
  importInputSchema,
  moveNodeInputSchema,
  reportBugInputSchema,
  searchInputSchema,
  setGoalInputSchema,
  updateGrowthInputSchema,
  upsertLeafInputSchema,
  upsertNodeInputSchema,
} from "../shared/tools";
import { exportCounts } from "../shared/export";
import { writeExportFile } from "./export";
import { runImport } from "./import";
import { resolvePluginVersion } from "./plugin-paths";
import type { LuckPlannerStore } from "./store";

/**
 * The parent a created node gets when the caller names none.
 *
 * The hierarchy is strict (`root → trunk → branch → subbranch → leaf`,
 * `shared/tree.ts`), so the sensible default is the first node of the kind
 * that may hold it: a trunk under the root, a branch under the root's first
 * trunk, a leaf under the first branch. The agent that writes a project tree
 * should not have to know the ids of the skeleton to start.
 */
function defaultParentId(
  store: LuckPlannerStore,
  projectKey: string,
  kind: NodeKind,
): string | null {
  if (kind === "root") return null;
  const roots = store.listChildren(projectKey, null);
  const root = roots[0];
  if (root === undefined) return null;
  if (kind === "trunk") return root.id;
  const trunks = store.listChildren(projectKey, root.id);
  const trunk = trunks[0];
  if (trunk === undefined) return null;
  if (kind === "branch") return trunk.id;
  const branches = store.listChildren(projectKey, trunk.id);
  return branches[0]?.id ?? null;
}

/**
 * MCP tool definitions and dispatch for luck-planner (PLAN.md stage D1).
 *
 * The dispatch layer is transport-independent on purpose: the stdio JSON-RPC
 * server (stage D2) and the tests share one implementation, exactly like
 * memory-flash's `server/mcp-tools.ts`. Validation lives in the shared zod
 * contracts; store errors — already readable — surface as `isError` results
 * instead of exceptions, so one bad call never takes the MCP server down.
 *
 * ADR-8 note: every tool here goes through the store, so writes keep the
 * `project_key` scope, the revision counter and the audit trail. There is no
 * bypass path.
 */

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: { type?: string; description?: string; enum?: string[] };
  enum?: string[];
  default?: unknown;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

function str(description: string): JsonSchemaProperty {
  return { type: "string", description };
}

function strArray(description: string): JsonSchemaProperty {
  return { type: "array", items: { type: "string" }, description };
}

function num(description: string): JsonSchemaProperty {
  return { type: "number", description };
}

const PROJECT_KEY = str(
  "Canonical absolute path of the project this call addresses — the current " +
    "workspace only. Do not probe other projectKeys; expanding scope requires " +
    "an explicit user request.",
);

/**
 * `instructions` of the MCP `initialize` result (0.35.1, recommendation
 * §10.8 item 6).
 *
 * Lives here, not in `mcp-server.ts`, so it is testable without spawning the
 * stdio process (that module runs `main()` on import). The text complements
 * the `luck-planner` agent skill rather than replacing it: the skill is
 * installed into skills directories that already exist and can be skipped,
 * while `instructions` rides every handshake — a client that surfaces server
 * instructions shows it even when the skill never landed.
 */
export const MCP_INSTRUCTIONS =
  "Luck Planner is the project's durable planning tree: leaves record facts, " +
  "bees record dependencies between them, bugs record incidents that block " +
  "leaves, and goals are plans a human approves. Read before writing — " +
  "luck_tree_get_context or luck_tree_search first — then record a fact as a " +
  "leaf when it changes, follow the leaf state machine (draft → ready → " +
  "claimed → in_progress → done), and never manage the tree by hand outside " +
  "these tools. Scope: one projectKey per session = the current workspace; " +
  "never enumerate other projectKeys unless the user explicitly asks. When to " +
  "write and what not to write is the luck-planner agent skill; this server is " +
  "how the writes happen.";

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "luck_tree_get_context",
    title: "Get tree context",
    description:
      "Orient yourself in the project tree. Without nodeId returns the " +
      "overview: roots (tech stacks) with their trunks. With nodeId returns " +
      "the path root → … → that node, its children, its sibling leaves, the " +
      "influence bees touching it, its blocking bugs and its growth " +
      "progress. Call this before descending into a subtree.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        nodeId: str("Node to open. Omit for the project overview."),
        sections: {
          type: "array",
          items: {
            type: "string",
            enum: [...CONTEXT_SECTIONS],
          },
          description:
            "Which blocks of a node answer to return. Omit for all of them; " +
            "[] returns only the node and its parentId. Ignored without nodeId.",
        },
        depth: {
          type: "number",
          description:
            "Overview only: levels to descend below each root, 1–3 " +
            "(default 1 = roots and their first level).",
        },
        limit: {
          type: "number",
          description:
            "Cap every listing (roots, children, siblings, bees, blocking " +
            "bugs) at 1–200 entries; unlimited by default. When a list is cut, " +
            "`truncated` reports how many entries were dropped.",
        },
      },
      required: ["projectKey"],
    },
  },
  {
    name: "luck_tree_search",
    title: "Search the tree",
    description:
      "Full-text search (FTS5, bm25-ranked) over node names, descriptions " +
      "and payloads of one project. Free text may carry key=value filters " +
      "(kind=leaf, status=in_progress); optional kinds/statuses arrays " +
      "AND with the text. Archived nodes are excluded unless asked for.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        query: str(
          'Free text, e.g. "billing retry". Empty returns the most recently updated nodes.',
        ),
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: ["root", "trunk", "branch", "subbranch", "leaf"],
          },
          description: "Restrict to these node kinds.",
        },
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "draft",
              "ready",
              "claimed",
              "in_progress",
              "blocked",
              "done",
              "cancelled",
              "superseded",
            ],
          },
          description: "Restrict to these leaf statuses.",
        },
        includeArchived: {
          type: "boolean",
          default: false,
          description: "Include soft-deleted (archived) nodes.",
        },
        limit: num("Max results (default 50, max 200)."),
      },
      required: ["projectKey", "query"],
    },
  },
  {
    name: "luck_tree_upsert_leaf",
    title: "Create or update a fact leaf",
    description:
      "Record a planned or confirmed fact. Without leafId creates a leaf " +
      "under parentId (name required, status defaults to draft); omitting " +
      "parentId is allowed only for the very first leaf of a fresh project, " +
      "which bootstraps the skeleton root → trunk → branch automatically. " +
      "With leafId updates that leaf: any of name/description/version/payload, " +
      "plus an optional status transition in the same call. payload carries " +
      "the plan/fact pair, version the fact/code version. Follow the leaf " +
      "state machine: draft → ready → claimed → in_progress → done.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        leafId: str("Existing leaf to update. Omit to create a new leaf."),
        parentId: str(
          "Branch/subbranch to create the new leaf under. Omit only for the first leaf of a fresh project (bootstraps the skeleton).",
        ),
        name: str("Leaf name (required when creating)."),
        description: str("Longer description of the fact."),
        version: str("Fact/code version this leaf describes."),
        payload: {
          type: "object",
          description:
            "JSON payload: plan/fact pair and anything else the fact carries.",
        },
        status: {
          type: "string",
          enum: [
            "draft",
            "ready",
            "claimed",
            "in_progress",
            "blocked",
            "done",
            "cancelled",
            "superseded",
          ],
          description:
            "Desired leaf status; applied as a state-machine transition when it differs from the current one.",
        },
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey"],
    },
  },
  {
    name: "luck_tree_upsert_node",
    title: "Create or update a node of any kind",
    description:
      "Shape the project's structure. Without nodeId creates a node of the " +
      "given kind (root, trunk, branch, subbranch) under parentId — the store " +
      "validates the parent/child kinds, so an impossible shape is refused " +
      "with the reason. With nodeId updates that node: name, description, " +
      "version, payload or status. This is how the auto-created skeleton " +
      "('Trunk', 'General') gets its real names, and how a project with " +
      "several functional areas gets a branch per area.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        nodeId: str("Existing node to update. Omit to create a new one."),
        kind: {
          type: "string",
          enum: ["root", "trunk", "branch", "subbranch", "leaf"],
          description: "Kind of the created node (ignored when updating).",
        },
        parentId: str(
          "Parent of the created node. Null is valid for a root only; omit to place it under the project's single root.",
        ),
        name: str("Node name (required when creating)."),
        description: str("Longer description of the node."),
        version: str("Version this node describes."),
        payload: {
          type: "object",
          description: "JSON payload the node carries.",
        },
        status: {
          type: "string",
          enum: [
            "draft",
            "ready",
            "claimed",
            "in_progress",
            "blocked",
            "done",
            "cancelled",
            "superseded",
          ],
          description: "Desired status (leaf state machine).",
        },
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey"],
    },
  },
  {
    name: "luck_tree_move_node",
    title: "Move a node to another parent",
    description:
      "Re-parent a node (with its whole subtree) — the way an agent moves a " +
      "fact into the branch it really belongs to when the project is " +
      "understood better. The store validates the new parent/child kinds and " +
      "refuses a move that would create a cycle.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        nodeId: str("The node to move."),
        newParentId: str("Its new parent."),
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "nodeId", "newParentId"],
    },
  },
  {
    name: "luck_tree_archive_node",
    title: "Archive a node and its subtree",
    description:
      "Soft-delete a node and everything below it: the rows stay in the " +
      "database and the audit trail keeps them, but the tree and every " +
      "diagram built from it stop showing them. The way an agent cleans up a " +
      "fact it wrote in the wrong place.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        nodeId: str("The node to archive."),
        reason: str("Why it is archived (kept in the audit trail)."),
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "nodeId"],
    },
  },
  {
    name: "luck_tree_add_bee",
    title: "Link two leaves (influence)",
    description:
      "Create a directed influence edge (a 'bee') from one live leaf to " +
      "another of the same project. Use impact to describe the influence " +
      "and its degree. Self-loops and duplicate edges are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        sourceLeafId: str("Leaf the influence spreads from."),
        targetLeafId: str("Leaf the influence lands on."),
        impact: str("Degree/description of the influence."),
        status: {
          type: "string",
          enum: ["active", "watching", "resolved", "cancelled"],
          description: "Initial bee status (default active).",
        },
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "sourceLeafId", "targetLeafId"],
    },
  },
  {
    name: "luck_tree_report_bug",
    title: "Report an incident",
    description:
      "Report a problem/incident ('bug') blocking work. Optionally attach " +
      "the leaves it blocks right away (nodeIds); more leaves can be " +
      "attached later. Open and investigating bugs surface as blockers in " +
      "the leaf details.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        title: str("Short incident title."),
        description: str("Full description: what is broken and why it blocks."),
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Triage severity.",
        },
        /** Initial status (defaults to `open`). */
        status: {
          type: "string",
          enum: ["open", "investigating", "resolved", "cancelled"],
          description: "Initial incident status (default open).",
        },
        nodeIds: strArray("Leaves this incident blocks right away."),
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "title", "severity"],
    },
  },
  {
    name: "luck_tree_find_bugs",
    title: "Find incidents of a project",
    description:
      "List bugs (incidents) of the project, optionally filtered by status. " +
      "Use it to discover what requires attention: open bugs are work to do, " +
      "resolved/cancelled ones are processed.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        status: {
          type: "string",
          enum: ["open", "investigating", "resolved", "cancelled"],
          description:
            "Filter by bug status. Omit to return every incident of the project.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of incidents to return (default 50, max 200).",
        },
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey"],
    },
  },
  {
    name: "luck_tree_find_goals",
    title: "Find goals of a project",
    description:
      "List high goals of the project, optionally filtered by status. " +
      "Use it to discover planned and approved work: proposed goals await " +
      "human approval, approved goals are materialized in the tree.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        status: {
          type: "string",
          enum: [
            "draft",
            "proposed",
            "approved",
            "in_progress",
            "done",
            "cancelled",
            "superseded",
          ],
          description:
            "Filter by goal status. Omit to return every goal of the project.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of goals to return (default 50, max 200).",
        },
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey"],
    },
  },
  {
    name: "luck_tree_approve_goal",
    title: "Approve a high goal",
    description:
      "Cross the approval gate and materialize the goal's subtree in the tree. " +
      "Only a `proposed` goal may be approved; approval creates a side branch " +
      "and one leaf per plan step. ADR-7: this is the human's approval gate.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        goalId: str("Goal to approve."),
        /** Live branch (or subbranch) the goal's side branch grows under. */
        parentBranchId: str(
          "Branch under which the goal's side branch will grow.",
        ),
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "goalId", "parentBranchId"],
    },
  },
  {
    name: "luck_tree_set_goal",
    title: "Manage a high goal (pre-approval)",
    description:
      "Manage a high goal BEFORE the approval gate: create a draft " +
      "(formalText + plan), update a draft/proposed plan, or propose it for " +
      "human review. There is deliberately no approve action — only a human " +
      "or the managing agent approves through the native panel, and only " +
      "an approved plan grows into the tree.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        action: {
          type: "string",
          enum: ["create", "update", "propose"],
          description: "create: new draft; update: edit; propose: draft → proposed.",
        },
        goalId: str("Goal to update or propose (required for update/propose)."),
        formalText: str("The formal natural-language task (required for create)."),
        plan: {
          type: "array",
          items: {
            type: "object",
            description:
              "Atomic plan step: { id, title, description }. Required for create.",
          },
          description: "The agent's broken-down plan.",
        },
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "action"],
    },
  },
  {
    name: "luck_tree_update_growth",
    title: "Update growth progress",
    description:
      "Upsert the progress record of one subject (any node or a goal). " +
      "With growthId updates that record; otherwise resolves the subject's " +
      "record — updating it when one exists, attaching a fresh one (steps " +
      "required) when none does. Each step carries state, facts and a " +
      "reason; status follows active/stalled/done/cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        subjectType: {
          type: "string",
          enum: ["node", "goal"],
          description: "What the progress record is attached to.",
        },
        subjectId: str("Node or goal id the progress belongs to."),
        growthId: str("Explicit record to update. Omit to resolve by subject."),
        steps: {
          type: "array",
          items: {
            type: "object",
            description:
              "Progress step: { id, title, state, facts: string[], reason }.",
          },
          description: "The whole ordered step array (replace semantics).",
        },
        status: {
          type: "string",
          enum: ["active", "stalled", "done", "cancelled"],
          description: "Record lifecycle status.",
        },
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "subjectType", "subjectId"],
    },
  },
  {
    name: "luck_tree_history",
    title: "Read the audit trail",
    description:
      "The append-only audit trail of one entity (node, bee, bug, goal or " +
      "growth), oldest first: who did what, when, with which revision and " +
      "result. Use it to reconstruct how a fact got its current state.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        entityId: str("Entity id (node/bee/bug/goal/growth)."),
      },
      required: ["projectKey", "entityId"],
    },
  },
  {
    name: "luck_tree_export",
    title: "Export a project",
    description:
      "Write one project to a portable `.json.zip`: the whole tree (archived " +
      "nodes flagged, not dropped), influence bees, incidents with their leaf " +
      "attachments, goals, growth records and — by default — the audit trail. " +
      "The document is versioned and carries the original ids, which is what a " +
      "later import needs to verify its references before rebuilding the graph. " +
      "Omit `path` to land in the plugin's `backups/` directory under a " +
      "date-stamped name; a `path` must be absolute.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        includeHistory: {
          type: "boolean",
          description:
            "Carry the audit trail (default true). Turn it off for a tree-only copy.",
        },
        path: {
          type: "string",
          description:
            "Absolute path of the archive. Omit for `backups/` beside the plugin database.",
        },
      },
      required: ["projectKey"],
    },
  },
  {
    name: "luck_tree_import",
    title: "Import a project",
    description:
      "Read a `.json.zip` export written by `luck_tree_export` (or an " +
      "extracted `.json`) and rebuild that project in this database: the tree " +
      "with every parent edge rebuilt on fresh ids, influence bees, incidents " +
      "with their leaf attachments, goals (with their materialized subtree), " +
      "growth records and the audit trail. Every reference is verified before " +
      "a row is written — one root, parents present, kinds allowed under their " +
      "parent, bees and bugs on leaves — and a refused import leaves the " +
      "database untouched. The target project must be empty (a project holds " +
      "one tree). " +
      "`dryRun` defaults to true: the first call reports the counts and writes " +
      "nothing, so set `dryRun: false` to actually import.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: PROJECT_KEY,
        file: {
          type: "string",
          description:
            "Absolute path of the export archive or of an extracted .json.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Validate and report without writing (default true). Pass false to import.",
        },
        includeArchived: {
          type: "boolean",
          description:
            "Carry soft-deleted nodes (default true). False imports only live rows and the links that stay valid.",
        },
        includeHistory: {
          type: "boolean",
          description:
            "Carry the audit trail when the file holds one (default true).",
        },
      },
      required: ["projectKey", "file"],
    },
  },
];

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(result: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function error(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Zod issue list → one readable line. */
function invalidInput(issues: ReadonlyArray<{
  path: PropertyKey[];
  message: string;
}>): ToolResult {
  return error(
    `Invalid input: ${issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ")}`,
  );
}

/** Compact node summary used in context listings. */
function nodeSummary(node: Node): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    status: node.status,
    version: node.version,
    revision: node.revision,
  };
}

export interface McpDispatchContext {
  store: LuckPlannerStore;
  /** Actor stamped into the audit trail when a tool call omits one. */
  defaultActor?: string;
}

/**
 * Dispatches one tool call. Never throws: validation failures, unknown
 * tools and store errors all come back as `isError` results with a
 * readable message — the stdio server maps them onto JSON-RPC responses.
 */
export function dispatchMcpTool(
  name: string,
  args: unknown,
  context: McpDispatchContext,
): ToolResult {
  const { store } = context;
  const input = (args ?? {}) as Record<string, unknown>;
  const actor =
    (typeof input.actor === "string" && input.actor.trim()) ||
    context.defaultActor ||
    "agent:unknown";

  // Some hosts prefix tool names with the server name.
  const normalizedName = name.replace(/^luck[-_]planner_/, "");

  try {
    switch (normalizedName) {
      case "luck_tree_get_context": {
        const parsed = getContextInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        return dispatchGetContext(store, parsed.data);
      }

      case "luck_tree_search": {
        const parsed = searchInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: SearchInput = parsed.data;
        const hits = store.search(value.query, {
          projectKey: value.projectKey,
          kinds: value.kinds,
          statuses: value.statuses,
          includeArchived: value.includeArchived,
          limit: value.limit,
        });
        return text({
          matches: hits.length,
          results: hits.map((hit) => ({
            ...nodeSummary(hit.node),
            parentId: hit.node.parentId,
            score: hit.score,
            snippet: hit.snippet,
          })),
        });
      }

      case "luck_tree_upsert_leaf": {
        const parsed = upsertLeafInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        return dispatchUpsertLeaf(store, parsed.data, actor);
      }

      case "luck_tree_upsert_node": {
        const parsed = upsertNodeInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: UpsertNodeInput = parsed.data;
        if (value.nodeId !== undefined) {
          // Update: the mutable fields of an existing node, plus an optional
          // status transition (the leaf state machine).
          const updated = store.updateNode({
            projectKey: value.projectKey,
            id: value.nodeId,
            ...(value.name === undefined ? {} : { name: value.name }),
            ...(value.description === undefined ? {} : { description: value.description }),
            ...(value.version === undefined ? {} : { version: value.version }),
            ...(value.payload === undefined ? {} : { payload: value.payload }),
            actor,
          });
          const node =
            value.status === undefined
              ? updated
              : store.setStatus({
                  projectKey: value.projectKey,
                  id: value.nodeId,
                  status: value.status,
                  actor,
                });
          return text({ created: false, node });
        }
        // Create: a node of any kind, with the store's kind validation.
        if (value.kind === undefined) {
          return invalidInput([
            {
              path: ["kind"],
              message: "kind is required when creating a node",
            },
          ]);
        }
        if (value.name === undefined) {
          return invalidInput([
            {
              path: ["name"],
              message: "name is required when creating a node",
            },
          ]);
        }
        const parentId =
          value.parentId === undefined
            ? defaultParentId(store, value.projectKey, value.kind)
            : value.parentId;
        const node = store.createNode({
          projectKey: value.projectKey,
          parentId,
          kind: value.kind,
          name: value.name,
          ...(value.description === undefined ? {} : { description: value.description }),
          ...(value.status === undefined ? {} : { status: value.status }),
          ...(value.version === undefined ? {} : { version: value.version }),
          ...(value.payload === undefined ? {} : { payload: value.payload }),
          actor,
        });
        return text({ created: true, node });
      }

      case "luck_tree_move_node": {
        const parsed = moveNodeInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: MoveNodeInput = parsed.data;
        const node = store.moveNode({
          projectKey: value.projectKey,
          id: value.nodeId,
          newParentId: value.newParentId,
          actor,
        });
        return text({ node });
      }

      case "luck_tree_archive_node": {
        const parsed = archiveNodeInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: ArchiveNodeInput = parsed.data;
        const archived = store.archiveNode({
          projectKey: value.projectKey,
          id: value.nodeId,
          actor,
        });
        return text({ archived });
      }

      case "luck_tree_add_bee": {
        const parsed = addBeeInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: AddBeeInput = parsed.data;
        const bee = store.createBee({
          projectKey: value.projectKey,
          sourceLeafId: value.sourceLeafId,
          targetLeafId: value.targetLeafId,
          impact: value.impact,
          status: value.status,
          actor,
        });
        return text({ bee });
      }

      case "luck_tree_report_bug": {
        const parsed = reportBugInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: ReportBugInput = parsed.data;
        const bug = store.createBug({
          projectKey: value.projectKey,
          title: value.title,
          description: value.description,
          severity: value.severity,
          status: value.status,
          nodeIds: value.nodeIds,
          actor,
        });
        return text({ bug, blockedLeaves: value.nodeIds?.length ?? 0 });
      }

      case "luck_tree_find_bugs": {
        const parsed = findBugsInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: FindBugsInput = parsed.data;
        const all = store.listBugs(value.projectKey);
        const filtered =
          value.status === undefined
            ? all
            : all.filter((bug) => bug.status === value.status);
        const limited = filtered.slice(0, value.limit ?? 50);
        return text({
          bugs: limited.map((bug) => ({
            id: bug.id,
            title: bug.title,
            severity: bug.severity,
            status: bug.status,
            revision: bug.revision,
            updatedAt: bug.updatedAt,
            updatedBy: bug.updatedBy,
          })),
          total: filtered.length,
          returned: limited.length,
        });
      }

      case "luck_tree_find_goals": {
        const parsed = findGoalsInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: FindGoalsInput = parsed.data;
        const all = store.listGoals(value.projectKey);
        const filtered =
          value.status === undefined
            ? all
            : all.filter((goal) => goal.status === value.status);
        const limited = filtered.slice(0, value.limit ?? 50);
        return text({
          goals: limited.map((goal) => ({
            id: goal.id,
            formalText: goal.formalText,
            status: goal.status,
            revision: goal.revision,
            materializedNodeId: goal.materializedNodeId,
            planSteps: goal.plan.length,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
          })),
          total: filtered.length,
          returned: limited.length,
        });
      }

      case "luck_tree_approve_goal": {
        const parsed = approveGoalInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: ApproveGoalInput = parsed.data;
        const goal = store.approveGoal({
          projectKey: value.projectKey,
          id: value.goalId,
          parentBranchId: value.parentBranchId,
          actor: value.actor ?? actor,
        });
        return text({
          goal: {
            id: goal.id,
            formalText: goal.formalText,
            status: goal.status,
            revision: goal.revision,
            materializedNodeId: goal.materializedNodeId,
          },
        });
      }

      case "luck_tree_set_goal": {
        const parsed = setGoalInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        return dispatchSetGoal(store, parsed.data, actor);
      }

      case "luck_tree_update_growth": {
        const parsed = updateGrowthInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        return dispatchUpdateGrowth(store, parsed.data, actor);
      }

      case "luck_tree_export": {
        const parsed = exportInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        return dispatchExport(store, parsed.data);
      }

      case "luck_tree_import": {
        const parsed = importInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        return dispatchImport(store, parsed.data, actor);
      }

      case "luck_tree_history": {
        const parsed = historyInputSchema.safeParse(input);
        if (!parsed.success) return invalidInput(parsed.error.issues);
        const value: HistoryInput = parsed.data;
        const entries = store.listHistory(value.projectKey, value.entityId);
        return text({
          entityId: value.entityId,
          entries: entries.map((entry) => ({
            id: entry.id,
            entityType: entry.entityType,
            action: entry.action,
            revision: entry.revision,
            actor: entry.actor,
            result: entry.result,
            at: entry.at,
          })),
        });
      }

      default:
        return error(
          `Unknown tool: ${name}. Available tools: ${MCP_TOOLS.map((tool) => tool.name).join(", ")}`,
        );
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return error(message);
  }
}

/**
 * Export: write the archive and answer where it landed and what it holds.
 *
 * The counts are the point of the reply — an agent reporting "exported the
 * project" that silently wrote four nodes instead of four hundred is worse
 * than no report. The document itself is not echoed: it is the file.
 */
function dispatchExport(
  store: LuckPlannerStore,
  value: ExportInput,
): ToolResult {
  const written = writeExportFile(store, {
    projectKey: value.projectKey,
    pluginVersion: resolvePluginVersion(),
    ...(value.includeHistory === undefined
      ? {}
      : { includeHistory: value.includeHistory }),
    ...(value.path === undefined ? {} : { file: value.path }),
  });
  return text({
    created: true,
    file: written.file,
    bytes: written.bytes,
    projectKey: value.projectKey,
    exportedAt: written.document.exportedAt,
    counts: exportCounts(written.document),
  });
}

/**
 * Import: plan always, write only when the caller said `dryRun: false`.
 *
 * The default is the read-only half on purpose — a tool call that adds a whole
 * tree is worth one extra round trip, and the dry run's counts are the
 * argument for the second call.
 */
function dispatchImport(
  store: LuckPlannerStore,
  value: ImportInput,
  actor: string,
): ToolResult {
  const report = runImport(store, {
    file: value.file,
    projectKey: value.projectKey,
    ...(value.includeArchived === undefined
      ? {}
      : { includeArchived: value.includeArchived }),
    ...(value.includeHistory === undefined
      ? {}
      : { includeHistory: value.includeHistory }),
    dryRun: value.dryRun ?? true,
    actor,
  });
  return text({
    dryRun: report.dryRun,
    imported: !report.dryRun,
    file: report.file,
    projectKey: report.projectKey,
    source: report.source,
    counts: report.counts,
    warnings: report.warnings,
    ...(report.dryRun
      ? { hint: "nothing was written; call again with dryRun: false to import" }
      : {}),
  });
}

/** Context: overview without nodeId, deep open with nodeId. */
function dispatchGetContext(
  store: LuckPlannerStore,
  value: GetContextInput,
): ToolResult {
  const limit = value.limit;
  if (value.nodeId === undefined) {
    // `depth` only means something for the overview: 1 is the classic
    // "roots and their first level", each extra level descends one more.
    const depth = value.depth ?? 1;
    const roots = capList(store.listChildren(value.projectKey, null), limit);
    const answer: Record<string, unknown> = {
      mode: "overview",
      projectKey: value.projectKey,
      roots: roots.items.map((root) =>
        overviewEntry(store, value.projectKey, root, depth, limit),
      ),
    };
    if (roots.dropped > 0) answer.truncated = { roots: roots.dropped };
    return text(answer);
  }

  const node = store.getNode(value.projectKey, value.nodeId);
  if (!node) {
    return error(
      `node ${value.nodeId} not found in project ${value.projectKey}`,
    );
  }
  // A missing `sections` keeps the pre-L1 answer byte for byte; an explicit
  // list (including an empty one) selects blocks, so the omitted keys are
  // exactly the sections the caller did not ask for.
  const wanted =
    value.sections === undefined ? null : new Set(value.sections);
  const wants = (section: ContextSection): boolean =>
    wanted === null || wanted.has(section);

  const answer: Record<string, unknown> = {
    mode: "node",
    projectKey: value.projectKey,
    node: nodeSummary(node),
    parentId: node.parentId,
  };
  const truncated: Record<string, number> = {};
  const keep = <T>(
    section: ContextSection,
    items: readonly T[],
  ): T[] | undefined => {
    if (!wants(section)) return undefined;
    const capped = capList(items, limit);
    if (capped.dropped > 0) truncated[section] = capped.dropped;
    return capped.items;
  };

  const path = keep(
    "path",
    store.getNodePath(value.projectKey, node.id).map(nodeSummary),
  );
  if (path !== undefined) answer.path = path;

  const children = keep(
    "children",
    store.listChildren(value.projectKey, node.id).map(nodeSummary),
  );
  if (children !== undefined) answer.children = children;

  if (wants("siblings")) {
    const all =
      node.parentId === null
        ? []
        : store
            .listChildren(value.projectKey, node.parentId)
            .filter((sibling) => sibling.id !== node.id)
            .map(nodeSummary);
    const siblings = keep("siblings", all);
    if (siblings !== undefined) answer.siblings = siblings;
  }

  if (wants("bees")) {
    const bees = keep("bees", store.listBeesForNode(value.projectKey, node.id));
    if (bees !== undefined) answer.bees = bees;
  }

  if (wants("blockingBugs")) {
    const blockingBugs = keep(
      "blockingBugs",
      store.listBlockingBugs(value.projectKey, node.id),
    );
    if (blockingBugs !== undefined) answer.blockingBugs = blockingBugs;
  }

  if (wants("growth")) {
    answer.growth = store.getGrowthProgress(value.projectKey, "node", node.id);
  }

  if (Object.keys(truncated).length > 0) answer.truncated = truncated;
  return text(answer);
}

/** One overview node: a summary, plus `children` while `levels` allows. */
function overviewEntry(
  store: LuckPlannerStore,
  projectKey: string,
  node: Node,
  levels: number,
  limit: number | undefined,
): Record<string, unknown> {
  const entry = nodeSummary(node);
  if (levels <= 0) return entry;
  const children = capList(store.listChildren(projectKey, node.id), limit);
  if (children.dropped > 0) entry.omittedChildren = children.dropped;
  entry.children = children.items.map((child) =>
    levels === 1
      ? nodeSummary(child)
      : overviewEntry(store, projectKey, child, levels - 1, limit),
  );
  return entry;
}

/** Caps a listing at `limit`, reporting how many entries were dropped. */
function capList<T>(
  items: readonly T[],
  limit: number | undefined,
): { items: T[]; dropped: number } {
  if (limit === undefined || items.length <= limit) {
    return { items: [...items], dropped: 0 };
  }
  return { items: items.slice(0, limit), dropped: items.length - limit };
}

/** Upsert semantics: create under parentId, or update leafId in place. */
function dispatchUpsertLeaf(
  store: LuckPlannerStore,
  value: UpsertLeafInput,
  actor: string,
): ToolResult {
  if (value.leafId !== undefined) {
    const existing = store.getNode(value.projectKey, value.leafId);
    if (!existing) {
      return error(
        `leaf ${value.leafId} not found in project ${value.projectKey}`,
      );
    }
    if (existing.kind !== "leaf") {
      return error(
        `node ${value.leafId} is a ${existing.kind}, not a leaf; upsert_leaf only edits leaves`,
      );
    }
    const wantsEdit =
      value.name !== undefined ||
      value.description !== undefined ||
      value.version !== undefined ||
      value.payload !== undefined;
    let leaf: Node = existing;
    if (wantsEdit) {
      leaf = store.updateNode({
        projectKey: value.projectKey,
        id: value.leafId,
        name: value.name,
        description: value.description,
        version: value.version,
        payload: value.payload,
        actor,
      });
    }
    // Upsert semantics: stating the current status is a tolerated no-op,
    // a real transition runs the state machine (and its audit row).
    if (value.status !== undefined && leaf.status !== value.status) {
      leaf = store.setStatus({
        projectKey: value.projectKey,
        id: value.leafId,
        status: value.status,
        actor,
      });
    }
    return text({ created: false, leaf });
  }

  let parentId: string;
  if (value.parentId !== undefined) {
    parentId = value.parentId;
  } else {
    // Bootstrap: no tool creates roots or branches, so the very first leaf
    // of a fresh project creates the minimal skeleton itself (the store
    // re-checks emptiness inside its write transaction, so racing agents
    // cannot both bootstrap). Every later leaf must name its parent.
    if (store.listChildren(value.projectKey, null).length > 0) {
      return error(
        "parentId is required when the project already has a tree — call " +
          "luck_tree_get_context and pass the parentId of a branch or subbranch " +
          "(only the very first leaf may omit it)",
      );
    }
    parentId = store.ensureSkeletonBranch({
      projectKey: value.projectKey,
      actor,
    }).id;
  }
  if (value.name === undefined) {
    return error("name is required when creating a leaf (leafId omitted)");
  }
  const leaf = store.createNode({
    projectKey: value.projectKey,
    parentId,
    kind: "leaf",
    name: value.name,
    description: value.description,
    version: value.version,
    payload: value.payload,
    status: value.status ?? "draft",
    actor,
  });
  return text({ created: true, leaf });
}

/** Goal management, strictly on the pre-approval side of the gate. */
function dispatchSetGoal(
  store: LuckPlannerStore,
  value: SetGoalInput,
  actor: string,
): ToolResult {
  switch (value.action) {
    case "create": {
      if (value.formalText === undefined) {
        return error("formalText is required for action=create");
      }
      if (value.plan === undefined) {
        return error("plan is required for action=create");
      }
      const goal = store.createGoal({
        projectKey: value.projectKey,
        formalText: value.formalText,
        plan: value.plan,
        actor,
      });
      return text({
        goal,
        note: "The goal is a draft and is NOT in the tree yet. Propose it when the plan is ready; only a human approves.",
      });
    }
    case "update": {
      if (value.goalId === undefined) {
        return error("goalId is required for action=update");
      }
      if (value.formalText === undefined && value.plan === undefined) {
        return error("action=update requires at least one of: formalText, plan");
      }
      const goal = store.updateGoal({
        projectKey: value.projectKey,
        id: value.goalId,
        formalText: value.formalText,
        plan: value.plan,
        actor,
      });
      return text({ goal });
    }
    case "propose": {
      if (value.goalId === undefined) {
        return error("goalId is required for action=propose");
      }
      const goal = store.setGoalStatus({
        projectKey: value.projectKey,
        id: value.goalId,
        status: "proposed",
        actor,
      });
      return text({
        goal,
        note: "Proposed. A human (or the managing agent) approves it through the native panel; approval materializes the plan into the tree.",
      });
    }
  }
}

/**
 * Upsert of a subject's progress record: explicit growthId wins, otherwise
 * the subject's existing record is updated or a fresh one is attached.
 */
function dispatchUpdateGrowth(
  store: LuckPlannerStore,
  value: UpdateGrowthInput,
  actor: string,
): ToolResult {
  if (value.growthId !== undefined) {
    const growth = store.updateGrowth({
      projectKey: value.projectKey,
      id: value.growthId,
      steps: value.steps,
      status: value.status,
      actor,
    });
    return text({ created: false, growth });
  }
  const existing = store.getGrowthForSubject(
    value.projectKey,
    value.subjectType,
    value.subjectId,
  );
  if (existing) {
    if (value.steps === undefined && value.status === undefined) {
      return error(
        `growth for ${value.subjectType} ${value.subjectId} already exists (${existing.id}); pass steps and/or status to update it`,
      );
    }
    const growth = store.updateGrowth({
      projectKey: value.projectKey,
      id: existing.id,
      steps: value.steps,
      status: value.status,
      actor,
    });
    return text({ created: false, growth });
  }
  if (value.steps === undefined) {
    return error(
      `no growth record for ${value.subjectType} ${value.subjectId} yet; steps are required to attach one`,
    );
  }
  const growth = store.createGrowth({
    projectKey: value.projectKey,
    subjectType: value.subjectType,
    subjectId: value.subjectId,
    steps: value.steps,
    status: value.status,
    actor,
  });
  return text({ created: true, growth });
}
