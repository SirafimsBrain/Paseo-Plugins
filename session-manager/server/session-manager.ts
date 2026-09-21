import type { AgentSession, ProviderStatus, SessionTarget } from "../shared/session-manager";
import { readPaseoAgentLinks } from "./paseo-agents";
import { providerById, providers } from "./providers/registry";
import type { ProviderSession } from "./providers/types";

interface ProviderSnapshot {
  adapterId: string;
  label: string;
  sessions: ProviderSession[];
  detected: boolean;
  detail: string;
  deletable: boolean;
  error: string | null;
}

async function collect(): Promise<ProviderSnapshot[]> {
  const snapshots = await Promise.all(
    providers.map(async (adapter) => {
      try {
        const result = await adapter.list();
        return {
          adapterId: adapter.id,
          label: adapter.label,
          sessions: result.sessions,
          detected: result.detected,
          detail: result.detail,
          deletable: result.deletable,
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
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return snapshots;
}

export async function listAgentSessions() {
  const snapshots = await collect();
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

interface LoadedStore {
  sessions: ProviderSession[];
  deletable: boolean;
  detail: string;
}

/**
 * Per-request cache of provider listings. Guards need the live list, and a
 * CLI-backed provider costs a process spawn per scan, so each provider is read
 * at most once per delete request.
 */
type StoreCache = Map<string, LoadedStore>;

async function loadStore(
  cache: StoreCache,
  provider: string,
): Promise<{ store: LoadedStore } | { error: string }> {
  const adapter = providerById(provider);
  if (!adapter) return { error: `Unknown provider "${provider}"` };

  const cached = cache.get(provider);
  if (cached) return { store: cached };

  try {
    const result = await adapter.list();
    const store: LoadedStore = {
      sessions: result.sessions,
      deletable: result.deletable,
      detail: result.detail,
    };
    cache.set(provider, store);
    return { store };
  } catch (error) {
    return {
      error: `Could not read ${adapter.label} sessions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Refuses to remove a session that is running or that Paseo still refers to. */
async function checkTarget(
  cache: StoreCache,
  target: SessionTarget,
  force: boolean,
  links: Map<string, { id: string; title: string | null; archived: boolean }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const adapter = providerById(target.provider);
  if (!adapter) return { ok: false, error: `Unknown provider "${target.provider}"` };

  const loaded = await loadStore(cache, target.provider);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  if (!loaded.store.deletable) {
    return {
      ok: false,
      error: `Deletion is unavailable for ${adapter.label}: ${loaded.store.detail}`,
    };
  }

  const session = loaded.store.sessions.find((candidate) => candidate.id === target.id);
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
  const cache: StoreCache = new Map();
  const links = readPaseoAgentLinks();
  const target = { provider: input.provider, id: input.id };

  const allowed = await checkTarget(cache, target, input.force === true, links);
  if (!allowed.ok) {
    return { deleted: false, error: allowed.error };
  }

  const adapter = providerById(input.provider);
  if (!adapter) return { deleted: false, error: `Unknown provider "${input.provider}"` };

  const result = await adapter.delete([input.id]);
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
  const cache: StoreCache = new Map();
  const links = readPaseoAgentLinks();
  const queued = new Map<string, string[]>();

  for (const target of input.targets) {
    const allowed = await checkTarget(cache, target, input.force === true, links);
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
      deleted += result.deleted.length;
      for (const failure of result.failures) {
        failures.push({ provider: providerId, id: failure.id, error: failure.error });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const id of ids) {
        failures.push({ provider: providerId, id, error: message });
      }
    }
  }

  return { deleted, failures };
}
