import type { ActivityReason, ActivitySnapshot } from "../shared/activity";

/**
 * In-process fan-out behind `remote-control.activity` (stage 1.1.0).
 *
 * Producers are the things that already know when state moved: the terminal
 * service, the external-session registry, the vault and the console endpoint.
 * The snapshot itself is built by the plugin entry point, which owns all four,
 * so this module stays a tiny registry with no imports of its own.
 *
 * State is disposable: the daemon's terminals, the process registry and the
 * pass store stay authoritative, so nothing here survives a plugin reload.
 */

type SnapshotProvider = (reason: ActivityReason) => ActivitySnapshot;
type Listener = (snapshot: ActivitySnapshot) => void;

let provider: SnapshotProvider | null = null;
const listeners = new Set<Listener>();

/** Installs the snapshot builder (called once from the plugin entry point). */
export function setActivityProvider(next: SnapshotProvider | null): void {
  provider = next;
}

/** Builds a snapshot now, or null when no provider is installed yet. */
export function activitySnapshot(reason: ActivityReason): ActivitySnapshot | null {
  if (!provider) return null;
  try {
    return provider(reason);
  } catch {
    return null;
  }
}

/** Notifies every subscriber with a fresh snapshot. Never throws. */
export function publishActivity(reason: ActivityReason): void {
  const snapshot = activitySnapshot(reason);
  if (!snapshot) return;
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      // A broken subscriber must never break the producer (a launch, a kill).
    }
  }
}

/** Subscribes to activity; returns the unsubscribe function. */
export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drops every listener and the provider (tests, plugin shutdown). */
export function clearActivity(): void {
  listeners.clear();
  provider = null;
}
