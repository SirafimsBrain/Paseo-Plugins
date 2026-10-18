import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChangeFeed,
  DEFAULT_POLL_MS,
  groupByProject,
  readChangesSince,
  type TreeChange,
} from "../server/change-feed";
import { DEFAULT_CHANGE_BATCH, LuckPlannerStore } from "../server/store";
import type { HistoryEntry } from "../shared/tree";

/**
 * Stage H1 acceptance (`PLAN.md`): the change feed that turns the append-only
 * audit trail into "project X moved" notifications.
 *
 * The suite pins what the stage is *for*: a write made through **another
 * connection to the same file** (what an agent process is) shows up, the feed
 * never replays the trail it starts from, a burst is one notification per
 * project, and a broken database ends the feed instead of spamming the log.
 */

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:coder";

let dir: string;
let store: LuckPlannerStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "luck-planner-feed-"));
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // A test may have closed it already.
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Writes one node through the given store and returns its id. */
function writeRoot(target: LuckPlannerStore, projectKey = P, name = "Root"): string {
  return target.createNode({
    projectKey,
    parentId: null,
    kind: "root",
    name,
    actor: ACTOR,
  }).id;
}

/** A feed whose notifications are collected instead of broadcast. */
function feedWith(
  options: { pollMs?: number; batchLimit?: number; maxRowsPerTick?: number } = {},
): { feed: ChangeFeed; seen: TreeChange[]; errors: string[] } {
  const seen: TreeChange[] = [];
  const errors: string[] = [];
  const feed = new ChangeFeed({
    store,
    onChange: (change) => seen.push(change),
    onError: (message) => errors.push(message),
    ...options,
  });
  return { feed, seen, errors };
}

describe("readChangesSince", () => {
  it("reads only rows newer than the cursor, oldest first, across projects", () => {
    writeRoot(store);
    const cursor = store.latestHistoryId();
    const first = writeRoot(store, OTHER, "Other");
    const second = writeRoot(store);

    const batch = readChangesSince(store, cursor);
    expect(batch.more).toBe(false);
    expect(batch.changes.map((entry) => entry.entityId)).toEqual([first, second]);
    expect(batch.watermark).toBe(store.latestHistoryId());
  });

  it("stops at the cap with a watermark that never skips unreported rows", () => {
    for (let index = 0; index < 5; index += 1) writeRoot(store, P, `Root ${index}`);
    const all = store.latestHistoryId();

    let cursor = 0;
    const seen: HistoryEntry[] = [];
    let passes = 0;
    for (;;) {
      const batch = readChangesSince(store, cursor, { batchLimit: 2, maxRows: 2 });
      seen.push(...batch.changes);
      cursor = batch.watermark;
      passes += 1;
      expect(batch.changes.length).toBeLessThanOrEqual(2);
      if (!batch.more) break;
      expect(passes).toBeLessThan(10);
    }
    // Every row arrives exactly once and the last cursor is the table's head.
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((entry) => entry.id)).size).toBe(5);
    expect(cursor).toBe(all);
  });

  it("cannot be livelocked by a cursor ahead of the table", () => {
    writeRoot(store);
    const head = store.latestHistoryId();
    const batch = readChangesSince(store, head + 10_000);
    expect(batch.changes).toEqual([]);
    expect(batch.watermark).toBe(head);
  });

  it("reads a full batch from an empty trail", () => {
    const batch = readChangesSince(store, 0);
    expect(batch.changes).toEqual([]);
    expect(batch.watermark).toBe(0);
    expect(DEFAULT_CHANGE_BATCH).toBeGreaterThan(0);
  });
});

describe("groupByProject", () => {
  it("keeps the order in which projects first appear", () => {
    writeRoot(store, P, "a");
    writeRoot(store, OTHER, "b");
    writeRoot(store, P, "c");
    const grouped = groupByProject(readChangesSince(store, 0).changes);
    expect([...grouped.keys()]).toEqual([P, OTHER]);
    expect(grouped.get(P)).toHaveLength(2);
    expect(grouped.get(OTHER)).toHaveLength(1);
  });
});

describe("ChangeFeed", () => {
  it("starts from the head of the trail, never replaying it", () => {
    writeRoot(store);
    writeRoot(store);
    const { feed, seen } = feedWith();
    feed.start();
    try {
      expect(feed.active).toBe(true);
      expect(feed.lastId).toBe(store.latestHistoryId());
      expect(feed.poll()).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      feed.stop();
    }
    expect(feed.active).toBe(false);
  });

  it("reports a write made through another connection to the same file", () => {
    const { feed, seen } = feedWith();
    feed.start();
    try {
      const writer = new LuckPlannerStore({ dbPath: store.dbPath });
      const id = writeRoot(writer, P, "From an agent");
      writer.close();

      const emitted = feed.poll();
      expect(emitted).toHaveLength(1);
      expect(emitted[0].projectKey).toBe(P);
      expect(emitted[0].changes.map((entry) => entry.entityId)).toContain(id);
      expect(seen).toHaveLength(1);
      expect(feed.lastId).toBe(store.latestHistoryId());
    } finally {
      feed.stop();
    }
  });

  it("coalesces one burst into one notification per project", () => {
    const { feed, seen } = feedWith();
    feed.start();
    try {
      const writer = new LuckPlannerStore({ dbPath: store.dbPath });
      writeRoot(writer, P, "a");
      writeRoot(writer, P, "b");
      writeRoot(writer, OTHER, "c");
      writer.close();

      feed.poll();
      expect(seen.map((change) => change.projectKey)).toEqual([P, OTHER]);
      expect(seen[0].changes).toHaveLength(2);
      expect(seen[0].watermark).toBe(store.latestHistoryId());
    } finally {
      feed.stop();
    }
  });

  it("delivers rows while a listener keeps throwing", () => {
    const errors: string[] = [];
    const feed = new ChangeFeed({
      store,
      onChange: () => {
        throw new Error("listener exploded");
      },
      onError: (message) => errors.push(message),
    });
    feed.start();
    try {
      writeRoot(store);
      expect(() => feed.poll()).not.toThrow();
      // The cursor still moved: a broken listener must not resend the row.
      expect(feed.lastId).toBe(store.latestHistoryId());
      expect(errors[0]).toContain("listener failed");
    } finally {
      feed.stop();
    }
  });

  it("polls on the configured interval and stops on demand", () => {
    vi.useFakeTimers();
    try {
      const { feed, seen } = feedWith({ pollMs: 50 });
      feed.start();
      writeRoot(store);
      vi.advanceTimersByTime(49);
      expect(seen).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(seen).toHaveLength(1);

      feed.stop();
      writeRoot(store);
      vi.advanceTimersByTime(500);
      expect(seen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-primes on every start, so a long pause is not replayed", () => {
    const { feed, seen } = feedWith();
    writeRoot(store);
    feed.start();
    feed.stop();
    writeRoot(store);
    feed.start();
    try {
      // The two roots were written while the feed was down; a fresh start must
      // treat them as history, not as news.
      expect(feed.poll()).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      feed.stop();
    }
  });

  it("stops itself when the database goes away", () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let healthy = true;
    let calls = 0;
    const broken = {
      latestHistoryId: () => {
        calls += 1;
        if (!healthy) throw new Error("database is gone");
        return 0;
      },
      listChangesSince: () => {
        throw new Error("database is gone");
      },
    } as unknown as LuckPlannerStore;
    const feed = new ChangeFeed({
      store: broken,
      pollMs: 10,
      onChange: () => {},
      onError: (message) => errors.push(message),
    });
    try {
      feed.start();
      calls = 0;
      // The database disappears under a running feed — the realistic version
      // of "the plugin is shutting down and something still ticks".
      healthy = false;
      vi.advanceTimersByTime(100);
      expect(calls).toBe(3);
      expect(errors).toHaveLength(3);
      expect(errors[2]).toContain("(3/3)");
      expect(feed.active).toBe(false);
    } finally {
      feed.stop();
      vi.useRealTimers();
    }
  });

  it("defaults to a cadence that feels live without being a busy loop", () => {
    expect(DEFAULT_POLL_MS).toBeGreaterThanOrEqual(250);
    expect(DEFAULT_POLL_MS).toBeLessThanOrEqual(5000);
  });
});
