/**
 * Project import (PLAN.md stage L5, `__doc.md` §6).
 *
 * The other half of `shared/export.ts`: an exported project comes back as the
 * same graph, with **new ids**. Remapping is not a technicality — node ids are
 * primary keys of one table shared by every project, so reusing them would
 * collide the moment a database holds the project twice (the same tree
 * imported next to the copy it came from). Every reference that travels in the
 * envelope — parent, bee ends, bug attachments, a goal's materialized subtree,
 * a growth subject, every audit row's entity — is rewritten through the same
 * table, so the imported graph is internally consistent by construction.
 *
 * Client/server neutral like every `shared/` module: the dashboard could plan
 * an import for a preview without a filesystem, and the tests plan one without
 * a store. Reading the file and writing the rows live in `server/import.ts`
 * and `server/store.ts`.
 *
 * **Hierarchy is verified before anything is written.** The store's own
 * mutations check one edge at a time (a leaf's parent exists and is live, a
 * bee joins two leaves); a whole tree arrives at once, so the checks are done
 * here in one pass and every problem is reported by the ids the file uses —
 * the person deciding whether to import a file can see which node disagreed.
 */

import type { Goal } from "./goals";
import type { Growth } from "./growth";
import type { Bee, Bug, BugNode } from "./links";
import {
  canHaveChild,
  type HistoryAction,
  type HistoryEntityType,
  type Node,
} from "./tree";
import type { ExportDocument } from "./export";

/**
 * How many problems an error message spells out before it summarises the
 * rest. A file with 400 dangling parents must not become a 400-line error —
 * the first few show the pattern, the count says whether it is one bad edge
 * or the wrong file entirely.
 */
export const IMPORT_ISSUE_LIMIT = 8;

/** Provenance of the file, so a reply can say what was imported. */
export interface ImportSource {
  /** Project key the export was taken from. */
  readonly projectKey: string;
  readonly pluginVersion: string;
  readonly exportedAt: number;
  readonly schemaVersion: number;
}

/** Knobs of a plan; every one has a documented default. */
export interface ImportOptions {
  /** Target project; defaults to the exported one. */
  readonly projectKey?: string;
  /**
   * Keep soft-deleted rows (default `true`). An export describes the tree as
   * it was, archived nodes included; `false` imports only what is still live —
   * the rows that hang off a dropped node (bees, attachments, growth, audit)
   * are dropped with it and reported as warnings.
   */
  readonly includeArchived?: boolean;
  /** Import the audit trail when the file carries one (default `true`). */
  readonly includeHistory?: boolean;
  /** Id factory; tests inject a counter for deterministic plans. */
  readonly newId?: () => string;
}

/** One audit row ready for the store — `id` is the store's to mint. */
export interface ImportedHistoryRow {
  readonly entityType: HistoryEntityType;
  readonly entityId: string;
  readonly action: HistoryAction;
  readonly revision: number;
  readonly actor: string | null;
  readonly result: string;
  readonly at: number;
}

/** What a plan contains and what it leaves behind. */
export interface ImportCounts {
  readonly nodes: number;
  readonly archivedNodes: number;
  readonly bees: number;
  readonly bugs: number;
  readonly bugAttachments: number;
  readonly goals: number;
  readonly growth: number;
  /** Audit rows that travel with the file; `0` when it carries none. */
  readonly history: number;
  /** Rows skipped because their node was archived and will not be imported. */
  readonly dropped: number;
}

/**
 * A validated, remapped, ready-to-write project.
 *
 * The rows keep every field the export carried — timestamps, revisions,
 * descriptions, payloads, archived flags — because an import is a *copy of a
 * project*, not a session of edits: an agent did not create these nodes now,
 * and rewriting their ages would falsify the timeline the dashboard draws.
 */
export interface ImportPlan {
  readonly source: ImportSource;
  /** Project the rows will be written into. */
  readonly projectKey: string;
  readonly nodes: readonly Node[];
  readonly bees: readonly Bee[];
  readonly bugs: readonly Bug[];
  readonly bugAttachments: readonly BugNode[];
  readonly goals: readonly Goal[];
  readonly growth: readonly Growth[];
  readonly history: readonly ImportedHistoryRow[];
  readonly counts: ImportCounts;
  /** What was dropped on the way (archived policy) — shown, never silent. */
  readonly warnings: readonly string[];
}

/** Default id factory: the store's own choice, a fresh UUID per row. */
function defaultNewId(): string {
  return crypto.randomUUID();
}

/**
 * Validates an export and turns it into a plan.
 *
 * Throws with every problem found (capped) instead of stopping at the first:
 * a hand-edited file usually has one broken reference repeated, and seeing it
 * three times names the cause better than seeing it once.
 */
export function planImport(
  doc: ExportDocument,
  options: ImportOptions = {},
): ImportPlan {
  const projectKey = options.projectKey ?? doc.projectKey;
  const includeArchived = options.includeArchived ?? true;
  const includeHistory = options.includeHistory ?? true;
  const newId = options.newId ?? defaultNewId;

  const issues = validateTree(doc);
  if (issues.length > 0) throw new Error(rejection(issues));

  const goals = doc.goals;
  const kept = includeArchived
    ? new Set(doc.nodes.map((node) => node.id))
    : new Set(
        doc.nodes
          .filter((node) => node.archivedAt === null)
          .map((node) => node.id),
      );
  const isKept = (id: string): boolean => kept.has(id);

  const warnings: string[] = [];
  let dropped = 0;

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodes: Node[] = [];
  for (const node of doc.nodes) {
    if (!isKept(node.id)) {
      dropped += 1;
      continue;
    }
    nodes.push(node);
  }
  if (nodes.length === 0) {
    throw new Error(
      includeArchived
        ? "nothing to import: the file holds no nodes"
        : "nothing to import: the file holds no live nodes (every node is archived)",
    );
  }

  // ── Bees, attachments: only what still has both ends ─────────────────────
  const bees: Bee[] = [];
  for (const bee of doc.bees) {
    if (!isKept(bee.sourceLeafId) || !isKept(bee.targetLeafId)) {
      dropped += 1;
      warnings.push(
        `dropped bee ${bee.sourceLeafId} → ${bee.targetLeafId}: an archived leaf is not imported`,
      );
      continue;
    }
    bees.push(bee);
  }

  const bugs = doc.bugs;
  const keptBugs = new Set(bugs.map((bug) => bug.id));
  const bugAttachments: BugNode[] = [];
  for (const attachment of doc.bugAttachments) {
    if (!keptBugs.has(attachment.bugId) || !isKept(attachment.nodeId)) {
      dropped += 1;
      warnings.push(
        `dropped attachment of bug ${attachment.bugId} to ${attachment.nodeId}: an archived leaf is not imported`,
      );
      continue;
    }
    bugAttachments.push(attachment);
  }

  // ── Goals: a materialized subtree may have been dropped ──────────────────
  const remappedGoals: Goal[] = goals.map((goal) => {
    if (goal.materializedNodeId === null || isKept(goal.materializedNodeId)) {
      return goal;
    }
    dropped += 1;
    warnings.push(
      `goal ${goal.id} lost its materialized subtree: the node was archived`,
    );
    return { ...goal, materializedNodeId: null };
  });

  // ── Growth: a record without a subject is not a record ───────────────────
  const goalIdSet = new Set(goals.map((goal) => goal.id));
  const growth: Growth[] = [];
  for (const record of doc.growth) {
    const alive =
      record.subjectType === "goal"
        ? goalIdSet.has(record.subjectId)
        : isKept(record.subjectId);
    if (!alive) {
      dropped += 1;
      warnings.push(
        `dropped growth ${record.id}: its ${record.subjectType} is not imported`,
      );
      continue;
    }
    growth.push(record);
  }

  // ── Audit trail ──────────────────────────────────────────────────────────
  const history: ImportedHistoryRow[] = [];
  if (includeHistory && doc.history !== undefined) {
    const keptEntities = {
      nodes: new Set(nodes.map((node) => node.id)),
      bees: new Set(bees.map((bee) => bee.id)),
      bugs: new Set(bugs.map((bug) => bug.id)),
      goals: new Set(remappedGoals.map((goal) => goal.id)),
      growth: new Set(growth.map((record) => record.id)),
    };
    for (const entry of doc.history) {
      if (!entityIsKept(entry.entityType, entry.entityId, keptEntities)) {
        dropped += 1;
        continue;
      }
      history.push({
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        revision: entry.revision,
        actor: entry.actor,
        result: entry.result,
        at: entry.at,
      });
    }
    if (doc.history.length > history.length) {
      warnings.push(
        `dropped ${doc.history.length - history.length} audit rows of entities that are not imported`,
      );
    }
  }

  // ── Remap: one table, every reference rewritten through it ───────────────
  const nodeIds = new Map<string, string>();
  for (const node of nodes) nodeIds.set(node.id, newId());
  const beeIds = new Map<string, string>();
  for (const bee of bees) beeIds.set(bee.id, newId());
  const bugIds = new Map<string, string>();
  for (const bug of bugs) bugIds.set(bug.id, newId());
  const goalIds = new Map<string, string>();
  for (const goal of remappedGoals) goalIds.set(goal.id, newId());
  const growthIdsNew = new Map<string, string>();
  for (const record of growth) growthIdsNew.set(record.id, newId());

  const idOf = (
    map: ReadonlyMap<string, string>,
    id: string,
    what: string,
  ): string => {
    const mapped = map.get(id);
    if (mapped === undefined) throw new Error(`unmapped ${what} ${id}`);
    return mapped;
  };
  const newNode = (id: string): string => idOf(nodeIds, id, "node");

  const plannedNodes: Node[] = nodes.map((node) => ({
    ...node,
    id: newNode(node.id),
    parentId: node.parentId === null ? null : newNode(node.parentId),
    projectKey,
  }));

  const plannedBees: Bee[] = bees.map((bee) => ({
    ...bee,
    id: idOf(beeIds, bee.id, "bee"),
    sourceLeafId: newNode(bee.sourceLeafId),
    targetLeafId: newNode(bee.targetLeafId),
    projectKey,
  }));

  const plannedBugs: Bug[] = bugs.map((bug) => ({
    ...bug,
    id: idOf(bugIds, bug.id, "bug"),
    projectKey,
  }));

  const plannedAttachments: BugNode[] = bugAttachments.map((attachment) => ({
    bugId: idOf(bugIds, attachment.bugId, "bug"),
    nodeId: newNode(attachment.nodeId),
  }));

  const plannedGoals: Goal[] = remappedGoals.map((goal) => ({
    ...goal,
    id: idOf(goalIds, goal.id, "goal"),
    materializedNodeId:
      goal.materializedNodeId === null ? null : newNode(goal.materializedNodeId),
    projectKey,
  }));

  const plannedGrowth: Growth[] = growth.map((record) => ({
    ...record,
    id: idOf(growthIdsNew, record.id, "growth"),
    subjectId:
      record.subjectType === "goal"
        ? idOf(goalIds, record.subjectId, "goal")
        : newNode(record.subjectId),
    projectKey,
  }));

  const plannedHistory: ImportedHistoryRow[] = history.map((entry) => ({
    ...entry,
    entityId: remapEntityId(entry.entityType, entry.entityId, {
      node: nodeIds,
      bee: beeIds,
      bug: bugIds,
      goal: goalIds,
      growth: growthIdsNew,
    }),
  }));

  return {
    source: {
      projectKey: doc.projectKey,
      pluginVersion: doc.pluginVersion,
      exportedAt: doc.exportedAt,
      schemaVersion: doc.schemaVersion,
    },
    projectKey,
    nodes: plannedNodes,
    bees: plannedBees,
    bugs: plannedBugs,
    bugAttachments: plannedAttachments,
    goals: plannedGoals,
    growth: plannedGrowth,
    history: plannedHistory,
    counts: {
      nodes: plannedNodes.length,
      archivedNodes: plannedNodes.reduce(
        (total, node) => (node.archivedAt === null ? total : total + 1),
        0,
      ),
      bees: plannedBees.length,
      bugs: plannedBugs.length,
      bugAttachments: plannedAttachments.length,
      goals: plannedGoals.length,
      growth: plannedGrowth.length,
      history: plannedHistory.length,
      dropped,
    },
    warnings,
  };
}

/** A short human summary of a plan's size, for a tool reply. */
export function describeImport(plan: ImportPlan): string {
  const { counts } = plan;
  const parts = [
    `${counts.nodes} nodes`,
    `${counts.bees} bees`,
    `${counts.bugs} bugs`,
    `${counts.goals} goals`,
    `${counts.growth} growth records`,
  ];
  if (counts.history > 0) parts.push(`${counts.history} audit rows`);
  if (counts.archivedNodes > 0) parts.push(`${counts.archivedNodes} archived`);
  return parts.join(", ");
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Every hierarchy problem in the file, as readable lines.
 *
 * Checks, in the order the store would enforce them if the tree were built one
 * call at a time: unique ids, exactly one root, every parent present, a kind
 * that is allowed under its parent, no parent chain that loops, live nodes not
 * hanging under archived ones, bees joining two leaves, attachments pointing at
 * leaves, goals pointing at a subtree that exists, growth records with a
 * subject. Archived *ends* of a bee or an attachment are legal: archiving a
 * node in this plugin leaves its links in place, so a faithful export of an
 * old project contains them.
 */
export function validateTree(doc: ExportDocument): string[] {
  const issues: string[] = [];
  const nodes = doc.nodes;
  const byId = new Map<string, Node>();
  for (const node of nodes) {
    if (byId.has(node.id)) issues.push(`duplicate node id ${node.id}`);
    else byId.set(node.id, node);
  }

  const roots = nodes.filter((node) => node.kind === "root");
  if (roots.length !== 1) {
    issues.push(
      `the tree needs exactly one root, the file has ${roots.length}`,
    );
  }

  for (const node of nodes) {
    if (node.kind === "root") {
      if (node.parentId !== null) {
        issues.push(`root ${node.id} has a parent (${node.parentId})`);
      }
      continue;
    }
    if (node.parentId === null) {
      issues.push(`${node.kind} ${node.id} has no parent`);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (parent === undefined) {
      issues.push(
        `${node.id} points at parent ${node.parentId}, which is not in the file`,
      );
      continue;
    }
    if (!canHaveChild(parent.kind, node.kind)) {
      issues.push(
        `a ${node.kind} cannot be a child of a ${parent.kind} (${parent.id} → ${node.id})`,
      );
    }
    if (parent.archivedAt !== null && node.archivedAt === null) {
      issues.push(`live node ${node.id} sits under archived ${parent.id}`);
    }
  }

  // A loop would make every store walk hang: report it before the rows exist.
  for (const node of nodes) {
    const seen = new Set<string>();
    let cursor: Node | undefined = node;
    while (cursor !== undefined && cursor.parentId !== null) {
      if (seen.has(cursor.id)) {
        issues.push(`the parents of ${node.id} form a cycle`);
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
  }

  const requireLeaf = (id: string, what: string): void => {
    const node = byId.get(id);
    if (node === undefined) {
      issues.push(`${what} points at ${id}, which is not in the file`);
      return;
    }
    if (node.kind !== "leaf") {
      issues.push(`${what} points at a ${node.kind} (${id}); leaves only`);
    }
  };

  const pairs = new Set<string>();
  for (const bee of doc.bees) {
    requireLeaf(bee.sourceLeafId, `bee ${bee.id} (source)`);
    requireLeaf(bee.targetLeafId, `bee ${bee.id} (target)`);
    const pair = `${bee.sourceLeafId}→${bee.targetLeafId}`;
    if (pairs.has(pair)) {
      issues.push(`two bees for the same pair of leaves (${pair})`);
    }
    pairs.add(pair);
  }

  const bugIds = new Set(doc.bugs.map((bug) => bug.id));
  const attached = new Set<string>();
  for (const attachment of doc.bugAttachments) {
    if (!bugIds.has(attachment.bugId)) {
      issues.push(
        `attachment points at bug ${attachment.bugId}, which is not in the file`,
      );
    }
    requireLeaf(attachment.nodeId, `bug ${attachment.bugId}`);
    const key = `${attachment.bugId}:${attachment.nodeId}`;
    if (attached.has(key)) {
      issues.push(
        `bug ${attachment.bugId} is attached to ${attachment.nodeId} twice`,
      );
    }
    attached.add(key);
  }

  const goalIds = new Set(doc.goals.map((goal) => goal.id));
  for (const goal of doc.goals) {
    const subjectId = goal.materializedNodeId;
    if (subjectId === null) continue;
    if (!byId.has(subjectId)) {
      issues.push(
        `goal ${goal.id} points at subtree ${subjectId}, which is not in the file`,
      );
    }
  }

  for (const record of doc.growth) {
    const exists =
      record.subjectType === "goal"
        ? goalIds.has(record.subjectId)
        : byId.has(record.subjectId);
    if (!exists) {
      issues.push(
        `growth ${record.id} points at ${record.subjectType} ${record.subjectId}, which is not in the file`,
      );
    }
  }

  return issues;
}

/** `import rejected: a; b; c; and 4 more problems`. */
function rejection(issues: readonly string[]): string {
  const shown = issues.slice(0, IMPORT_ISSUE_LIMIT);
  const rest = issues.length - shown.length;
  return (
    `import rejected: ${shown.join("; ")}` +
    (rest > 0 ? `; and ${rest} more problem${rest === 1 ? "" : "s"}` : "")
  );
}

/** Whether a row's entity survives the archived policy. */
function entityIsKept(
  type: HistoryEntityType,
  id: string,
  kept: {
    readonly nodes: ReadonlySet<string>;
    readonly bees: ReadonlySet<string>;
    readonly bugs: ReadonlySet<string>;
    readonly goals: ReadonlySet<string>;
    readonly growth: ReadonlySet<string>;
  },
): boolean {
  switch (type) {
    case "node":
      return kept.nodes.has(id);
    case "bee":
      return kept.bees.has(id);
    case "bug":
      return kept.bugs.has(id);
    case "goal":
      return kept.goals.has(id);
    case "growth":
      return kept.growth.has(id);
    default:
      return false;
  }
}

/** Entity id through its entity's own map. */
function remapEntityId(
  type: HistoryEntityType,
  id: string,
  maps: {
    readonly node: ReadonlyMap<string, string>;
    readonly bee: ReadonlyMap<string, string>;
    readonly bug: ReadonlyMap<string, string>;
    readonly goal: ReadonlyMap<string, string>;
    readonly growth: ReadonlyMap<string, string>;
  },
): string {
  const map: ReadonlyMap<string, string> | undefined =
    type === "node"
      ? maps.node
      : type === "bee"
        ? maps.bee
        : type === "bug"
          ? maps.bug
          : type === "goal"
            ? maps.goal
            : type === "growth"
              ? maps.growth
              : undefined;
  return map?.get(id) ?? id;
}
