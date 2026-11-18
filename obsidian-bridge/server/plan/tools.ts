import type { RuntimeSettings } from "../../shared/settings";
import type { McpToolDefinition, ToolOutcome } from "../mcp-tools";
import { planGoal } from "./goal";
import { planGrowth } from "./growth";
import { planImport } from "./import";
import { planIncident } from "./incident";
import { planLink } from "./links";
import { planApproveGoal, planArchiveNode, planMoveNode } from "./ops";
import { planRestore } from "./restore";
import { planValidate } from "./validate";
import { planReadTool } from "./read";
import { planSearch } from "./search";
import { planScopeTool } from "./scope";
import { planCreateNode, planHistory, planSetStatus, planUpdateNode } from "./write";

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
  "Planning tool for the project plan inside the Paseo project folder under the configured " +
  "planning directory (`planRoot/<project>`): use it for plan nodes, incidents and goals — not " +
  "to record agent memory (memory-flash) and not as a general note search (obsidian_search). " +
  "Paths are relative to the project folder, shared by all of its workspaces; the calling " +
  "workspace is recorded in the plan YAML as `workspace_id`. Another project, `__history` and " +
  "`_archive` are unreachable from here.";

const EXPECTED_REVISION = {
  type: "number",
  description:
    "Revision you read (`revision` from plan_read). A different revision on disk refuses the write.",
} as const;

const ACCEPT_EXTERNAL = {
  type: "boolean",
  description:
    "Allow writing over a file changed outside the tools (a manual Obsidian edit). Without it such a write is refused.",
} as const;

const ACTOR = {
  type: "string",
  description: "Who performs the change: an agent id or `user`. Defaults to `agent`.",
} as const;

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
  {
    name: "plan_create_node",
    title: "Create a plan node",
    description:
      `${PLAN_CONTRACT_SENTENCE} Creates one node of the plan tree (root, trunk, branch, ` +
      "subbranch or leaf) as its own note with `version: 1`, `revision: 1`, adds it to the " +
      "parent's `children` and writes the journal. A node file lives in its own folder " +
      "(`auth/auth.md`); a leaf lives in its parent's folder (`auth/session-store.md`). It " +
      "never overwrites an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Node path relative to the planning root. A branch is its folder (`centurion/backend/auth`); " +
            "a leaf is a name inside the parent's folder (`centurion/backend/auth/session-store`).",
        },
        kind: {
          type: "string",
          enum: ["root", "trunk", "branch", "subbranch", "leaf"],
          description: "Node kind. The parent must allow it (root→trunk→branch→subbranch|leaf).",
        },
        name: { type: "string", description: "Human-readable name shown in the tree." },
        description: { type: "string", description: "One or two sentences: what this node is." },
        parent: {
          type: "string",
          description:
            "Parent node path or wikilink. When omitted it is inferred from the path's folder; " +
            "a root has no parent.",
        },
        status: { type: "string", description: "Initial status; default `draft`." },
        brief: { type: "object", description: "Leaf brief (entryPoint, steps, files, acceptance, source)." },
        payload: { type: "object", description: "Kind-specific data kept as YAML." },
        stack: { type: "array", description: "Root only: the technology stack entries." },
        notes: { type: "string", description: "Free text for the `## Заметки` section." },
        aliases: { type: "array", description: "Additional aliases for Obsidian links." },
        id: { type: "string", description: "Explicit id (used by import); a UUID is generated otherwise." },
        project_key: { type: "string", description: "Root only: the canonical project path." },
        actor: ACTOR,
      },
      required: ["path", "kind", "name"],
    },
  },
  {
    name: "plan_update_node",
    title: "Update a plan node",
    description:
      `${PLAN_CONTRACT_SENTENCE} Changes the content of one node: description, name, brief, ` +
      "payload, `## Заметки`, or its kind. A snapshot of the previous state is written to " +
      "`__history` first; a content change raises `revision` by one, a kind change raises " +
      "`version` and resets `revision` to 1. A stale `expected_revision` or a manual edit on " +
      "disk refuses the write instead of overwriting it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Node path relative to the planning root." },
        description: { type: "string", description: "New short description." },
        name: { type: "string", description: "New name." },
        brief: { type: "object", description: "Replacement leaf brief, or null to remove it." },
        payload: { type: "object", description: "Replacement payload, or null to remove it." },
        notes: { type: "string", description: "Replacement text for `## Заметки`." },
        kind: {
          type: "string",
          enum: ["root", "trunk", "branch", "subbranch", "leaf"],
          description: "New kind. Raises version and resets revision; refused when children would not fit.",
        },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path"],
    },
  },
  {
    name: "plan_set_status",
    title: "Move a plan node through its lifecycle",
    description:
      `${PLAN_CONTRACT_SENTENCE} Performs exactly one allowed status transition on a node, ` +
      "incident or goal. An illegal transition writes nothing and lists the allowed targets. " +
      "A status set by the user can be overridden by an agent only with `reason`, which is " +
      "recorded in the journal. The previous state is snapshotted first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Node path relative to the planning root." },
        status: {
          type: "string",
          description:
            "Target status: draft, ready, claimed, in_progress, blocked, deferred, done, " +
            "cancelled, superseded (nodes); open, investigating, resolved, cancelled (incidents); " +
            "draft, proposed, approved, in_progress, done, cancelled, superseded (goals).",
        },
        reason: { type: "string", description: "Why the change happened; required to override a user-set status." },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path", "status"],
    },
  },
  {
    name: "plan_history",
    title: "List or read plan snapshots",
    description:
      `${PLAN_CONTRACT_SENTENCE} Lists the snapshots of one node (version, revision, reason, ` +
      "time, actor) or reads one of them. This is the only tool that reads `__history`: a " +
      "snapshot is immutable, and restoring one is `plan_restore`, not an edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The live node path whose history you want." },
        version: { type: "number", description: "With `revision`: read that snapshot." },
        revision: { type: "number", description: "With `version`: read that snapshot." },
        limit: { type: "number", description: "How many of the latest snapshots to list, 1–200 (default 50)." },
      },
      required: ["path"],
    },
  },
  {
    name: "plan_link",
    title: "Link two leaves with an influence",
    description:
      `${PLAN_CONTRACT_SENTENCE} Creates, updates or removes one influence (a bee) from ` +
      "`source` onto `target`. Both ends must be leaves of the same project and cannot be the " +
      "same leaf. Only the source stores the edge; Obsidian shows the reverse direction as a " +
      "backlink, so the two sides cannot disagree. A cycle is allowed and reported by " +
      "`plan_read` as `beeCycle`.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The influencing leaf (holds the edge)." },
        target: { type: "string", description: "The influenced leaf." },
        status: {
          type: "string",
          description: "active, watching, resolved, cancelled; default `active` when created.",
        },
        impact: { type: "string", description: "What the influence means for the target." },
        remove: { type: "boolean", description: "Drop the edge instead of writing it." },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["source", "target"],
    },
  },
  {
    name: "plan_incident",
    title: "Create or update an incident",
    description:
      `${PLAN_CONTRACT_SENTENCE} Creates an incident in '<project>/_incidents/<slug>' or updates ` +
      "an existing one, and keeps `blocks:` (the incident) and `blocked_by:` (each leaf) in " +
      "sync in both directions. Only `open` and `investigating` incidents block their leaves. " +
      "The status itself moves through `plan_set_status`.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "`<project>/_incidents/<slug>`; the file is created when it does not exist.",
        },
        name: { type: "string", description: "Incident title; required when creating." },
        description: { type: "string", description: "What goes wrong, in one or two sentences." },
        severity: { type: "string", description: "low, medium, high, critical; default `medium`." },
        status: {
          type: "string",
          description: "Creation only: open, investigating, resolved, cancelled (default `open`).",
        },
        project: {
          type: "string",
          description: "Project root path or link; inferred from the path's first folder.",
        },
        blocks: { type: "array", description: "Leaf paths this incident blocks." },
        unblock: { type: "array", description: "Leaf paths to detach from this incident." },
        notes: { type: "string", description: "Replacement text for `## Заметки`." },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path"],
    },
  },
  {
    name: "plan_goal",
    title: "Create, update or propose a goal",
    description:
      `${PLAN_CONTRACT_SENTENCE} Authors a goal in '<project>/_goals/<slug>': \`create\` writes ` +
      "it as `draft` with its steps, `update` changes the formal text or the steps, `propose` " +
      "moves a draft to `proposed` for a human to approve. Approval and materialisation are " +
      "`plan_approve_goal`, never this tool.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "propose"],
          description: "What to do with the goal; default `create`.",
        },
        path: { type: "string", description: "`<project>/_goals/<slug>` relative to the planning root." },
        name: { type: "string", description: "Goal title; required when creating." },
        formal_text: { type: "string", description: "The formal statement of the goal." },
        plan: {
          type: "array",
          description: "Steps as objects `{id?, title, description?}` or plain titles; null clears them.",
        },
        project: {
          type: "string",
          description: "Project root path or link; inferred from the path's first folder.",
        },
        notes: { type: "string", description: "Replacement text for `## Заметки`." },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path"],
    },
  },
  {
    name: "plan_growth",
    title: "Record progress on a node or goal",
    description:
      `${PLAN_CONTRACT_SENTENCE} Upserts the \`growth:\` record of one node or goal: status, ` +
      "summary, progress and steps. Steps merge by title, so re-recording a step updates it " +
      "instead of duplicating it; `replace: true` starts the list over. A snapshot of the " +
      "previous state is written first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The node or goal whose growth you record." },
        status: { type: "string", description: "active, stalled, done, cancelled." },
        summary: { type: "string", description: "One sentence about where the work stands." },
        progress: { type: "number", description: "0–100, an integer percentage." },
        steps: {
          type: "array",
          description:
            "Steps as objects `{title, state?, note?, at?}` or titles; `state` is pending, " +
            "in_progress, completed, skipped or failed.",
        },
        replace: { type: "boolean", description: "Replace the step list instead of merging by title." },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path"],
    },
  },
  {
    name: "plan_move_node",
    title: "Move a plan subtree",
    description:
      `${PLAN_CONTRACT_SENTENCE} Moves one node and its subtree (or one leaf) to a new path inside ` +
      "the planning root, rewrites every link into the moved files (`parent`, `children`, " +
      "`influences`, `blocked_by`, `blocks`, `materialized`) and snapshots each changed file before " +
      "the edit. The journal carries `op:start`/`op:done`; repeating the call with the same `op_id` " +
      "resumes an interrupted move instead of duplicating it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The node or leaf to move." },
        to: {
          type: "string",
          description:
            "Destination: the node's new folder (`centurion/frontend/auth`) or the leaf's new file " +
            "(`centurion/frontend/session-store`). The new parent must already exist.",
        },
        op_id: {
          type: "string",
          description: "Operation id: pass the id from an interrupted call to resume it.",
        },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path", "to"],
    },
  },
  {
    name: "plan_archive_node",
    title: "Archive a plan subtree",
    description:
      `${PLAN_CONTRACT_SENTENCE} Moves a node and its subtree into '<project>/_archive/', marks ` +
      "it `archived` and removes it from its parent's `children`, so it leaves the indexed tree " +
      "while its files and snapshots stay on disk. Nothing is deleted. The journal carries " +
      "`op:start`/`op:done`; the same `op_id` resumes an interrupted archive.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The node or leaf to archive." },
        op_id: {
          type: "string",
          description: "Operation id: pass the id from an interrupted call to resume it.",
        },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path"],
    },
  },
  {
    name: "plan_approve_goal",
    title: "Approve a goal and materialise its steps",
    description:
      `${PLAN_CONTRACT_SENTENCE} Turns a \`proposed\` goal into a branch: one trunk named after the ` +
      "goal file, one leaf per `plan:` step linked back through `goal:`, the goal moved to " +
      "`approved` with `materialized` pointing at the branch. An agent cannot approve a goal it " +
      "created itself — that approval belongs to the user.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The proposed goal to approve." },
        op_id: {
          type: "string",
          description: "Operation id: pass the id from an interrupted call to resume it.",
        },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path"],
    },
  },
  {
    name: "plan_restore",
    title: "Restore a plan snapshot as a new revision",
    description:
      `${PLAN_CONTRACT_SENTENCE} Reads one \`__history\` snapshot and writes its content into the ` +
      "live file as `revision + 1` with `restored_from: \"v<v> r<r>\"`. The version never goes " +
      "back, the current state is snapshotted first, and relations (`parent`, `children`, " +
      "influences, blocks, goal, materialized) stay as the live file has them.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The live node whose content is restored." },
        version: { type: "number", description: "Snapshot version to read." },
        revision: { type: "number", description: "Snapshot revision to read." },
        expected_revision: EXPECTED_REVISION,
        accept_external: ACCEPT_EXTERNAL,
        actor: ACTOR,
      },
      required: ["path", "version", "revision"],
    },
  },
  {
    name: "plan_validate",
    title: "Check the plan's integrity",
    description:
      `${PLAN_CONTRACT_SENTENCE} Reports every integrity problem the file model can have: a link ` +
      "that resolves to nothing, a body that no longer matches its frontmatter, a node without a " +
      "parent, a project without one root (or with two), a leaf with children, a status or a " +
      "parent kind the schema does not allow, duplicate ids, an influence cycle, a half-finished " +
      "`op:start` in the journal and a file inside the planning root that is not a plan. Reads " +
      "only; each issue names the file to fix.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Only check this project folder." },
        limit: { type: "number", description: "How many issues to return, 1–500 (default 200)." },
        offset: {
          type: "number",
          description: "Skip the first N issues; supplied by a [TRUNCATED] result.",
        },
      },
    },
  },
  {
    name: "plan_import",
    title: "Import a luck_tree_export project",
    description:
      `${PLAN_CONTRACT_SENTENCE} Rebuilds a project from a \`.json.zip\` written by ` +
      "`luck_tree_export` (or the extracted `.json`): the hierarchy becomes folders and links, " +
      "bees become `influences`, bugs become incidents with `blocks`, goals keep their steps and " +
      "materialised branch, and every original row id is stored as `legacy_id`. `dry_run` " +
      "defaults to true and reports the plan without writing; the target project must be empty, " +
      "and importing the same file twice answers `unchanged` instead of duplicating the tree.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "A `.json.zip` or `.json` inside the vault. Use `content` for a file kept outside it.",
        },
        content: { type: "string", description: "The export JSON itself, when the file lives outside the vault." },
        project: { type: "string", description: "Target project folder; defaults to the export's project key." },
        include_archived: { type: "boolean", description: "Import archived nodes too (default true)." },
        dry_run: { type: "boolean", description: "Report only, write nothing. Defaults to true." },
        op_id: { type: "string", description: "Repeat a failed import with the same id to see it in the journal." },
        reason: { type: "string", description: "Why this import happens, recorded in the journal." },
        actor: ACTOR,
      },
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
  plan_create_node: (settings, input) => planCreateNode(settings, input),
  plan_update_node: (settings, input) => planUpdateNode(settings, input),
  plan_set_status: (settings, input) => planSetStatus(settings, input),
  plan_history: (settings, input) => planHistory(settings, input),
  plan_link: (settings, input) => planLink(settings, input),
  plan_incident: (settings, input) => planIncident(settings, input),
  plan_goal: (settings, input) => planGoal(settings, input),
  plan_growth: (settings, input) => planGrowth(settings, input),
  plan_move_node: (settings, input) => planMoveNode(settings, input),
  plan_archive_node: (settings, input) => planArchiveNode(settings, input),
  plan_approve_goal: (settings, input) => planApproveGoal(settings, input),
  plan_restore: (settings, input) => planRestore(settings, input),
  plan_validate: (settings, input) => planValidate(settings, input),
  plan_import: (settings, input) => planImport(settings, input),
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
