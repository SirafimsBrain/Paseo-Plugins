import type { AgentSession, ProviderStatus } from "./session-manager";

/**
 * Pure helpers shared by the workspace panel and the sidebar status row.
 *
 * The "due for cleanup" definition has to be identical on both surfaces, so it
 * lives here instead of being duplicated in the two client modules. Nothing in
 * this file imports React or a host module: it is plain data in, plain data out,
 * which is also what `tests/summary.test.ts` exercises.
 */

/** Human size; null when nothing is known (never rendered as "0 B"). */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A session is due when its last activity is at least `days` old. */
export function isOldEnough(session: AgentSession, days: number): boolean {
  if (days <= 0) return true;
  if (!session.updatedAt) return true;
  const ms = Date.now() - new Date(session.updatedAt).getTime();
  return Number.isNaN(ms) || ms >= days * 86_400_000;
}

/** Running sessions and sessions owned by an open Paseo agent need force. */
export function needsForce(session: AgentSession): boolean {
  return session.running || (session.paseoAgent !== null && !session.paseoAgent.archived);
}

/** One provider's share of the summary, in panel row order. */
export interface ProviderSummary {
  id: string;
  label: string;
  /** Sessions this provider currently lists. */
  count: number;
  /** Sessions that are due for cleanup and safe to delete without force. */
  due: number;
  detected: boolean;
  /** Whole-store size; null when the adapter cannot attribute one. */
  storeBytes: number | null;
  error: string | null;
}

export interface SessionSummary {
  total: number;
  /** Older than the cleanup threshold and not risky. */
  due: number;
  /** Running or referenced by a non-archived Paseo agent. */
  risky: number;
  /** Sum of the per-session sizes any adapter reported; null when none did. */
  knownBytes: number | null;
  providers: ProviderSummary[];
}

/**
 * Aggregates a listing into the counts the sidebar row and its popover show.
 * `cleanupDays` is the host setting: 0 turns the due count off, matching the
 * panel's "cleanup hint off" state.
 */
export function summarizeSessions(
  sessions: AgentSession[],
  providers: ProviderStatus[],
  cleanupDays: number,
): SessionSummary {
  const dueSessions = sessions.filter(
    (session) => isOldEnough(session, cleanupDays) && !needsForce(session),
  );
  const known = sessions.filter((session) => session.sizeBytes !== null);
  const knownBytes =
    known.length === 0
      ? null
      : known.reduce((total, session) => total + (session.sizeBytes ?? 0), 0);

  return {
    total: sessions.length,
    due: cleanupDays > 0 ? dueSessions.length : 0,
    risky: sessions.filter(needsForce).length,
    knownBytes,
    providers: providers.map((provider) => {
      const owned = sessions.filter((session) => session.provider === provider.id);
      return {
        id: provider.id,
        label: provider.label,
        count: owned.length,
        due: cleanupDays > 0 ? owned.filter((session) => isOldEnough(session, cleanupDays) && !needsForce(session)).length : 0,
        detected: provider.detected,
        storeBytes: provider.storeBytes,
        error: provider.error,
      };
    }),
  };
}
