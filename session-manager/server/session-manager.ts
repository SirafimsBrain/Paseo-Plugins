import type { AgentSession, ProviderStatus, SessionTarget } from "../shared/session-manager";
import { readPaseoAgentLinks } from "./paseo-agents";
import { providerById, providers } from "./providers/registry";
import type { ProviderAdapter, ProviderListResult, ProviderSession } from "./providers/types";

/** How long a provider listing stays warm inside the plugin process. */
const STORE_TTL_MS = 30_000;

interface CachedListing {
  result: ProviderListResult;
  storedAt: number;
}

/**
 * Listings are cached per provider for a short TTL, because a delete request
 * runs the same guard check that a list request already paid for, and a
 * CLI-backed provider costs one process spawn per scan. Deleting invalidates the
 * entry of the affected provider, and a client that wants fresh data asks for
 * `refresh: true`.
 */
const listings = new Map<string, CachedListing>();

/** Drops one provider entry, or the whole cache when called without an id. */
export function invalidateListing(provider?: string): void {
  if (provider) {
    listings.delete(provider);
  } else {
    listings.clear();
  }
}

function cachedListing(provider: string, refresh: boolean): ProviderListResult | null {
  if (refresh) return null;
  const entry = listings.get(provider);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > STORE_TTL_MS) {
    listings.delete(provider);
    return null;
  }
  return entry.result;
}

async function readListing(
  adapter: ProviderAdapter,
  options: { refresh?: boolean } = {},
): Promise<ProviderListResult> {
  const cached = cachedListing(adapter.id, options.refresh === true);
  if (cached) return cached;
  const result = await adapter.list();
  listings.set(adapter.id, { result, storedAt: Date.now() });
  return result;
}

interface ProviderSnapshot {
  adapterId: string;
  label: string;
  sessions: ProviderSession[];
  detected: boolean;
  detail: string;
  deletable: boolean;
  storeBytes: number | null;
  error: string | null;
}

async function collect(options: { refresh?: boolean } = {}): Promise<ProviderSnapshot[]> {
  return await Promise.all(
    providers.map(async (adapter) => {
      try {
        const result = await readListing(adapter, options);
        return {
          adapterId: adapter.id,
          label: adapter.label,
          sessions: result.sessions,
          detected: result.detected,
          detail: result.detail,
          deletable: result.deletable,
          storeBytes: result.storeBytes,
          error: result.error,
        };
      } catch (error) {
        return {
          adapterId: adapter.id,
          label: adapter.label,
          sessions: [],
          detected: false,
          detail: adapter.id,
          deletable: false,
          storeBytes: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

export async function listAgentSessions(input: { refresh?: boolean } = {}) {
  const snapshots = await collect({ refresh: input.refresh === true });
  const links = readPaseoAgentLinks();

  const sessions: AgentSession[] = [];
  const statuses: ProviderStatus[] = [];

  for (const snapshot of snapshots) {
    for (const session of snapshot.sessions) {
      const link = links.get(session.id);
      sessions.push({
        provider: snapshot.adapterId,
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        sizeBytes: session.sizeBytes,
        running: session.running,
        paseoAgent: link
          ? { id: link.id, title: link.title, archived: link.archived }
          : null,
      });
    }
    statuses.push({
      id: snapshot.adapterId,
      label: snapshot.label,
      detected: snapshot.detected,
      deletable: snapshot.deletable,
      detail: snapshot.detail,
      count: snapshot.sessions.length,
      storeBytes: snapshot.storeBytes,
      error: snapshot.error,
    });
  }

  sessions.sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt));

  return { sessions, providers: statuses, scannedAt: new Date().toISOString() };
}

function timestampOf(value: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Refuses to remove a session that is running or that Paseo still refers to. */
async function checkTarget(
  target: SessionTarget,
  force: boolean,
  links: Map<string, { id: string; title: string | null; archived: boolean }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const adapter = providerById(target.provider);
  if (!adapter) return { ok: false, error: `Unknown provider "${target.provider}"` };

  let listing: ProviderListResult;
  try {
    listing = await readListing(adapter);
  } catch (error) {
    return {
      ok: false,
      error: `Could not read ${adapter.label} sessions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!listing.deletable) {
    return {
      ok: false,
      error: `Deletion is unavailable for ${adapter.label}: ${listing.detail}`,
    };
  }

  const session = listing.sessions.find((candidate) => candidate.id === target.id);
  if (!session) return { ok: false, error: "Session not found" };
  if (force) return { ok: true };

  if (session.running) {
    return {
      ok: false,
      error: "Session is still running. Stop the agent first, or delete with force.",
    };
  }

  const link = links.get(target.id);
  if (link && !link.archived) {
    const title = link.title ? `"${link.title}"` : link.id;
    return {
      ok: false,
      error: `Session belongs to open Paseo agent ${title}. Archive it in Paseo first, or delete with force.`,
    };
  }

  return { ok: true };
}

export async function deleteAgentSession(input: {
  provider: string;
  id: string;
  force?: boolean;
}) {
  const links = readPaseoAgentLinks();
  const target = { provider: input.provider, id: input.id };

  const allowed = await checkTarget(target, input.force === true, links);
  if (!allowed.ok) {
    return { deleted: false, error: allowed.error };
  }

  const adapter = providerById(input.provider);
  if (!adapter) return { deleted: false, error: `Unknown provider "${input.provider}"` };

  const result = await adapter.delete([input.id]);
  // The store changed, so the next guard check has to read it again.
  invalidateListing(adapter.id);
  if (result.deleted.includes(input.id)) {
    return { deleted: true, error: null };
  }
  const failure = result.failures.find((candidate) => candidate.id === input.id);
  return { deleted: false, error: failure?.error ?? "Delete failed" };
}

export async function deleteAgentSessionsBatch(input: {
  targets: SessionTarget[];
  force?: boolean;
}) {
  const failures: { provider: string; id: string; error: string }[] = [];
  let deleted = 0;
  const links = readPaseoAgentLinks();
  const queued = new Map<string, string[]>();

  for (const target of input.targets) {
    const allowed = await checkTarget(target, input.force === true, links);
    if (!allowed.ok) {
      failures.push({ provider: target.provider, id: target.id, error: allowed.error });
      continue;
    }
    const ids = queued.get(target.provider) ?? [];
    ids.push(target.id);
    queued.set(target.provider, ids);
  }

  for (const [providerId, ids] of queued) {
    const adapter = providerById(providerId);
    if (!adapter) {
      failures.push({ provider: providerId, id: ids.join(", "), error: "Unknown provider" });
      continue;
    }
    try {
      const result = await adapter.delete(ids);
      invalidateListing(adapter.id);
      deleted += result.deleted.length;
      for (const failure of result.failures) {
        failures.push({ provider: providerId, id: failure.id, error: failure.error });
      }
    } catch (error) {
      invalidateListing(adapter.id);
      const message = error instanceof Error ? error.message : String(error);
      for (const id of ids) {
        failures.push({ provider: providerId, id, error: message });
      }
    }
  }

  return { deleted, failures };
}
