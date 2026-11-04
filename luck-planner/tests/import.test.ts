import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { buildExportDocument, writeExportFile } from "../server/export";
import { readImportDocument, runImport } from "../server/import";
import { LuckPlannerStore } from "../server/store";
import {
  IMPORT_ISSUE_LIMIT,
  planImport,
  type ImportPlan,
} from "../shared/import";
import type { ExportDocument } from "../shared/export";
import type { Goal } from "../shared/goals";
import type { Node } from "../shared/tree";

/**
 * Stage L5 acceptance: a project comes back as the same graph with new ids.
 *
 * Real SQLite files in a temp directory and real archives on disk — the store,
 * the zip container and the hierarchy checks are the subject, so nothing here
 * is mocked.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const Q = "/projects/elsewhere";
const ACTOR = "agent:coder";
const AT = Date.UTC(2026, 10, 4, 13, 20, 55);

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-import-"));
  dirs.push(dir);
  return dir;
}

function openStore(): LuckPlannerStore {
  const store = new LuckPlannerStore({
    dbPath: path.join(tempDir(), "luck-planner.db"),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Seeded {
  readonly root: Node;
  readonly branch: Node;
  readonly leafA: Node;
  readonly leafB: Node;
  readonly goal: Goal;
}

/** root → trunk → branch → (leafA, leafB) + bee + bug + goal (grown) + growth. */
function seed(store: LuckPlannerStore, projectKey = P): Seeded {
  const root = store.createNode({
    projectKey,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor: ACTOR,
  });
  const trunk = store.createNode({
    projectKey,
    parentId: root.id,
    kind: "trunk",
    name: "Platform",
    actor: ACTOR,
  });
  const branch = store.createNode({
    projectKey,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor: ACTOR,
  });
  const leafA = store.createNode({
    projectKey,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    description: "queue retries with backoff",
    payload: { plan: "retry on 5xx", fact: "backoff is 1s/2s/4s" },
    actor: ACTOR,
  });
  const leafB = store.createNode({
    projectKey,
    parentId: branch.id,
    kind: "leaf",
    name: "prorate refunds",
    actor: ACTOR,
  });
  store.createBee({
    projectKey,
    sourceLeafId: leafA.id,
    targetLeafId: leafB.id,
    impact: "refund proration depends on retry outcome",
    actor: ACTOR,
  });
  store.createBug({
    projectKey,
    title: "webhook 500s",
    severity: "high",
    nodeIds: [leafA.id],
    actor: ACTOR,
  });
  const draft = store.createGoal({
    projectKey,
    formalText: "Charges retry without duplicating refunds",
    plan: [
      { id: "s1", title: "spec", description: "define the retry window" },
      { id: "s2", title: "code", description: "implement the queue" },
    ],
    actor: ACTOR,
  });
  store.setGoalStatus({
    projectKey,
    id: draft.id,
    status: "proposed",
    actor: ACTOR,
  });
  const goal = store.approveGoal({
    projectKey,
    id: draft.id,
    parentBranchId: branch.id,
    actor: ACTOR,
  });
  store.createGrowth({
    projectKey,
    subjectType: "node",
    subjectId: leafA.id,
    steps: [
      { id: "g1", title: "spec", state: "completed", facts: [], reason: "" },
      { id: "g2", title: "code", state: "pending", facts: [], reason: "" },
    ],
    actor: ACTOR,
  });
  return { root, branch, leafA, leafB, goal };
}

function docOf(
  store: LuckPlannerStore,
  projectKey = P,
  includeHistory = true,
): ExportDocument {
  return buildExportDocument(store, {
    projectKey,
    pluginVersion: "0.44.0",
    exportedAt: AT,
    includeHistory,
  });
}

/** Deterministic ids: `new-1`, `new-2`, … */
function counter(prefix = "new"): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

/** A plan for a plain round trip, deterministic and free of the archived policy. */
function planOf(
  store: LuckPlannerStore,
  options: { projectKey?: string; includeArchived?: boolean } = {},
): ImportPlan {
  return planImport(docOf(store), {
    ...(options.projectKey === undefined ? {} : { projectKey: options.projectKey }),
    ...(options.includeArchived === undefined
      ? {}
      : { includeArchived: options.includeArchived }),
    newId: counter(),
  });
}

/**
 * Node names, the readable fingerprint of a project.
 *
 * Sorted rather than in tree order: siblings are ordered by `created_at, id`,
 * and an import mints fresh ids — a tree copies its shape, not the incidental
 * tie-break between two nodes created in the same millisecond.
 */
function names(store: LuckPlannerStore, projectKey: string): string[] {
  return store
    .listNodes(projectKey, { includeArchived: true })
    .map((node) => `${node.kind}:${node.name}`)
    .sort();
}

// ── The plan: remap and validation ─────────────────────────────────────────

describe("import plan (stage L5)", () => {
  it("rebuilds the graph with fresh ids and keeps every field", () => {
    const store = openStore();
    const seeded = seed(store);
    const source = docOf(store);
    const plan = planImport(source, { newId: counter() });

    expect(plan.projectKey).toBe(P);
    expect(plan.nodes).toHaveLength(source.nodes.length);
    expect(plan.counts).toMatchObject({
      nodes: source.nodes.length,
      archivedNodes: 0,
      bees: 1,
      bugs: 1,
      goals: 1,
      growth: 1,
      history: source.history?.length,
      dropped: 0,
    });

    // Every id is fresh, and none of them survived from the file.
    const sourceIds = new Set(source.nodes.map((node) => node.id));
    const newIds = plan.nodes.map((node) => node.id);
    expect(new Set(newIds).size).toBe(newIds.length);
    for (const id of newIds) expect(sourceIds.has(id)).toBe(false);

    // The parent edges point at the *new* ids, so the shape is intact.
    const byNewId = new Map(plan.nodes.map((node) => [node.id, node]));
    const nameOf = (id: string | null): string | null =>
      id === null ? null : (byNewId.get(id)?.name ?? `missing:${id}`);
    const parentName = (name: string): string | null => {
      const node = plan.nodes.find((candidate) => candidate.name === name);
      expect(node).toBeDefined();
      return nameOf(node?.parentId ?? null);
    };
    expect(parentName("retry failed charges")).toBe("billing");
    expect(parentName("billing")).toBe("Platform");
    expect(parentName("Platform")).toBe("Tech stack");

    // Versions, revisions, payloads and timestamps travel unchanged: an import
    // is a copy of a project, not a session of edits.
    const leaf = plan.nodes.find((node) => node.name === "retry failed charges");
    const original = source.nodes.find(
      (node) => node.name === "retry failed charges",
    );
    expect(leaf?.payload).toEqual(original?.payload);
    expect(leaf?.revision).toBe(original?.revision);
    expect(leaf?.createdAt).toBe(original?.createdAt);
    expect(leaf?.updatedAt).toBe(original?.updatedAt);
    expect(leaf?.createdBy).toBe(original?.createdBy);
  });

  it("remaps the references of bees, attachments, goals, growth and audit rows", () => {
    const store = openStore();
    const seeded = seed(store);
    const plan = planOf(store);
    const newIdOf = (name: string): string => {
      const node = plan.nodes.find((candidate) => candidate.name === name);
      if (node === undefined) throw new Error(`no node named ${name}`);
      return node.id;
    };

    expect(plan.bees).toHaveLength(1);
    expect(plan.bees[0]?.sourceLeafId).toBe(newIdOf("retry failed charges"));
    expect(plan.bees[0]?.targetLeafId).toBe(newIdOf("prorate refunds"));

    expect(plan.bugAttachments).toHaveLength(1);
    expect(plan.bugAttachments[0]?.nodeId).toBe(newIdOf("retry failed charges"));
    expect(plan.bugAttachments[0]?.bugId).toBe(plan.bugs[0]?.id);

    // The goal points at the subtree the approval grew, through the new ids.
    expect(plan.goals).toHaveLength(1);
    const materialized = plan.goals[0]?.materializedNodeId;
    expect(materialized).not.toBeNull();
    expect(plan.nodes.some((node) => node.id === materialized)).toBe(true);
    expect(plan.goals[0]?.id).not.toBe(seeded.goal.id);

    expect(plan.growth[0]?.subjectId).toBe(newIdOf("retry failed charges"));

    // The trail follows its entities, so `luck_tree_history` still answers.
    const history = plan.history;
    expect(history.length).toBeGreaterThan(0);
    const nodeIds = new Set(plan.nodes.map((node) => node.id));
    for (const row of history) {
      if (row.entityType === "node") expect(nodeIds.has(row.entityId)).toBe(true);
    }
    const leafHistory = history.filter(
      (row) => row.entityId === newIdOf("retry failed charges"),
    );
    expect(leafHistory.some((row) => row.action === "create")).toBe(true);
  });

  it("keeps every row in the target project key and never mutates the file", () => {
    const store = openStore();
    seed(store);
    const source = docOf(store);
    const snapshot = JSON.stringify(source);
    const plan = planImport(source, { projectKey: Q, newId: counter() });

    expect(plan.projectKey).toBe(Q);
    for (const node of plan.nodes) expect(node.projectKey).toBe(Q);
    for (const bee of plan.bees) expect(bee.projectKey).toBe(Q);
    for (const goal of plan.goals) expect(goal.projectKey).toBe(Q);
    for (const record of plan.growth) expect(record.projectKey).toBe(Q);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("refuses a tree with two roots", () => {
    const store = openStore();
    const seeded = seed(store);
    const source = docOf(store);
    const second: Node = {
      ...(source.nodes.find((node) => node.id === seeded.root.id) as Node),
      id: "second-root",
      name: "a second tree",
      parentId: null,
    };
    const broken: ExportDocument = {
      ...source,
      nodes: [...source.nodes, second],
    };
    expect(() => planImport(broken)).toThrow(/exactly one root, the file has 2/);
  });

  it("refuses a parent that is missing, wrongly kinded, or archived above a live child", () => {
    const store = openStore();
    const seeded = seed(store);
    const source = docOf(store);

    const orphan = source.nodes.map((node) =>
      node.id === seeded.branch.id ? { ...node, parentId: "nowhere" } : node,
    );
    expect(() => planImport({ ...source, nodes: orphan })).toThrow(
      /points at parent nowhere, which is not in the file/,
    );

    const wrongKind = source.nodes.map((node) =>
      node.id === seeded.root.id ? { ...node, kind: "leaf" as const } : node,
    );
    expect(() => planImport({ ...source, nodes: wrongKind })).toThrow(
      /cannot be a child of a leaf/,
    );

    const archivedParent = source.nodes.map((node) =>
      node.id === seeded.root.id ? { ...node, archivedAt: AT } : node,
    );
    expect(() => planImport({ ...source, nodes: archivedParent })).toThrow(
      /sits under archived/,
    );
  });

  it("refuses a cycle and duplicate ids", () => {
    const store = openStore();
    const seeded = seed(store);
    const source = docOf(store);

    // branch.parent = trunk, trunk.parent = branch: a two-node loop.
    const looped = source.nodes.map((node) => {
      if (node.id === seeded.root.id) return { ...node, parentId: seeded.branch.id };
      return node;
    });
    expect(() => planImport({ ...source, nodes: looped })).toThrow(/form a cycle/);

    const duplicated = { ...source, nodes: [...source.nodes, seeded.leafA] };
    expect(() => planImport(duplicated)).toThrow(/duplicate node id/);
  });

  it("refuses a bee or an attachment on something that is not a leaf", () => {
    const store = openStore();
    const seeded = seed(store);
    const source = docOf(store);

    const beeOnBranch = {
      ...source,
      bees: source.bees.map((bee) => ({
        ...bee,
        targetLeafId: seeded.branch.id,
      })),
    };
    expect(() => planImport(beeOnBranch)).toThrow(/leaves only/);

    const attachmentOnBranch = {
      ...source,
      bugAttachments: source.bugAttachments.map((attachment) => ({
        ...attachment,
        nodeId: seeded.branch.id,
      })),
    };
    expect(() => planImport(attachmentOnBranch)).toThrow(/leaves only/);
  });

  it("refuses a goal or growth record whose subject is not in the file", () => {
    const store = openStore();
    seed(store);
    const source = docOf(store);

    const danglingGoal = {
      ...source,
      goals: source.goals.map((goal) => ({
        ...goal,
        materializedNodeId: "gone-subtree",
      })),
    };
    expect(() => planImport(danglingGoal)).toThrow(/not in the file/);

    const danglingGrowth = {
      ...source,
      growth: source.growth.map((record) => ({ ...record, subjectId: "gone" })),
    };
    expect(() => planImport(danglingGrowth)).toThrow(/not in the file/);
  });

  it("summarises a pile of problems instead of listing them all", () => {
    const store = openStore();
    seed(store);
    const source = docOf(store);
    const leaf = source.nodes.find((node) => node.name === "prorate refunds") as Node;
    // Twelve copies of one row: eleven duplicate-id problems, capped at eight.
    const broken = {
      ...source,
      nodes: [
        ...source.nodes,
        ...Array.from({ length: 11 }, () => ({ ...leaf })),
      ],
    };
    const message = (() => {
      try {
        planImport(broken);
        return "";
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    })();
    expect(message).toMatch(/and \d+ more problems?$/);
    const listed = message
      .replace(/^import rejected: /, "")
      .split("; ")
      .filter((part) => !/^and \d+ more/.test(part));
    expect(listed.length).toBe(IMPORT_ISSUE_LIMIT);
  });

  it("drops archived rows and their links when the policy says tree-only", () => {
    const store = openStore();
    const seeded = seed(store);
    // Archive one leaf: its bee and its bug attachment lose one end.
    store.archiveNode({ projectKey: P, id: seeded.leafA.id, actor: ACTOR });
    const source = docOf(store);

    const full = planImport(source, { newId: counter() });
    expect(full.counts.archivedNodes).toBeGreaterThan(0);
    expect(full.counts.bees).toBe(1);
    expect(full.counts.bugAttachments).toBe(1);

    const live = planImport(source, { includeArchived: false, newId: counter() });
    expect(live.counts.archivedNodes).toBe(0);
    expect(live.counts.bees).toBe(0);
    expect(live.counts.bugAttachments).toBe(0);
    expect(live.counts.dropped).toBeGreaterThan(0);
    expect(live.warnings.join("\n")).toMatch(/dropped bee/);
    expect(live.warnings.join("\n")).toMatch(/dropped attachment/);
    expect(
      live.nodes.some((node) => node.name === "retry failed charges"),
    ).toBe(false);
    // A goal that keeps a materialized subtree points at a node that came along.
    expect(
      live.nodes.some((node) => node.id === live.goals[0]?.materializedNodeId),
    ).toBe(true);
  });

  it("refuses a file with nothing left to import", () => {
    const store = openStore();
    seed(store);
    const source = docOf(store);
    expect(() =>
      planImport({
        ...source,
        nodes: source.nodes.map((node) => ({ ...node, archivedAt: AT })),
      }, { includeArchived: false }),
    ).toThrow(/no live nodes/);
  });

  it("can carry the trail or leave it behind", () => {
    const store = openStore();
    seed(store);
    const source = docOf(store);
    const withTrail = planImport(source, { newId: counter() });
    expect(withTrail.counts.history).toBe(source.history?.length);
    expect(withTrail.history.length).toBeGreaterThan(0);

    const withoutTrail = planImport(source, { includeHistory: false, newId: counter() });
    expect(withoutTrail.counts.history).toBe(0);
    expect(withoutTrail.history).toHaveLength(0);
  });
});

// ── The write: a real store, real archives ─────────────────────────────────

describe("import into a store (stage L5)", () => {
  it("rebuilds a project in an empty target and answers what it wrote", () => {
    const store = openStore();
    const seeded = seed(store);
    const exported = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.44.0",
      exportedAt: AT,
    });

    const report = runImport(store, {
      file: exported.file,
      projectKey: Q,
      actor: ACTOR,
    });

    expect(report.dryRun).toBe(false);
    expect(report.projectKey).toBe(Q);
    expect(report.written.nodes).toBe(report.counts.nodes);
    expect(report.written.history).toBe(report.counts.history);

    // The same tree, in the same shape, under new ids.
    expect(names(store, Q)).toEqual(names(store, P));
    const parentName = (projectKey: string, name: string): string | null => {
      const node = store
        .listNodes(projectKey, { includeArchived: true })
        .find((candidate) => candidate.name === name);
      if (node?.parentId == null) return null;
      return store.getNode(projectKey, node.parentId)?.name ?? null;
    };
    for (const node of store.listNodes(Q, { includeArchived: true })) {
      expect(parentName(Q, node.name)).toBe(parentName(P, node.name));
    }
    const imported = store.listNodes(Q);
    for (const node of imported) {
      expect(node.projectKey).toBe(Q);
      expect(imported.some((other) => other.id === node.id)).toBe(true);
    }
    const sourceIds = new Set(store.listNodes(P, { includeArchived: true }).map((n) => n.id));
    for (const node of imported) expect(sourceIds.has(node.id)).toBe(false);

    // Links that only exist as rows come back too.
    const leaf = imported.find((node) => node.name === "retry failed charges");
    expect(leaf).toBeDefined();
    expect(store.listBees(Q)).toHaveLength(1);
    expect(store.listBugs(Q)).toHaveLength(1);
    expect(store.listGoals(Q)).toHaveLength(1);
    expect(store.listGrowth(Q)).toHaveLength(1);
    expect(store.listBlockingBugs(Q, leaf?.id ?? "")).toHaveLength(1);
    expect(store.getGrowthProgress(Q, "node", leaf?.id ?? "")?.ratio).toBe(0.5);
    expect(store.listBeesForNode(Q, leaf?.id ?? "")).toHaveLength(1);

    // The audit trail travelled: the original `create` row is there, under the
    // new id, and nothing was duplicated.
    const history = store.listHistory(Q, leaf?.id ?? "");
    expect(history.filter((row) => row.action === "create")).toHaveLength(1);
    expect(history[0]?.actor).toBe(ACTOR);

    // Timestamps survived, so the dashboard's timeline is not "everything now".
    expect(leaf?.createdAt).toBe(seeded.leafA.createdAt);
    expect(leaf?.revision).toBe(seeded.leafA.revision);
  });

  it("writes nothing on a dry run, and the same plan afterwards", () => {
    const store = openStore();
    seed(store);
    const exported = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.44.0",
      exportedAt: AT,
    });

    const dry = runImport(store, { file: exported.file, projectKey: Q, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.written).toEqual({
      nodes: 0,
      bees: 0,
      bugs: 0,
      goals: 0,
      growth: 0,
      history: 0,
    });
    expect(dry.counts.nodes).toBeGreaterThan(0);
    expect(store.listNodes(Q, { includeArchived: true })).toHaveLength(0);
    expect(store.latestHistoryId()).toBeGreaterThan(0);

    const written = runImport(store, { file: exported.file, projectKey: Q });
    expect(written.counts).toEqual(dry.counts);
    expect(store.listNodes(Q, { includeArchived: true })).toHaveLength(
      dry.counts.nodes,
    );
  });

  it("refuses a project that already holds a tree, and leaves it untouched", () => {
    const store = openStore();
    seed(store);
    const exported = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.44.0",
      exportedAt: AT,
    });
    const before = store.listNodes(P, { includeArchived: true }).length;

    expect(() => runImport(store, { file: exported.file })).toThrow(
      /already has \d+ live node/,
    );
    expect(() => runImport(store, { file: exported.file, dryRun: true })).toThrow(
      /already has \d+ live node/,
    );
    expect(store.listNodes(P, { includeArchived: true })).toHaveLength(before);
  });

  it("accepts an archive whose project is empty of live nodes (all archived)", () => {
    const store = openStore();
    const seeded = seed(store);
    const exported = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.44.0",
      exportedAt: AT,
    });
    store.archiveNode({ projectKey: P, id: seeded.root.id, actor: ACTOR });

    const report = runImport(store, { file: exported.file });
    // The archived originals are invisible to the emptiness check, so the tree
    // comes back live next to them.
    expect(store.listNodes(P)).toHaveLength(report.counts.nodes);
    expect(store.listNodes(P, { includeArchived: true }).length).toBeGreaterThan(
      report.counts.nodes,
    );
  });

  it("adds the audit rows a tree-only file does not carry", () => {
    const store = openStore();
    seed(store);
    const exported = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.44.0",
      exportedAt: AT,
      includeHistory: false,
    });

    const report = runImport(store, { file: exported.file, projectKey: Q });
    expect(report.counts.history).toBe(0);
    expect(report.written.history).toBe(report.counts.nodes + 1 + 1 + 1 + 1);

    const leaf = store
      .listNodes(Q)
      .find((node) => node.name === "retry failed charges");
    const history = store.listHistory(Q, leaf?.id ?? "");
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe("create");
    expect(history[0]?.result).toMatch(/^imported leaf "retry failed charges"$/);
  });

  it("reads a bare .json as well as the archive", () => {
    const store = openStore();
    seed(store);
    const document = docOf(store);
    const file = path.join(tempDir(), "project.json");
    writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);

    const report = runImport(store, { file, projectKey: Q });
    expect(report.counts.nodes).toBe(document.nodes.length);
    expect(names(store, Q)).toEqual(names(store, P));
  });

  it("names the file in every refusal: relative, missing, not a zip, wrong entry count", () => {
    const store = openStore();
    seed(store);
    expect(() => runImport(store, { file: "backup.json.zip" })).toThrow(
      /must be absolute/,
    );
    const missing = path.join(tempDir(), "nope.json.zip");
    expect(() => runImport(store, { file: missing })).toThrow(/not found/);

    const garbage = path.join(tempDir(), "garbage.json.zip");
    writeFileSync(garbage, "this is not a zip");
    expect(() => readImportDocument(garbage)).toThrow(/not a readable zip archive/);

    const twoEntries = path.join(tempDir(), "two.json.zip");
    writeFileSync(
      twoEntries,
      zipSync({ "a.json": strToU8("{}"), "b.json": strToU8("{}") }),
    );
    expect(() => readImportDocument(twoEntries)).toThrow(
      /exactly one \.json entry, it holds 2/,
    );

    const notAnExport = path.join(tempDir(), "other.json");
    writeFileSync(notAnExport, '{"format":"something-else"}');
    expect(() => readImportDocument(notAnExport)).toThrow(
      /not a luck-planner export/,
    );
  });

  it("imports the same file twice into two projects without collisions", () => {
    const store = openStore();
    seed(store);
    const exported = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.44.0",
      exportedAt: AT,
    });
    const first = runImport(store, { file: exported.file, projectKey: Q });
    const second = runImport(store, {
      file: exported.file,
      projectKey: "/projects/third",
    });
    expect(first.counts).toEqual(second.counts);

    const ids = new Set([
      ...store.listNodes(Q).map((node) => node.id),
      ...store.listNodes("/projects/third").map((node) => node.id),
    ]);
    expect(ids.size).toBe(first.counts.nodes * 2);
    expect(store.listBees(Q)).toHaveLength(1);
    expect(store.listBees("/projects/third")).toHaveLength(1);
  });
});
