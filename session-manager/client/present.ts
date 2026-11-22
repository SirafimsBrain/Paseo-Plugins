import type { AgentSession } from "../shared/session-manager";

/**
 * Display helpers shared by the workspace panel and the per-agent panel
 * (0.7.0). They took their first form inside `session-manager-panel.tsx`; the
 * second panel needs exactly the same wording, so they live here instead of
 * being copied.
 */

export function ageLabel(iso: string | null): string {
  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

export function sessionKey(session: AgentSession): string {
  return `${session.provider}:${session.id}`;
}

/** Oldest sessions first by default: that is the order deletion work needs. */
export function sortSessions(sessions: AgentSession[], oldestFirst: boolean): AgentSession[] {
  const timestamp = (value: string | null): number => {
    if (!value) return oldestFirst ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed)
      ? oldestFirst
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY
      : parsed;
  };
  return [...sessions].sort((a, b) =>
    oldestFirst
      ? timestamp(a.updatedAt) - timestamp(b.updatedAt)
      : timestamp(b.updatedAt) - timestamp(a.updatedAt),
  );
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
