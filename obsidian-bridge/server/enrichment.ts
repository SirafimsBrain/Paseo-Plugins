import type { EnrichmentStatus } from "../shared/contracts";
import type { EnrichmentEventState } from "./enrichment-state";
import type { RuntimeSettings } from "../shared/settings";
import {
  createObsidianApi,
  type EventSubscription,
  type FuzzyHit,
  type ObsidianApi,
  type VaultEvent,
} from "./obsidian-api";

/**
 * Optional enrichment lifecycle for the plugin process.
 *
 * One owner for the Local REST API client: probe state, the vault event
 * streams and the last error. It never throws and never blocks the index:
 * when Obsidian is closed the index is exactly what the filesystem path
 * produces, and `status()` says why enrichment is down.
 */
export class EnrichmentService {
  private api: ObsidianApi | null = null;
  private subscription: EventSubscription | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastSettings: RuntimeSettings | null = null;
  private state: EnrichmentStatus = {
    enabled: false,
    url: "",
    reachable: false,
    authenticated: false,
    version: null,
    events: false,
    lastEventAt: null,
    error: null,
  };

  constructor(
    private readonly onVaultEvent: (event: VaultEvent) => void,
    /** Publishes the live state for the MCP server (`enrichment-state.ts`). */
    private readonly publishState: (state: EnrichmentEventState) => void = () => {},
  ) {}

  /** Mirrors the subscription flags after every transition. */
  private publish(): void {
    this.publishState({ events: this.state.events, lastEventAt: this.state.lastEventAt });
  }

  async configure(settings: RuntimeSettings): Promise<void> {
    this.stopStreams();
    this.clearRetry();
    this.lastSettings = settings;
    this.api = createObsidianApi(settings);
    this.state = {
      enabled: this.api !== null,
      url: settings.obsidianApiUrl,
      reachable: false,
      authenticated: false,
      version: null,
      events: false,
      lastEventAt: this.state.lastEventAt,
      error: null,
    };
    if (!this.api) {
      this.publish();
      return;
    }

    const probe = await this.api.probe();
    this.state.reachable = probe.ok;
    this.state.authenticated = probe.authenticated;
    this.state.version = probe.version;
    this.state.error = probe.error;
    if (!probe.ok) {
      // Obsidian may simply be closed right now: probe again later instead of
      // requiring the user to re-save the settings.
      this.publish();
      this.scheduleRetry();
      return;
    }

    const { subscription, error } = await this.api.subscribeEvents((event) => {
      this.state.lastEventAt = new Date().toISOString();
      this.publish();
      this.onVaultEvent(event);
    });
    this.subscription = subscription;
    this.state.events = subscription !== null;
    this.state.error = error;
    this.publish();
  }

  status(): EnrichmentStatus {
    return { ...this.state };
  }

  stop(): void {
    this.clearRetry();
    this.stopStreams();
    this.api = null;
    this.publish();
  }

  private scheduleRetry(): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const settings = this.lastSettings;
      if (settings) void this.configure(settings);
    }, 60_000);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stopStreams(): void {
    this.subscription?.stop();
    this.subscription = null;
    this.state.events = false;
  }
}

/**
 * Obsidian fuzzy search as an optional retrieval signal. A closed app, a wrong
 * key or a slow answer degrade to `{hits: [], error}` after the client timeout,
 * never to a failed search.
 */
/**
 * A closed Obsidian must not cost every agent search a full timeout. A failed
 * call is remembered for 30 s per endpoint; a successful one clears it. The
 * cache is per process and never carries note text or the key.
 */
const failureCache = new Map<string, { at: number; error: string }>();
const FAILURE_TTL_MS = 30_000;

function endpointKey(settings: RuntimeSettings): string {
  return `${settings.obsidianApiUrl.trim()}\n${settings.obsidianApiKey.trim()}`;
}

export async function fuzzySearch(
  settings: RuntimeSettings,
  query: string,
  limit = 20,
): Promise<{ enabled: boolean; hits: FuzzyHit[]; error: string | null }> {
  const api = createObsidianApi(settings);
  if (!api) return { enabled: false, hits: [], error: null };
  if (query.trim().length === 0) return { enabled: true, hits: [], error: null };
  const key = endpointKey(settings);
  const known = failureCache.get(key);
  if (known && Date.now() - known.at < FAILURE_TTL_MS) {
    return { enabled: true, hits: [], error: known.error };
  }
  const result = await api.simpleSearch(query, limit);
  if (result.error) {
    failureCache.set(key, { at: Date.now(), error: result.error });
  } else {
    failureCache.delete(key);
  }
  return { enabled: true, hits: result.hits, error: result.error };
}
