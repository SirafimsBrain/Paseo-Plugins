/**
 * Filters a Command Center item wants the panel to start with.
 *
 * The host only lets a command open a panel, not configure it, so the command
 * writes the intent here and the panel consumes it on mount. Module state is the
 * right home for this: the client bundle of a plugin is a singleton, and the
 * panel lives in the same process.
 */
export interface SessionManagerIntent {
  /** Age filter in days; 0 keeps every age. */
  ageDays?: number;
  /** Provider id, or "all". */
  providerFilter?: string;
  /** Keep only sessions referenced by an archived Paseo agent. */
  archivedOnly?: boolean;
  /** Select every row that matches the intent. */
  selectShown?: boolean;
}

let intent: SessionManagerIntent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSessionManagerIntent(next: SessionManagerIntent): void {
  intent = next;
  emit();
}

export function clearSessionManagerIntent(): void {
  if (intent === null) return;
  intent = null;
  emit();
}

export function subscribeSessionManagerIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for `useSyncExternalStore`; returns a stable object reference. */
export function getSessionManagerIntent(): SessionManagerIntent | null {
  return intent;
}
