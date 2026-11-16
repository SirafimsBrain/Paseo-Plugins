import type { CommandEvent } from "../shared/events";
import { EVENT_FEED_LIMIT } from "../shared/events";

/**
 * In-process event feed behind `command-center.events` (plugin 0.13.0).
 *
 * Producers: the executor (every recorded run), the history-append RPC (runs
 * dispatched by a non-local host's client), the schedule handlers, and the
 * session-open hook. Consumers: the subscription handler, which pushes a fresh
 * snapshot on every change.
 *
 * The feed is disposable — history.json and the daemon's schedule store stay
 * authoritative — so nothing here needs to survive a plugin reload.
 */

const feed: CommandEvent[] = [];
type Listener = (event: CommandEvent | null) => void;
const listeners = new Set<Listener>();
let sequence = 0;

/** Appends an event (newest first is the reader's view) and wakes listeners. */
export function publishCommandEvent(input: {
  kind: CommandEvent["kind"];
  title: string;
  detail: string;
  ok?: boolean | null;
  at?: string;
}): CommandEvent {
  sequence += 1;
  const event: CommandEvent = {
    id: `e_${Date.now().toString(36)}_${sequence.toString(36)}`,
    kind: input.kind,
    at: input.at ?? new Date().toISOString(),
    title: input.title,
    detail: input.detail,
    ok: input.ok ?? null,
  };
  feed.unshift(event);
  if (feed.length > EVENT_FEED_LIMIT) feed.length = EVENT_FEED_LIMIT;
  for (const listener of listeners) listener(event);
  return event;
}

/** Newest-first copy of the feed. */
export function recentCommandEvents(limit: number = EVENT_FEED_LIMIT): CommandEvent[] {
  return feed.slice(0, Math.max(0, limit));
}

/** Wakes listeners without a new event (settings change, test hooks). */
export function notifyCommandEventListeners(): void {
  for (const listener of listeners) listener(null);
}

/** Subscribes to "something happened"; returns the unsubscribe function. */
export function subscribeCommandEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Empties the feed (tests). */
export function clearCommandEvents(): void {
  feed.length = 0;
  notifyCommandEventListeners();
}
