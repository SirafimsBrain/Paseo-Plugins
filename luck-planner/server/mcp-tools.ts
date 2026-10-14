import type { Node } from "../shared/tree";
import type { GrowthProgress } from "./store";
import type {
  AddBeeInput,
  GetContextInput,
  HistoryInput,
  ReportBugInput,
  SearchInput,
  SetGoalInput,
  UpdateGrowthInput,
  UpsertLeafInput,
} from "../shared/tools";
import {
  addBeeInputSchema,
  getContextInputSchema,
  historyInputSchema,
  reportBugInputSchema,
  searchInputSchema,
  setGoalInputSchema,
  updateGrowthInputSchema,
  upsertLeafInputSchema,
} from "../shared/tools";
import type { LuckPlannerStore } from "./store";

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
  "Canonical absolute path of the project this call addresses. Every read and write is scoped by it.",
);

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
        nodeIds: strArray("Leaves this incident blocks right away."),
        actor: str("Who performs the change (agent id)."),
      },
      required: ["projectKey", "title", "severity"],
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
          nodeIds: value.nodeIds,
          actor,
        });
        return text({ bug, blockedLeaves: value.nodeIds?.length ?? 0 });
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

/** Context: overview without nodeId, deep open with nodeId. */
function dispatchGetContext(
  store: LuckPlannerStore,
  value: GetContextInput,
): ToolResult {
  if (value.nodeId === undefined) {
    const roots = store.listChildren(value.projectKey, null);
    return text({
      mode: "overview",
      projectKey: value.projectKey,
      roots: roots.map((root) => ({
        ...nodeSummary(root),
        children: store
          .listChildren(value.projectKey, root.id)
          .map(nodeSummary),
      })),
    });
  }

  const node = store.getNode(value.projectKey, value.nodeId);
  if (!node) {
    return error(
      `node ${value.nodeId} not found in project ${value.projectKey}`,
    );
  }
  const path = store.getNodePath(value.projectKey, node.id).map(nodeSummary);
  const children = store
    .listChildren(value.projectKey, node.id)
    .map(nodeSummary);
  const siblings =
    node.parentId === null
      ? []
      : store
          .listChildren(value.projectKey, node.parentId)
          .filter((sibling) => sibling.id !== node.id)
          .map(nodeSummary);
  const bees = store.listBeesForNode(value.projectKey, node.id);
  const blockingBugs = store.listBlockingBugs(value.projectKey, node.id);
  const growth: GrowthProgress | null = store.getGrowthProgress(
    value.projectKey,
    "node",
    node.id,
  );
  return text({
    mode: "node",
    projectKey: value.projectKey,
    node: nodeSummary(node),
    parentId: node.parentId,
    path,
    children,
    siblings,
    bees,
    blockingBugs,
    growth,
  });
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
