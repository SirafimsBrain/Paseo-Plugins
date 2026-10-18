import type { HistoryEntry } from "../shared/tree";
import { DEFAULT_CHANGE_BATCH, type LuckPlannerStore } from "./store";

/**
 * Change feed (PLAN.md stage H1, `__doc.md` §6): turns the append-only audit
 * trail into "something changed in project X" notifications.
 *
 * **Why polling and not a write hook.** The native panel, the dashboard HTTP
 * server and the change feed all live in the daemon process, but agents write
 * through the bundled stdio MCP server — a *separate process* with its own
 * connection to the same SQLite file (ADR-3). A hook on
 * `LuckPlannerStore.write` would therefore see panel-driven mutations only and
 * silently miss every agent write, which is exactly the acceptance scenario of
 * this stage ("a leaf is moved by an MCP tool and both views update"). What
 * *is* shared across processes is the file, and every mutation appends exactly
 * one row to `history` — so the feed polls `history.id > watermark`, an
 * indexed read on the primary key.
 *
 * Costs, honestly: one indexed `SELECT` per tick per plugin install, and a
 * worst-case latency of one poll interval between a write and a client
 * refresh. `DEFAULT_POLL_MS` keeps that at "looks instant" without turning an
 * idle daemon into a busy loop. The feed never overlaps its own ticks, stops
 * after repeated failures (a closed database must not turn into a log storm)
 * and reports rows grouped per project, so one burst is one notification.
 */

/** One project's worth of new audit rows, as handed to a listener. */
export interface TreeChange {
  projectKey: string;
  /** Highest audit row id included in this notification. */
  watermark: number;
  /** Rows that moved the project, oldest first. Never empty. */
  changes: HistoryEntry[];
}

/** A page of audit rows plus the cursor to resume from. */
export interface ChangeBatch {
  /** Rows read, oldest first. */
  changes: HistoryEntry[];
  /** Cursor to pass to the next call: the last requested id seen. */
  watermark: number;
  /** True when the drain stopped at its cap and more rows are waiting. */
  more: boolean;
}

export interface ChangeFeedOptions {
  store: LuckPlannerStore;
  /** Called once per project per poll; never with an empty `changes`. */
  onChange: (change: TreeChange) => void;
  /** Poll period — the feed's whole latency budget. */
  pollMs?: number;
  /** Rows per statement. */
  batchLimit?: number;
  /** Rows read per tick before deferring the rest to the next tick. */
  maxRowsPerTick?: number;
  /** Feedback for a failed poll; the feed keeps running until it gives up. */
  onError?: (message: string) => void;
}

/** Poll period: fast enough to feel live, slow enough to stay invisible. */
export const DEFAULT_POLL_MS = 1_000;
/** Failed polls in a row before the feed stops itself. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Reads every audit row newer than `sinceId`, oldest first, at most
 * `maxRows` of them.
 *
 * `more: true` means the cap was hit and the caller should come back for the
 * rest — the returned `watermark` is then the last row **actually reported**,
 * never the table's newest id, so a caller that adopts it can never skip rows
 * it was not told about. A cursor at or ahead of the table head (a database
 * that was reset) is repaired in the same spirit: nothing to report, and the
 * watermark comes back as the head, so the caller catches up instead of
 * livelocking on an id that will never arrive.
 */
export function readChangesSince(
  store: LuckPlannerStore,
  sinceId: number,
  options: { batchLimit?: number; maxRows?: number } = {},
): ChangeBatch {
  const batchLimit = Math.max(1, options.batchLimit ?? DEFAULT_CHANGE_BATCH);
  const maxRows = Math.max(1, options.maxRows ?? batchLimit * 25);
  const head = store.latestHistoryId();
  const changes: HistoryEntry[] = [];
  let watermark = sinceId;
  if (sinceId >= head) return { changes, watermark: head, more: false };
  for (;;) {
    const page = store.listChangesSince(watermark, batchLimit);
    if (page.length === 0) return { changes, watermark, more: false };
    changes.push(...page);
    watermark = page[page.length - 1].id;
    if (page.length < batchLimit) return { changes, watermark, more: false };
    if (changes.length >= maxRows) return { changes, watermark, more: true };
  }
}

/** Groups rows by project, keeping the order in which projects first appear. */
export function groupByProject(changes: readonly HistoryEntry[]): Map<string, HistoryEntry[]> {
  const grouped = new Map<string, HistoryEntry[]>();
  for (const change of changes) {
    const bucket = grouped.get(change.projectKey);
    if (bucket === undefined) grouped.set(change.projectKey, [change]);
    else bucket.push(change);
  }
  return grouped;
}

export class ChangeFeed {
  /** Cursor: the newest audit row this feed has accounted for. */
  private watermark: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  /** True while a tick is reading, so a slow poll never overlaps the next. */
  private reading = false;

  constructor(private readonly options: ChangeFeedOptions) {
    this.watermark = options.store.latestHistoryId();
  }

  /** Newest audit row this feed has accounted for. */
  get lastId(): number {
    return this.watermark;
  }

  /** Whether the feed is armed (set by `start`, cleared by `stop`). */
  get active(): boolean {
    return this.timer !== null;
  }

  /**
   * Arms the timer. The watermark is re-primed here, not at construction: the
   * endpoint can stay disabled for hours, and replaying everything written in
   * the meantime would greet a client with a burst of stale events (a tab
   * refetches the whole project on connect anyway, so nothing is lost).
   * Safe to call twice.
   */
  start(): void {
    if (this.timer !== null) return;
    this.watermark = this.options.store.latestHistoryId();
    this.failures = 0;
    const timer = setInterval(() => this.tick(), this.options.pollMs ?? DEFAULT_POLL_MS);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** Disarms the timer; a poll already in flight finishes harmlessly. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Reads the rows written since the cursor and reports them grouped per
   * project. Returns what it reported, so a test (or a future "refresh now"
   * action) can drive the feed without waiting for a tick. Synchronous: the
   * SQLite driver is.
   */
  poll(): TreeChange[] {
    const batch = readChangesSince(this.options.store, this.watermark, {
      batchLimit: this.options.batchLimit,
      maxRows: this.options.maxRowsPerTick,
    });
    this.watermark = batch.watermark;

    const emitted: TreeChange[] = [];
    for (const [projectKey, changes] of groupByProject(batch.changes)) {
      emitted.push({ projectKey, watermark: batch.watermark, changes });
    }
    for (const change of emitted) {
      // A listener that throws must not cost us the cursor we already moved.
      try {
        this.options.onChange(change);
      } catch (cause) {
        this.options.onError?.(
          `change feed listener failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    return emitted;
  }

  private tick(): void {
    if (this.reading) return;
    this.reading = true;
    try {
      this.poll();
      this.failures = 0;
    } catch (cause) {
      this.failures += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.options.onError?.(
        `change feed poll failed (${this.failures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`,
      );
      // A closed or unreadable database would otherwise fail forever.
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.stop();
    } finally {
      this.reading = false;
    }
  }
}
