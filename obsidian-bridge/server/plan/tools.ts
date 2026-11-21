import type { RuntimeSettings } from "../../shared/settings";
import type { McpToolDefinition, ToolOutcome } from "../mcp-tools";
import { planGoal } from "./goal";
import { planGrowth } from "./growth";
import { planImport } from "./import";
import { planIncident } from "./incident";
import { planLink } from "./links";
import { GOAL_TRANSITIONS, INCIDENT_TRANSITIONS, LEAF_TRANSITIONS, GROWTH_TRANSITIONS } from "./model";
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
 * Boundary every planning tool states. Planning has its own purpose and its own
 * boundary, so it does not reuse the document contract sentence: a plan is not
 * a note an agent may cite at will, and it is not agent memory either.
 *
 * It is stated once per tool and repeated seventeen times in the catalogue, so
 * it says only what no single tool description already says: the shared scope,
 * the two tools this one is not, and the three paths it cannot reach. The long
 * form cost ~3 000 characters of repetition (0.21.16).
 */
export const PLAN_CONTRACT_SENTENCE =
  "Boundary: plan paths are relative to `planRoot/<project>`, the tree every workspace of this " +
  "project shares, and the calling `workspace_id` is recorded in the YAML; another project, " +
  "`__history` and `_archive` are unreachable. Not agent memory (memory-flash), not a vault " +
  "search (obsidian_search).";

/**
 * One description = the tool's own purpose, call form, result and next step,
 * then the shared contract.
 *
 * The contract used to come first, which made every one of the seventeen
 * descriptions open with the same ninety words: an agent skimming a tool list
 * saw seventeen identical prefixes and had to read to the end to learn what the
 * tool is for (0.21.16). The tool-specific sentence is what distinguishes them,
 * so it leads; the boundary still travels with every tool, because an agent may
 * see only one description at a time.
 */
function planned(specific: string): string {
  return `${specific.trim()} ${PLAN_CONTRACT_SENTENCE}`;
}

/** `draft → ready|deferred`, … — straight from `model.ts`, so it cannot drift. */
function transitionLine(map: Record<string, readonly string[]>): string {
  return Object.entries(map)
    .map(([from, to]) => `${from} → ${to.length > 0 ? to.join("|") : "final"}`)
    .join(", ");
}

/**
 * The lifecycle, stated once and shared by `plan_set_status` and `plan_growth`.
 * An agent that has to discover the graph by triggering a refusal spends a turn
 * on the tool instead of the plan; the table is three lines.
 */
const NODE_LIFECYCLE = transitionLine(LEAF_TRANSITIONS);
const INCIDENT_LIFECYCLE = transitionLine(INCIDENT_TRANSITIONS);
const GOAL_LIFECYCLE = transitionLine(GOAL_TRANSITIONS);
const GROWTH_LIFECYCLE = transitionLine(GROWTH_TRANSITIONS);

/** The form of a plan path for each kind, repeated wherever a path is an input. */
const PATH_FORMS =
  "Path forms: a root is `<project>`, a trunk `<project>/<trunk>`, a branch or sub-branch its " +
  "folder (`<project>/<trunk>/<branch>`), a leaf a name in its parent's folder " +
  "(`<project>/<trunk>/<branch>/<leaf>`). The file name may be appended (`…/auth.md`) and a " +
  "folder path resolves the node inside it; both forms address the same node.";

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
    description: planned(
      "Start every planning task with this read-only call: it answers whether a plan tree exists, " +
        "which project folder you own and whether writes are enabled, and creates nothing. The " +
        "result carries `planning_available`, `root` (the vault-relative `<planRoot>/<project>`), " +
        "`project.name` — the first segment every other `plan_*` path begins with — " +
        "`workspaceId` (written into each node's YAML), `writesEnabled`, `projects`, `documents`, " +
        "`limits` and the hidden `systemDirs`. `empty: true` with `planning_available: true` is a " +
        "normal start: create the root with `plan_create_node`. `planning_available: false` means " +
        "stop and report `reason`/`error`; no planning tool creates a missing planning directory.",
    ),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "plan_read",
    title: "Read a plan node or project overview",
    description: planned(
      "Read a node before you write to it — the returned `node.revision` is what the next write " +
        "passes as `expected_revision` — and read the result of every structural change. Without " +
        "`path` it returns the project overview (each project's root, its trunks with child " +
        "counts, counts by kind, open incidents, proposed and approved goals). With `path` it " +
        "returns one node in context: `node` (kind, name, status, `version`, `revision`), " +
        "`parent`, `ancestors`, `children`, `siblings`, `influences` and `influencedBy`, " +
        "`blockedBy` and `blocks`, `goal`, `formal_text`, `plan`, `brief`, `payload`, `notes`, " +
        "`growth`, `beeCycle` and `unresolved`. It does not list snapshots — that is " +
        "`plan_history`. A path that resolves to nothing returns `suggestions` with real node " +
        `paths. ${PATH_FORMS}`,
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Node path relative to the planning root, e.g. `centurion/backend/auth/auth`. The " +
            "node file itself may be omitted (`centurion/backend/auth` reads `auth.md`). Empty " +
            "returns the project overview.",
        },
        project: {
          type: "string",
          description:
            "Optional project folder (first level under the planning root) to focus the overview; " +
            "an unknown folder is an error, not an empty result.",
        },
      },
    },
  },
  {
    name: "plan_search",
    title: "Search the plan",
    description: planned(
      "Find a node when you know words from its name, description or body but not its path; then " +
        "call `plan_read` on the hit. Returns ranked hits with plan-relative paths, kind, status " +
        "and a snippet, filtered by `kind`, `status` and `project` read from YAML frontmatter — " +
        "not from the text. A hit is a pointer, not the node: the body, relations and " +
        "`revision` come from `plan_read`. A hit with none of the query words is dropped, so an " +
        "empty result means the words are not in the tree.",
    ),
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
    description: planned(
      "Create one node of the plan tree as its own note with `version: 1`, `revision: 1`, add it " +
        "to the parent's `children` and write the journal. Build in order root → trunk → branch → " +
        "sub-branch → leaf: the parent must already exist, and its kind must allow the new one " +
        "(root: trunk; trunk: branch; branch and sub-branch: sub-branch or leaf; leaf: nothing), " +
        "so the first call of a new project is `path: \"<project>\", kind: \"root\"` — the project " +
        "folder alone, never `<project>/<project>`. A branching node lives in its own folder " +
        "(`auth/auth.md`), a leaf in its parent's folder (`auth/session-store.md`). It never " +
        "overwrites an existing file. The result returns `path`, `vault_path`, `version`, " +
        "`revision`, the parent summary and its new `parent_revision` — read the node before " +
        "adding `brief`, `payload` or relations.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Node path relative to the planning root. A root is the project folder " +
            "(`centurion`); a branch is its folder (`centurion/backend/auth`); a leaf is a name " +
            "inside the parent's folder (`centurion/backend/auth/session-store`).",
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
        brief: {
          type: "object",
          description:
            "Leaf brief: `{entryPoint, steps, files, acceptance, source}` — why the leaf exists " +
            "and what \"done\" means, as opposed to `description` (what it is).",
        },
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
    description: planned(
      "Change the content of one node — `description`, `name`, `brief`, `payload`, `## Заметки` " +
        "or its `kind` — not its structure or its lifecycle: move a node with `plan_move_node`, " +
        "move its status with `plan_set_status`, change relations with `plan_link`/`plan_incident`. " +
        "Every field is optional and each one counts on its own, so `notes` alone is a valid call. " +
        "A snapshot of the previous state is written to `__history` first; a content change raises " +
        "`revision` by one, a kind change raises `version`, resets `revision` to 1 and moves the " +
        "file (with its snapshots) to the new kind's layout, rewriting the links that address it. " +
        "The result returns the new `version`/`revision` — pass it on to the next write. A stale " +
        "`expected_revision` or a manual edit on disk refuses the write instead of overwriting it.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Node path relative to the planning root." },
        description: { type: "string", description: "New short description." },
        name: { type: "string", description: "New name." },
        brief: { type: "object", description: "Replacement leaf brief, or null to remove it." },
        payload: { type: "object", description: "Replacement payload, or null to remove it." },
        notes: { type: "string", description: "Replacement text for `## Заметки`; a change on its own." },
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
    description: planned(
      "Perform exactly one lifecycle transition on a node, incident or goal — this is the only " +
        "tool that changes a status. The graph is enforced, so pick a target from the current " +
        "one: a node status follows " +
        `${NODE_LIFECYCLE}; an incident follows ${INCIDENT_LIFECYCLE}; a goal follows ` +
        `${GOAL_LIFECYCLE}. A no-op, a skipped step or an invented status writes nothing and lists ` +
        "the allowed targets. A status the user set can be overridden by an agent only with " +
        "`reason`, which is recorded in the journal. The previous state is snapshotted first, so " +
        "the transition is reviewable. Finish the work by setting `done` and recording what " +
        "happened with `plan_growth`.",
    ),
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
    description: planned(
      "Read a node's change log: every write left one snapshot, so the list (newest first) is what " +
        "happened to this node — version, revision, reason, time and actor. Without `version` and " +
        "`revision` it lists the snapshots of one node; with both it returns that snapshot's full " +
        "content, including `## Заметки`. This is the only tool that reads `__history`: a snapshot " +
        "is immutable, and restoring one is `plan_restore`, not an edit. The path is the live " +
        "node's, in either form (a branching node's folder works); an unknown node is an error " +
        "with suggestions, never an empty list. For the operations of the whole project read " +
        "`<project>/_journal.md` with `obsidian_read` — it is a note, and never a plan file to edit " +
        "or delete.",
    ),
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
    description: planned(
      "Record that one leaf changes how another should be done. Creates, updates or removes one " +
        "influence (a bee) from `source` onto `target`; both ends must be leaves of the same " +
        "project and cannot be the same leaf, and the tool refuses a cross-project or self edge " +
        "before writing. Only the source stores the edge (`influences`), and Obsidian shows the " +
        "reverse as a backlink, so the two sides cannot disagree: `plan_read` on the target shows " +
        "it under `influencedBy`. Calling it again for the same pair updates status and impact " +
        "instead of duplicating the edge; `remove: true` drops it. A cycle is allowed and " +
        "reported by `plan_read` as `beeCycle` — name it and ask which edge is wrong rather than " +
        "cutting one silently.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The influencing leaf (holds the edge)." },
        target: { type: "string", description: "The influenced leaf." },
        status: {
          type: "string",
          description:
            "active, watching, resolved, cancelled; default `active` when created. Only active " +
            "and watching edges order work and can close a cycle.",
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
    description: planned(
      "Record a problem that blocks work as an incident document in " +
        "`<project>/_incidents/<slug>` and attach it to the leaves it stops. `blocks` (on the " +
        "incident) and `blocked_by` (on each leaf) are kept in sync in both directions, so " +
        "`plan_read` on a blocked leaf names the incident; `unblock` detaches a leaf again. Only " +
        "`open` and `investigating` incidents block — a `resolved` one stays as history and the " +
        "leaves stop being blocked without a second edit. This tool does not change an existing " +
        "incident's status (only its initial one at creation): move it with `plan_set_status`. " +
        "Creating requires `name`; read the leaves first so the attached paths exist.",
    ),
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
    description: planned(
      "Author an outcome that is not a node yet, in `<project>/_goals/<slug>`: `create` writes it " +
        "as `draft` with its `formal_text` and `plan` steps, `update` changes that wording or the " +
        "steps, `propose` moves a draft to `proposed` for a human to approve. There is no `status` " +
        "argument — a goal created here is always `draft`, and `propose` is how it becomes " +
        "`proposed`; an agent may propose but never approve the goal it wrote. Approval and " +
        "materialisation are `plan_approve_goal`, never this tool, so do not create the trunk / " +
        "`steps` branch / leaves by hand. Steps are `{id?, title, description?}` or plain titles; " +
        "`null` clears them.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "propose"],
          description:
            "What to do with the goal; default `create`. `propose` is the draft → proposed step; " +
            "approval is `plan_approve_goal`.",
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
    description: planned(
      "Record what actually happened while the work ran: a measurement, a rejected approach, a " +
        "step that stalled. Upserts the `growth:` record of one node or goal — status, summary, " +
        "progress and steps. Steps merge by title, so re-recording a step updates it instead of " +
        "duplicating it; `replace: true` starts the list over. Growth status follows " +
        `${GROWTH_LIFECYCLE}. This does not change the node's \`status\` (use \`plan_set_status\`) ` +
        "and does not decide that the work is done: `plan_read.growth` shows the record, and " +
        "`plan_validate` reports `growth_incomplete` when `done` growth still has pending steps. " +
        "A snapshot of the previous state is written first.",
    ),
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
    description: planned(
      "Restructure the tree: move one node and its subtree (or one leaf) to a new path inside " +
        "the planning root. The source must exist and the destination's parent must already " +
        "exist; `to` is the node's new folder (`centurion/frontend/auth`) or the leaf's new file " +
        "path including its name (`centurion/frontend/session-store`) — a folder for a leaf is " +
        "refused. Every link into the moved files (`parent`, `children`, `influences`, " +
        "`blocked_by`, `blocks`, `materialized`) is rewritten and each changed file is snapshotted " +
        "before its edit. The result names the moved files and its `op_id`; the journal carries " +
        "`op:start`/`op:done`, and repeating the call with the same `op_id` resumes an interrupted " +
        "move instead of duplicating it.",
    ),
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
    description: planned(
      "Retire dead work without deleting it: move a node and its subtree into " +
        "`<project>/_archive/`, mark it `archived` and remove it from its parent's `children`, so " +
        "it leaves the indexed tree while its files and snapshots stay on disk. The archived path " +
        "comes from the node's own slug, and a node whose kind and folder disagree is refused (its " +
        "folder may hold siblings). Links between the archived files are rewritten to the new " +
        "paths (the result reports `links_rewritten`); links from the live tree into the archive " +
        "are left dangling by design, and `plan_validate` reports them as `unresolved_link`. " +
        "Nothing is deleted and there is no un-archive tool: putting work back is a move by the " +
        "user in Obsidian or git. The journal carries `op:start`/`op:done`; the same `op_id` " +
        "resumes an interrupted archive.",
    ),
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
    description: planned(
      "Turn a `proposed` goal into work, in the only layout the schema allows: one trunk named " +
        "after the goal file, one `steps` branch under it, and one leaf per `plan:` step linked " +
        "back through `goal:`; the goal moves to `approved` with `materialized` pointing at the " +
        "trunk. A `draft` goal is refused (propose it first with `plan_goal`), and an agent cannot " +
        "approve a goal it created itself — that approval belongs to the user, so stop and ask, or " +
        "let the user call it with `actor: \"user\"`. Do not create that subtree by hand as well. " +
        "The result names the trunk, branch and leaves it wrote; the same `op_id` resumes an " +
        "interrupted approval.",
    ),
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
    description: planned(
      "Bring an earlier text back when the current one is wrong: read one `__history` snapshot " +
        "and write its content into the live file as `revision + 1` with " +
        "`restored_from: \"v<v> r<r>\"`. The content restored is what the snapshot holds, " +
        "`## Заметки` included; the version never goes back and the current state is snapshotted " +
        "first, so a restore is itself reviewable and reversible. Relations (`parent`, `children`, " +
        "`influences`, blocks, goal, materialized) stay as the live file has them, and a snapshot " +
        "whose `kind` differs from the live node is refused — that is a version event, not an " +
        "edit. Do not use it to undo a status change or a move: those have `plan_set_status` and " +
        "`plan_move_node`.",
    ),
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
    description: planned(
      "Check the tree against its own file model before calling work finished and at the start of " +
        "a review; it reads only and changes nothing. It reports a link that resolves to nothing, " +
        "a body that no longer matches its frontmatter, a node without a parent, a project " +
        "without one root (or with two), a leaf with children, a status or a parent kind the " +
        "schema does not allow, duplicate ids, an influence cycle, a half-finished `op:start` in " +
        "the journal, a `done` growth with unfinished steps, and a file inside the planning root " +
        "that is not a plan. Each issue names the file and the kind of problem, so the next step " +
        "is a specific tool call, not a file edit. `project` limits the check to one project " +
        "folder; `_archive` and `__history` are excluded by design. A `[TRUNCATED]` result carries " +
        "a `continuation` for `obsidian_continue`.",
    ),
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
    description: planned(
      "Rebuild a project from a `.json.zip` written by `luck_tree_export` (or the extracted " +
        "`.json`) instead of retyping it: the hierarchy becomes folders and links, bees become " +
        "`influences`, bugs become incidents with `blocks`, goals keep their steps and " +
        "materialised branch, and every original row id is stored as `legacy_id`. `dry_run` " +
        "defaults to true and reports the plan (`counts`, `warnings`, `files`) without writing — " +
        "read it, then repeat with `dry_run: false`. The target project must be empty, and " +
        "importing the same file twice answers `unchanged` instead of duplicating the tree.",
    ),
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
