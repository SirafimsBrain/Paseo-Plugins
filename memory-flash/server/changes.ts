/**
 * Change feed for `memory-flash.changes` (Paseo 0.16.0 subscriptions).
 *
 * The surface has to learn about writes it did not make: an agent saves a
 * memory through the standalone MCP server, which is a *different process*
 * sharing the same SQLite file, so an in-process emitter would miss exactly
 * the case the screen needs. The store appends one row to `memory_changes` on
 * every mutation, and this feed compares the highest sequence number on a
 * short interval — one indexed read, and no notification mechanism to keep
 * alive across processes.
 *
 * The first event reports the current sequence immediately, so a subscriber
 * that connects mid-life knows where it started and the client can render
 * without waiting for the first write.
 */

/** How often the feed reads the sequence number. One indexed `MAX()` query. */
export const CHANGE_POLL_MS = 1000;

/** The only part of the store the feed needs (keeps tests trivial). */
export interface ChangeSource {
  changesSeq(): number;
}

/** Pushes one event to the subscriber; may resolve or reject asynchronously. */
export type ChangePush = (event: { seq: number }) => void | Promise<void>;

/**
 * Starts feeding `push` with the store's change sequence.
 *
 * Returns a stop function; it is also wired to `signal`, so the plugin host
 * releasing the subscription (or stopping the plugin) closes the feed.
 */
export function startChangeFeed(
  source: ChangeSource,
  push: ChangePush,
  signal: AbortSignal,
  intervalMs: number = CHANGE_POLL_MS,
): () => void {
  let last = source.changesSeq();
  let stopped = false;

  const send = (seq: number): void => {
    if (stopped) return;
    // A failing push means the subscriber is gone; stop instead of stacking
    // rejected promises for every tick.
    Promise.resolve()
      .then(() => push({ seq }))
      .catch(() => stop());
  };

  send(last);

  const timer = setInterval(() => {
    if (stopped) return;
    const next = source.changesSeq();
    if (next === last) return;
    last = next;
    send(next);
  }, intervalMs);
  // A subscription must not keep the process alive on its own.
  (timer as { unref?: () => void }).unref?.();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });

  return stop;
}
