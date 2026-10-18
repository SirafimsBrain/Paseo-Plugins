/**
 * Live updates for the dashboard (PLAN.md stage H1).
 *
 * The tab subscribes to `/api/events` (SSE) instead of polling: the daemon's
 * change feed already knows *what* moved, so the dashboard only has to listen.
 * Everything here is pure over an injected {@link SseSourceFactory}, for the
 * same reason `client/open-dashboard.ts` injects its openers — the rule worth
 * pinning (merge a burst into one refetch, tell a reconnect from a first
 * connect, survive a malformed payload) must be testable without a browser and
 * without a network.
 *
 * Two behaviours are deliberate:
 *
 * - **Coalescing.** A single agent action can write several audit rows at once
 *   (approving a goal materializes a subtree), and each write is its own
 *   `tree-changed` event. Merging a short burst into one callback turns that
 *   into one refetch instead of five.
 * - **Refetch on every event, not on the payload.** The payload is decoded to
 *   know *which* node to refresh in the details panel; if it does not parse
 *   (a tab left open across a plugin update), the stream still reports the
 *   change, so the *data* self-heals even when the payload does not.
 */
import {
  readyEventSchema,
  treeChangedEventSchema,
  type TreeChangedEvent,
} from "../../shared/api";

/** The subset of the browser's `EventSource` this module uses. */
export interface SseSource {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export type SseSourceFactory = (url: string) => SseSource;

/** What the toolbar indicator renders. */
export interface ChangeStreamStatus {
  /** `live` = stream open; `offline` = errored (the browser keeps retrying). */
  state: "live" | "offline";
  /** Cursor from the `ready` payload; `null` when unknown (offline). */
  watermark: number | null;
}

export interface ChangeStreamOptions {
  /** `/api/events?token=…&project=…` — built by `DashboardApi.eventsUrl()`. */
  url: string;
  /** Called with the merged change set; refetch whatever it touches. */
  onTreeChanged: (event: TreeChangedEvent) => void;
  /** Connection state, for the toolbar indicator. */
  onStatus?: (status: ChangeStreamStatus) => void;
  /** Replaces the browser's `EventSource` (tests, non-browser hosts). */
  factory?: SseSourceFactory;
  /** Events arriving within this window are merged into one callback. */
  coalesceMs?: number;
}

export interface ChangeStreamHandle {
  close(): void;
}

/** Quiet period that turns a burst of writes into one refetch. */
export const DEFAULT_COALESCE_MS = 150;

/**
 * Decodes a `tree-changed` payload. Returns `null` for anything that is not a
 * well-formed event — a tab running against a newer server must not crash on a
 * shape it does not know.
 */
export function parseTreeChangedEvent(raw: string): TreeChangedEvent | null {
  try {
    const parsed = treeChangedEventSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Decodes a `ready` payload; `null` when it is not one. */
export function parseReadyEvent(raw: string): { version: string; watermark: number } | null {
  try {
    const parsed = readyEventSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Folds buffered events into one: all rows, the highest watermark. */
export function mergeChanges(events: readonly TreeChangedEvent[]): TreeChangedEvent {
  const first = events[0];
  let watermark = 0;
  const changes: TreeChangedEvent["changes"] = [];
  for (const event of events) {
    changes.push(...event.changes);
    if (event.watermark > watermark) watermark = event.watermark;
  }
  return { projectKey: first.projectKey, watermark, changes };
}

/**
 * Opens the change stream and returns a handle that closes it.
 *
 * When no `EventSource` is available at all (a Node test without a factory, an
 * exotic host), the function does not throw: it reports `offline` once and
 * returns an inert handle, so the dashboard still renders its data with a
 * visible "not live" indicator instead of a blank page.
 */
export function createChangeStream(options: ChangeStreamOptions): ChangeStreamHandle {
  const factory =
    options.factory ??
    (typeof globalThis.EventSource === "function"
      ? (url: string): SseSource => new globalThis.EventSource(url) as unknown as SseSource
      : null);
  if (factory === null) {
    options.onStatus?.({ state: "offline", watermark: null });
    return { close: () => {} };
  }

  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  let source: SseSource | null = null;
  let pending: TreeChangedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const flush = (): void => {
    timer = null;
    if (pending.length === 0) return;
    const merged = mergeChanges(pending);
    pending = [];
    options.onTreeChanged(merged);
  };

  const sourceFactory = factory;
  source = sourceFactory(options.url);
  source.addEventListener("open", () => {
    if (closed) return;
    options.onStatus?.({ state: "live", watermark: null });
  });
  source.addEventListener("error", () => {
    if (closed) return;
    // The browser's EventSource reconnects by itself (`retry:` on the wire);
    // the tab only has to say so.
    options.onStatus?.({ state: "offline", watermark: null });
  });
  source.addEventListener("ready", (event) => {
    if (closed) return;
    const ready = parseReadyEvent(event.data);
    options.onStatus?.({ state: "live", watermark: ready?.watermark ?? null });
  });
  source.addEventListener("tree-changed", (event) => {
    if (closed) return;
    const change = parseTreeChangedEvent(event.data);
    if (change !== null) pending.push(change);
    // Debounce on a timer rather than reading the payload: an unparsable event
    // still means "something moved", and the data must self-heal.
    else pending.push({ projectKey: "", watermark: 0, changes: [] });
    if (timer === null) timer = setTimeout(flush, coalesceMs);
  });

  return {
    close: () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = [];
      source?.close();
      source = null;
    },
  };
}
