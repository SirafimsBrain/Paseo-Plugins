import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { groupByProject, readChangesSince, type TreeChange } from "../server/change-feed";
import {
  agentCandidates,
  keyFactFor,
  notifyTimelineChange,
  rowFor,
  timelineSink,
  type TimelinePaseo,
  type TimelineSink,
} from "../server/timeline";
import { LuckPlannerStore } from "../server/store";
import {
  LUCK_PLANNER_TIMELINE_KIND,
  LUCK_PLANNER_TIMELINE_VERSION,
  MAX_TIMELINE_DATA_BYTES,
  buildTimelineItem,
  formatTimelineTime,
  timelineDataBytes,
  timelineDataSchema,
  timelineRowText,
  truncateToBytes,
  utf8ByteLength,
} from "../shared/timeline";
import type { HistoryEntry, Node } from "../shared/tree";

/**
 * Stage H2 acceptance (`PLAN.md`): agent timeline rows about the two key
 * facts — a goal crossing the approval gate, a leaf reaching `done`.
 *
 * The discipline is the repo's own: real artifacts everywhere the boundary
 * allows (a file-backed SQLite store, real audit rows, the real change feed
 * running inside `contribute`), and exactly one fake — the Paseo daemon
 * handle, which no test process can own. The wiring tests deliberately write
 * through a **second connection to the same file**, the model of the agent's
 * MCP process (ADR-3), because "the agent drove a leaf to done and its
 * timeline says so" is the scenario this stage exists for.
 */

const P = "/projects/demo";
const OTHER = "/projects/other";
const AGENT = "11111111-2222-4333-8444-555555555555";
const OTHER_AGENT = "99999999-8888-4777-a666-555555555555";
const NOW = 1_760_000_000_000;

// ── fixtures ─────────────────────────────────────────────────────────────

const openStores: LuckPlannerStore[] = [];
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A store on its own file — the isolated home for the non-wiring tests. */
function fileStore(): LuckPlannerStore {
  const store = new LuckPlannerStore({
    dbPath: path.join(tempDir("luck-timeline-"), "luck-planner.db"),
  });
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** Audit-row fixture for the pure classifier. */
function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 1,
    projectKey: P,
    entityType: "node",
    entityId: "00000000-0000-4000-8000-000000000001",
    action: "status",
    revision: 5,
    actor: AGENT,
    result: "in_progress → done",
    at: NOW,
    ...overrides,
  };
}

/** root → trunk → branch (+ two leaves), the shape every suite seeds. */
function seedTree(
  store: LuckPlannerStore,
  actor: string,
  projectKey: string = P,
): { root: Node; trunk: Node; branch: Node; leaf: Node; other: Node } {
  const root = store.createNode({
    projectKey,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor,
  });
  const trunk = store.createNode({
    projectKey,
    parentId: root.id,
    kind: "trunk",
    name: "Platform",
    actor,
  });
  const branch = store.createNode({
    projectKey,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor,
  });
  const leaf = store.createNode({
    projectKey,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    actor,
  });
  const other = store.createNode({
    projectKey,
    parentId: branch.id,
    kind: "leaf",
    name: "prorate refunds",
    actor,
  });
  return { root, trunk, branch, leaf, other };
}

/** Walks the legal pipeline draft → … → done (the store refuses shortcuts). */
function driveToDone(
  store: LuckPlannerStore,
  leafId: string,
  actor: string,
  projectKey: string = P,
): void {
  for (const status of ["ready", "claimed", "in_progress", "done"] as const) {
    store.setStatus({ projectKey, id: leafId, status, actor });
  }
}

/** Audit rows written after `sinceId`, grouped per project like the feed. */
function changesFrom(store: LuckPlannerStore, sinceId: number): TreeChange[] {
  const batch = readChangesSince(store, sinceId);
  const grouped = groupByProject(batch.changes);
  return [...grouped].map(([projectKey, changes]) => ({
    projectKey,
    watermark: batch.watermark,
    changes,
  }));
}

/** The newest audit row written after `sinceId` — the fact under test. */
function lastRowSince(store: LuckPlannerStore, sinceId: number): HistoryEntry {
  const rows = store.listChangesSince(sinceId, 100);
  const entry = rows[rows.length - 1];
  if (entry === undefined) throw new Error("expected at least one audit row");
  return entry;
}

interface RecordingSink extends TimelineSink {
  probes: string[];
  appends: Array<{ agentId: string; item: ReturnType<typeof buildTimelineItem> }>;
}

function recordingSink(known: string[] = [AGENT]): RecordingSink {
  const probes: string[] = [];
  const appends: Array<{
    agentId: string;
    item: ReturnType<typeof buildTimelineItem>;
  }> = [];
  return {
    probes,
    appends,
    async isAgent(candidate: string): Promise<boolean> {
      probes.push(candidate);
      return known.includes(candidate);
    },
    async append(agentId: string, item): Promise<void> {
      appends.push({ agentId, item });
    },
  };
}

// ── 1. which audit rows are key facts ────────────────────────────────────

describe("key facts in the audit trail", () => {
  it("recognises a leaf reaching done", () => {
    expect(keyFactFor(historyEntry())).toBe("leaf-done");
    expect(
      keyFactFor(historyEntry({ result: "blocked → done" })),
    ).toBe("leaf-done");
  });

  it("ignores every other transition", () => {
    for (const result of [
      "draft → ready",
      "ready → claimed",
      "claimed → in_progress",
      "in_progress → blocked",
      "blocked → in_progress",
      "in_progress → cancelled",
      "done → superseded",
    ]) {
      expect(keyFactFor(historyEntry({ result })), result).toBeNull();
    }
  });

  it("ignores node rows that are not status transitions", () => {
    for (const action of ["create", "update", "link", "archive", "restore"] as const) {
      expect(keyFactFor(historyEntry({ action })), action).toBeNull();
    }
  });

  it("recognises only the approval itself among goal rows", () => {
    const base: Partial<HistoryEntry> = {
      entityType: "goal",
      entityId: "00000000-0000-4000-8000-000000000009",
      result: "approved under parent 00000000-0000-4000-8000-000000000002",
    };
    expect(keyFactFor(historyEntry({ ...base, action: "approve" }))).toBe(
      "goal-approved",
    );
    for (const action of ["create", "status", "materialize", "reject"] as const) {
      expect(keyFactFor(historyEntry({ ...base, action })), action).toBeNull();
    }
  });

  it("never fires for bees, bugs or growth records", () => {
    for (const entityType of ["bee", "bug", "growth"] as const) {
      expect(keyFactFor(historyEntry({ entityType, action: "status" })), entityType).toBeNull();
      expect(
        keyFactFor(historyEntry({ entityType, action: "update" })),
        entityType,
      ).toBeNull();
    }
  });
});

// ── key facts build a row ────────────────────────────────────────────────

describe("rowFor (payload of one fact)", () => {
  it("describes the leaf with its transition and revision", () => {
    const store = fileStore();
    const { leaf } = seedTree(store, AGENT);
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, AGENT);
    const entry = lastRowSince(store, before);
    expect(entry).toBeDefined();

    const row = rowFor(store, "leaf-done", entry!);
    expect(row).toMatchObject({
      event: "leaf-done",
      projectKey: P,
      entityId: leaf.id,
      revision: entry!.revision,
      name: "retry failed charges",
      actor: AGENT,
      at: entry!.at,
      note: "in_progress → done",
    });
  });

  it("describes an approved goal with its step count", () => {
    const store = fileStore();
    const { branch } = seedTree(store, AGENT);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "migrate billing",
      plan: [
        { id: "step-1", title: "add columns", description: "" },
        { id: "step-2", title: "backfill", description: "" },
        { id: "step-3", title: "switch reads", description: "" },
      ],
      actor: AGENT,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: AGENT });
    const before = store.latestHistoryId();
    store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: "user",
    });
    const approval = store
      .listHistory(P, goal.id)
      .filter((entry) => entry.id > before && entry.action === "approve")[0];
    expect(approval).toBeDefined();

    const row = rowFor(store, "goal-approved", approval!);
    expect(row).toMatchObject({
      event: "goal-approved",
      entityId: goal.id,
      name: "migrate billing",
      actor: "user",
      note: "3 steps",
      revision: approval!.revision,
    });
  });

  it("refuses facts whose entity is not what they claim", () => {
    const store = fileStore();
    const { branch } = seedTree(store, AGENT);
    // A branch cannot carry a leaf transition (the store forbids it; the
    // classifier must not paper over a future store change either).
    expect(
      rowFor(store, "leaf-done", historyEntry({ entityId: branch.id })),
    ).toBeNull();
    expect(
      rowFor(store, "leaf-done", historyEntry({ entityId: "00000000-0000-4000-8000-0000000000ff" })),
    ).toBeNull();
    expect(
      rowFor(store, "goal-approved", historyEntry({ entityType: "goal" })),
    ).toBeNull();
  });
});

// ── 2. the row itself (shared/timeline) ─────────────────────────────────

describe("buildTimelineItem (the SDK's 64 KiB contract)", () => {
  const base = {
    event: "leaf-done",
    projectKey: P,
    entityId: "00000000-0000-4000-8000-000000000001",
    revision: 7,
    name: "retry failed charges",
    actor: AGENT,
    at: NOW,
    note: "in_progress → done",
  } as const;

  it("stamps the shared kind, version and a stable id", () => {
    const item = buildTimelineItem(base);
    expect(item.type).toBe("plugin");
    expect(item.kind).toBe(LUCK_PLANNER_TIMELINE_KIND);
    expect(item.version).toBe(LUCK_PLANNER_TIMELINE_VERSION);
    // Re-appending the same id replaces the row; a later revision is new.
    expect(item.id).toBe(
      `lp-leaf-done-${base.entityId}-r7`,
    );
    expect(buildTimelineItem({ ...base, revision: 8 }).id).not.toBe(item.id);
    expect(
      buildTimelineItem({ ...base, event: "goal-approved" }).id,
    ).not.toBe(item.id);
  });

  it("produces data the registered schema accepts", () => {
    const item = buildTimelineItem(base);
    expect(timelineDataSchema.parse(item.data)).toEqual(item.data);
    // The same holds for an adversarial row — see the cap test below —
    // because a schema rejection is exactly what renders as
    // "Plugin timeline item unavailable".
    const huge = buildTimelineItem({
      ...base,
      name: "x".repeat(500_000),
      projectKey: `/${"p".repeat(10_000)}`,
      note: "n".repeat(10_000),
    });
    expect(timelineDataSchema.parse(huge.data)).toEqual(huge.data);
  });

  it("keeps data under the 64 KiB cap for adversarial input", () => {
    const nasty = buildTimelineItem({
      ...base,
      // NULs escape to six ASCII bytes each; the emoji exercises surrogate pairs.
      name: `${"\u0000".repeat(60_000)}💡`,
      actor: "a".repeat(50_000),
      note: "→".repeat(30_000),
      projectKey: `/${"кириллица/".repeat(3_000)}`,
    });
    expect(timelineDataBytes(nasty.data)).toBeLessThanOrEqual(
      MAX_TIMELINE_DATA_BYTES,
    );
    expect(utf8ByteLength(nasty.data.name)).toBeLessThanOrEqual(2_048);
    expect(timelineDataSchema.parse(nasty.data)).toEqual(nasty.data);
  });

  it("clamps single fields without splitting code points", () => {
    expect(truncateToBytes("💡💡💡", 0)).toBe("");
    expect(truncateToBytes("💡💡💡", 4)).toBe("💡");
    expect(truncateToBytes("💡💡", 99)).toBe("💡💡");
    expect(utf8ByteLength("💡")).toBe(4);
    expect(utf8ByteLength("ы")).toBe(2);

    const item = buildTimelineItem({
      ...base,
      name: "n".repeat(100_000),
      actor: "a".repeat(100_000),
    });
    expect(utf8ByteLength(item.data.name)).toBeLessThanOrEqual(2_048);
    expect(utf8ByteLength(item.data.actor)).toBeLessThanOrEqual(256);
  });
});

describe("row view-model (what a reader sees)", () => {
  it("spells the event out and names the actor as the reader", () => {
    const approved = timelineRowText({
      event: "goal-approved",
      projectKey: P,
      entityId: "00000000-0000-4000-8000-000000000001",
      name: "migrate billing",
      actor: "user",
      at: NOW,
      note: "3 steps",
    });
    expect(approved).toEqual({
      glyph: "🎯",
      label: "Goal approved",
      name: "migrate billing",
      meta: `${formatTimelineTime(NOW)} · by you · 3 steps`,
    });

    const done = timelineRowText({
      event: "leaf-done",
      projectKey: P,
      entityId: "00000000-0000-4000-8000-000000000001",
      name: "retry failed charges",
      actor: AGENT,
      at: NOW,
      note: "in_progress → done",
    });
    expect(done.glyph).toBe("✅");
    expect(done.label).toBe("Leaf done");
    expect(done.meta).toContain(`by ${AGENT}`);
    expect(done.meta).toContain("in_progress → done");
  });

  it("omits an empty note and formats a minute-level stamp", () => {
    const text = timelineRowText({
      event: "leaf-done",
      projectKey: P,
      entityId: "00000000-0000-4000-8000-000000000001",
      name: "x",
      actor: "user",
      at: NOW,
      note: "",
    });
    expect(text.meta).toBe(`${formatTimelineTime(NOW)} · by you`);
    expect(formatTimelineTime(NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

// ── 3. who receives the row ──────────────────────────────────────────────

describe("agentCandidates (resolving the responsible agent)", () => {
  it("puts the acting agent first", () => {
    const store = fileStore();
    const { leaf } = seedTree(store, AGENT);
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, AGENT);
    const entry = lastRowSince(store, before);
    expect(agentCandidates(store, entry!)).toEqual([AGENT]);
  });

  it("skips the human actor and offers the goal's proposer", () => {
    const store = fileStore();
    const { branch } = seedTree(store, AGENT);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "migrate billing",
      plan: [{ id: "step-1", title: "add columns", description: "" }],
      actor: AGENT,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: AGENT });
    const before = store.latestHistoryId();
    store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: "user",
    });
    const approval = store
      .listHistory(P, goal.id)
      .filter((entry) => entry.id > before && entry.action === "approve")[0];

    expect(approval?.actor).toBe("user");
    expect(agentCandidates(store, approval!)).toEqual([AGENT]);
  });

  it("orders the acting agent ahead of earlier workers of the same entity", () => {
    const store = fileStore();
    const { leaf } = seedTree(store, AGENT);
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, "agent:coder");
    const entry = lastRowSince(store, before);
    expect(agentCandidates(store, entry!)).toEqual(["agent:coder", AGENT]);
  });

  it("offers nothing when every actor is the human", () => {
    const store = fileStore();
    const { leaf } = seedTree(store, "user");
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, "user");
    const entry = lastRowSince(store, before);
    expect(agentCandidates(store, entry!)).toEqual([]);
  });

  it("deduplicates and caps the round trips it can cause", () => {
    const store = fileStore();
    const { leaf } = seedTree(store, AGENT);
    for (let i = 1; i <= 10; i += 1) {
      store.updateNode({
        projectKey: P,
        id: leaf.id,
        name: `rename ${i}`,
        actor: `agent-${i}`,
      });
    }
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, "agent-final");
    const entry = lastRowSince(store, before);

    const candidates = agentCandidates(store, entry!);
    expect(candidates[0]).toBe("agent-final");
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates).toHaveLength(8);
  });
});

// ── 4. from audit batch to appended row ───────────────────────────────────

describe("notifyTimelineChange (real store, recording sink)", () => {
  it("delivers one row for the agent that drove a leaf to done", async () => {
    const store = fileStore();
    const { leaf } = seedTree(store, AGENT);
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, AGENT);
    const sink = recordingSink();

    const [change] = changesFrom(store, before);
    await notifyTimelineChange(change!, { store, sink });

    // Four transitions in the batch; only `→ done` is a key fact.
    expect(sink.probes).toEqual([AGENT]);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0].agentId).toBe(AGENT);
    expect(sink.appends[0].item.kind).toBe(LUCK_PLANNER_TIMELINE_KIND);
    expect(sink.appends[0].item.version).toBe(LUCK_PLANNER_TIMELINE_VERSION);
    expect(sink.appends[0].item.data).toMatchObject({
      event: "leaf-done",
      projectKey: P,
      entityId: leaf.id,
      name: "retry failed charges",
      actor: AGENT,
      note: "in_progress → done",
    });
    expect(timelineDataSchema.parse(sink.appends[0].item.data)).toBeTruthy();
  });

  it("tells the agent that proposed a goal a human approved it", async () => {
    const store = fileStore();
    const { branch } = seedTree(store, AGENT);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "migrate billing",
      plan: [
        { id: "step-1", title: "add columns", description: "" },
        { id: "step-2", title: "backfill", description: "" },
      ],
      actor: AGENT,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: AGENT });
    const before = store.latestHistoryId();
    store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: "user",
    });
    const sink = recordingSink();

    const [change] = changesFrom(store, before);
    await notifyTimelineChange(change!, { store, sink });

    // The approval batch also carries the materialized nodes' `create` rows.
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0].agentId).toBe(AGENT);
    expect(sink.appends[0].item.id.startsWith(`lp-goal-approved-${goal.id}-r`)).toBe(
      true,
    );
    expect(sink.appends[0].item.data).toMatchObject({
      event: "goal-approved",
      name: "migrate billing",
      actor: "user",
      note: "2 steps",
    });
  });

  it("does nothing when no agent ever touched the entity", async () => {
    const store = fileStore();
    const { branch, leaf } = seedTree(store, "user");
    driveToDone(store, leaf.id, "user");
    const goal = store.createGoal({
      projectKey: P,
      formalText: "panel-only goal",
      plan: [{ id: "step-1", title: "a", description: "" }],
      actor: "user",
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: "user" });
    const before = store.latestHistoryId();
    store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: "user",
    });
    const sink = recordingSink();

    const [change] = changesFrom(store, before);
    await notifyTimelineChange(change!, { store, sink });

    expect(sink.probes).toEqual([]);
    expect(sink.appends).toEqual([]);
  });

  it("probes an unverifiable actor and stops when it is no agent", async () => {
    const store = fileStore();
    const { leaf } = seedTree(store, "someone-was-here");
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, "someone-was-here");
    const sink = recordingSink([AGENT]);

    const [change] = changesFrom(store, before);
    await notifyTimelineChange(change!, { store, sink });

    expect(sink.probes).toEqual(["someone-was-here"]);
    expect(sink.appends).toEqual([]);
  });

  it("scopes a row to the project on its own audit row", async () => {
    const store = fileStore();
    seedTree(store, AGENT, P);
    const foreign = seedTree(store, OTHER_AGENT, OTHER);
    const before = store.latestHistoryId();
    driveToDone(store, foreign.leaf.id, OTHER_AGENT, OTHER);
    const sink = recordingSink([AGENT, OTHER_AGENT]);

    for (const change of changesFrom(store, before)) {
      await notifyTimelineChange(change, { store, sink });
    }
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0].agentId).toBe(OTHER_AGENT);
    expect(sink.appends[0].item.data.projectKey).toBe(OTHER);
  });

  it("leaves unrelated audit rows entirely alone", async () => {
    const store = fileStore();
    const { leaf, other } = seedTree(store, AGENT);
    store.setStatus({ projectKey: P, id: leaf.id, status: "ready", actor: AGENT });
    store.updateNode({ projectKey: P, id: other.id, name: "renamed", actor: AGENT });
    store.createBee({
      projectKey: P,
      sourceLeafId: leaf.id,
      targetLeafId: other.id,
      impact: "blocks",
      actor: AGENT,
    });
    const before = store.latestHistoryId();
    store.createBug({
      projectKey: P,
      title: "flaky test",
      severity: "medium",
      nodeIds: [leaf.id],
      actor: AGENT,
    });
    const sink = recordingSink();

    const [change] = changesFrom(store, before);
    await notifyTimelineChange(change!, { store, sink });

    expect(sink.probes).toEqual([]);
    expect(sink.appends).toEqual([]);
  });

  it("reports a rejected append without breaking the batch", async () => {
    const store = fileStore();
    const { leaf, other } = seedTree(store, AGENT);
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, AGENT);
    store.updateNode({ projectKey: P, id: other.id, name: "renamed", actor: AGENT });
    const errors: string[] = [];
    const sink = recordingSink();
    sink.append = async () => {
      throw new Error("host predates pluginTimelineItems");
    };

    const [change] = changesFrom(store, before);
    await expect(
      notifyTimelineChange(change!, {
        store,
        sink,
        logError: (message) => errors.push(message),
      }),
    ).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("host predates pluginTimelineItems");
    expect(errors.join("\n")).toContain(leaf.id);
  });

  it("says so honestly when no SDK handle exists yet", async () => {
    const store = fileStore();
    const { leaf } = seedTree(store, AGENT);
    const before = store.latestHistoryId();
    driveToDone(store, leaf.id, AGENT);
    const lines: string[] = [];

    const [change] = changesFrom(store, before);
    await expect(
      notifyTimelineChange(change!, {
        store,
        sink: null,
        log: (message) => lines.push(message),
      }),
    ).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("no Paseo SDK handle yet");
    expect(lines.join("\n")).toContain("leaf-done");
  });
});

// ── 5. the Paseo adapter ─────────────────────────────────────────────────

describe("timelineSink (SDK handle adapter)", () => {
  function fakePaseo(options?: {
    known?: string[];
    refreshThrows?: boolean;
    appendThrows?: string;
  }): {
    paseo: TimelinePaseo;
    appended: Array<{ agentId: string; item: unknown }>;
  } {
    const known = options?.known ?? [AGENT];
    const appended: Array<{ agentId: string; item: unknown }> = [];
    const paseo: TimelinePaseo = {
      agents: {
        ref(id: string) {
          return {
            async refresh(): Promise<unknown> {
              if (options?.refreshThrows) throw new Error("agent not found");
              return known.includes(id) ? { agent: { id } } : null;
            },
            timeline: {
              async append(item: unknown): Promise<unknown> {
                if (options?.appendThrows) throw new Error(options.appendThrows);
                appended.push({ agentId: id, item });
                return { seq: 1, epoch: "epoch" };
              },
            },
          };
        },
      },
    };
    return { paseo, appended };
  }

  const item = () =>
    buildTimelineItem({
      event: "leaf-done",
      projectKey: P,
      entityId: "00000000-0000-4000-8000-000000000001",
      revision: 5,
      name: "retry failed charges",
      actor: AGENT,
      at: NOW,
      note: "in_progress → done",
    });

  it("answers isAgent from the daemon and never throws", async () => {
    const sink = timelineSink(fakePaseo({ known: [AGENT] }).paseo);
    await expect(sink.isAgent(AGENT)).resolves.toBe(true);
    await expect(sink.isAgent("user")).resolves.toBe(false);

    // A host that rejects unknown ids outright must not break the batch.
    const hostile = timelineSink(fakePaseo({ refreshThrows: true }).paseo);
    await expect(hostile.isAgent(AGENT)).resolves.toBe(false);
  });

  it("forwards the row to that agent's timeline handle", async () => {
    const { paseo, appended } = fakePaseo();
    await timelineSink(paseo).append(AGENT, item());
    expect(appended).toEqual([{ agentId: AGENT, item: item() }]);
  });

  it("lets an append failure surface to the caller", async () => {
    const { paseo } = fakePaseo({ appendThrows: "data exceeds 64 KiB" });
    await expect(timelineSink(paseo).append(AGENT, item())).rejects.toThrow(
      "data exceeds 64 KiB",
    );
  });
});

// ── 6. wiring in the server entry ────────────────────────────────────────

interface WiringServer {
  call<T>(name: string, input: unknown, context?: unknown): Promise<T>;
  openSession(agentId: string, paseo: unknown): Promise<void>;
}

/**
 * Minimal `PluginServerContext` that records handlers and hooks so a test can
 * invoke them the way the daemon does — including the context argument that
 * carries `paseo` (the SDK hands it to every hook and RPC handler).
 */
function createWiringServer(): WiringServer {
  const handlers = new Map<string, (input: never, context: never) => unknown>();
  const hooks = new Map<string, (args: never, context: never) => unknown>();
  const server = {
    registerSettings() {
      return {
        async read() {
          return {
            status: "ready" as const,
            revision: "1",
            values: {
              injectIntoAgents: true,
              mcpServerName: "luck-planner",
              // Hermetic: this suite exercises the timeline feed, not the
              // dashboard socket (covered by tests/http-lifecycle.test.ts).
              httpEnabled: false,
            },
          };
        },
        subscribe() {
          return () => {};
        },
      };
    },
    handle(contract: { name: string }, handler: (input: never, context: never) => unknown) {
      handlers.set(contract.name, handler);
    },
    before(name: string, handler: (args: never, context: never) => unknown) {
      hooks.set(name, handler);
      return () => {
        hooks.delete(name);
      };
    },
    on() {
      return () => {};
    },
    registerProvider() {},
    registerUsageSource() {},
    async call<T>(name: string, input: unknown, context?: unknown): Promise<T> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      return (await handler(input as never, context as never)) as T;
    },
    async openSession(agentId: string, paseo: unknown): Promise<void> {
      const hook = hooks.get("agent.session_open");
      if (!hook) throw new Error("agent.session_open hook was not registered");
      await hook(
        {
          request: {
            agentId,
            workspaceId: null,
            provider: "codex",
            cwd: "/projects/demo",
            reason: "resume",
            purpose: "interactive",
            env: {},
          },
        } as never,
        { paseo, signal: new AbortController().signal } as never,
      );
    },
  };
  return server as unknown as WiringServer;
}

/** Daemon-shaped handle whose appends are recorded. */
function fakeDaemonPaseo(): {
  paseo: unknown;
  appends: Array<{ agentId: string; item: { kind: string; data: unknown } }>;
} {
  const appends: Array<{ agentId: string; item: { kind: string; data: unknown } }> = [];
  const paseo = {
    agents: {
      ref(id: string) {
        return {
          async refresh(): Promise<unknown> {
            return id === AGENT ? { agent: { id } } : null;
          },
          timeline: {
            async append(item: { kind: string; data: unknown }): Promise<unknown> {
              appends.push({ agentId: id, item });
              return { seq: appends.length, epoch: "epoch" };
            },
          },
        };
      },
    },
  };
  return { paseo, appends };
}

describe("wiring in index.server (the production change feed)", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = tempDir("luck-home-");
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalHome;
  });

  it("delivers an agent's own done-leaf row from a second DB connection", async () => {
    const wiring = createWiringServer();
    const { paseo, appends } = fakeDaemonPaseo();
    const cleanup = contribute(wiring as unknown as PluginServerContext);
    try {
      // The daemon opens a session → the hook hands over the SDK handle.
      await wiring.openSession(AGENT, paseo);

      // A separate connection to the same file: exactly how the agent's MCP
      // process writes (ADR-3), and why the feed polls instead of hooks.
      const agentSide = new LuckPlannerStore();
      openStores.push(agentSide);
      const { leaf } = seedTree(agentSide, AGENT);
      driveToDone(agentSide, leaf.id, AGENT);

      await vi.waitFor(
        () => {
          expect(appends.length).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 50 },
      );
      expect(appends[0].agentId).toBe(AGENT);
      expect(appends[0].item.kind).toBe(LUCK_PLANNER_TIMELINE_KIND);
      expect(appends[0].item.data).toMatchObject({
        event: "leaf-done",
        entityId: leaf.id,
        name: "retry failed charges",
        actor: AGENT,
      });
    } finally {
      await cleanup();
    }
  });

  it("learns the SDK handle from a plain RPC call (panel-only flow)", async () => {
    const wiring = createWiringServer();
    const { paseo, appends } = fakeDaemonPaseo();
    const cleanup = contribute(wiring as unknown as PluginServerContext);
    try {
      // Seed through a second connection, then move the leaf from the panel:
      // no agent session opened, so the handler context is the only place the
      // handle can come from.
      const agentSide = new LuckPlannerStore();
      openStores.push(agentSide);
      const { leaf } = seedTree(agentSide, AGENT);

      const context = { paseo, signal: new AbortController().signal };
      for (const status of ["ready", "claimed", "in_progress", "done"] as const) {
        const result = await wiring.call<{ ok: boolean; error: string | null }>(
          "luck-planner.node-set-status",
          { projectKey: P, nodeId: leaf.id, status, actor: AGENT },
          context,
        );
        expect(result.ok).toBe(true);
      }

      await vi.waitFor(
        () => {
          expect(appends.length).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 50 },
      );
      expect(appends[0].item.data).toMatchObject({
        event: "leaf-done",
        entityId: leaf.id,
        actor: AGENT,
      });
    } finally {
      await cleanup();
    }
  });

  it("stops polling once the entry cleanup has run", async () => {
    const wiring = createWiringServer();
    const { paseo, appends } = fakeDaemonPaseo();
    const cleanup = contribute(wiring as unknown as PluginServerContext);
    await wiring.openSession(AGENT, paseo);
    await cleanup();

    const agentSide = new LuckPlannerStore();
    openStores.push(agentSide);
    const { leaf } = seedTree(agentSide, AGENT);
    driveToDone(agentSide, leaf.id, AGENT);
    // One full poll interval with slack: a live feed would have delivered.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(appends).toEqual([]);
  });
});

// ── 7. the client half of the contract ─────────────────────────────────

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("renderer registration (client entry)", () => {
  it("registers the renderer with the shared kind, version and schema", () => {
    const source = readFileSync(path.join(PLUGIN_ROOT, "index.client.tsx"), "utf8");
    // The daemon builds rows from `shared/timeline.ts`; this is the other
    // half of the pair. A drift on either side is what the host renders as
    // "Plugin timeline item unavailable", so the pair is pinned here.
    expect(source).toMatch(/client\.addTimelineRenderer\(\{/);
    expect(source).toMatch(/kind:\s*LUCK_PLANNER_TIMELINE_KIND/);
    expect(source).toMatch(/version:\s*LUCK_PLANNER_TIMELINE_VERSION/);
    expect(source).toMatch(/schema:\s*timelineDataSchema/);
    expect(source).toMatch(/Component:\s*LuckPlannerTimelineRow/);
  });

  it("keeps the row inside the cross-platform client rules", () => {
    for (const file of ["client/timeline-row.tsx", "index.client.tsx"]) {
      const source = readFileSync(path.join(PLUGIN_ROOT, file), "utf8");
      expect(source, file).not.toMatch(
        /document\.|window\.|localStorage|navigator\.|className=|onClick=/,
      );
      expect(source, file).not.toMatch(/from\s+["']node:/);
    }
  });

  it("hands the renderer exactly the schema the server builds against", () => {
    const source = readFileSync(path.join(PLUGIN_ROOT, "index.client.tsx"), "utf8");
    expect(source).toMatch(/from \"\.\/shared\/timeline\"/);
    const item = buildTimelineItem({
      event: "goal-approved",
      projectKey: P,
      entityId: "00000000-0000-4000-8000-000000000001",
      revision: 3,
      name: "migrate billing",
      actor: "user",
      at: NOW,
      note: "1 step",
    });
    // What the host validates the payload with before drawing it.
    expect(timelineDataSchema.parse(item.data)).toEqual(item.data);
    expect(timelineRowText(item.data).label).toBe("Goal approved");
  });
});
