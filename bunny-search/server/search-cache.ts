import type { RuntimeSettings, SearchRequest, SearchResponse } from "../shared/contracts";

/**
 * In-process response cache for identical searches (0.7.5).
 *
 * ## Why
 *
 * Agents re-search the same error string or library name within one turn, and
 * every repeat is a real upstream request against a service that rate-limits
 * anonymous traffic (DuckDuckJS walks five engines, each with its own limits).
 * Reusing an answer for a few minutes removes that traffic without changing
 * what the agent sees — the formatted text says the answer came from the cache,
 * so it is never presented as a fresh result.
 *
 * ## Scope
 *
 * Deliberately small and process-local:
 *
 * - **Keyed by everything that can change an answer** — service, engine pin, the
 *   URL fields, language, the normalised query, the result count and the
 *   categories — so a settings edit cannot serve a stale provider's answer. The
 *   key never contains the API key: a rotated key reuses the same entry, which is
 *   correct because the answer does not depend on it.
 * - **Only non-empty answers are stored.** An empty result is what a rate limit
 *   looks like, and caching it would keep an agent starved for the whole TTL.
 * - **LRU with a hard entry cap** (64): a long-running daemon cannot grow this
 *   without bound, and the least recently used answer is the one to drop.
 * - **TTL comes from the settings** (`cacheTtlSeconds`, 0 = off) and is evaluated
 *   on read, so lowering it takes effect immediately.
 */

/** Hard ceiling on stored answers; the oldest entry is evicted past it. */
export const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  response: SearchResponse;
  storedAt: number;
}

const entries = new Map<string, CacheEntry>();

/**
 * Identity of one answer. `request.language`/`categories` fall back to the
 * settings values, exactly like the adapters do, so an explicit override and the
 * default cannot collide.
 */
export function searchCacheKey(request: SearchRequest, settings: RuntimeSettings): string {
  return JSON.stringify([
    settings.searchService,
    settings.duckduckjsEngine,
    settings.searxngBaseUrl,
    settings.customBaseUrl,
    request.query.trim().toLowerCase().replace(/\s+/g, " "),
    request.maxResults,
    (request.categories ?? settings.categories).trim().toLowerCase(),
    (request.language ?? settings.language).trim().toLowerCase(),
  ]);
}

/** A stored answer that is still inside `ttlMs`, or null. */
export function readCachedSearch(key: string, ttlMs: number): SearchResponse | null {
  if (ttlMs <= 0) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt >= ttlMs) {
    entries.delete(key);
    return null;
  }
  // Refresh recency: Map preserves insertion order, so re-inserting moves it last.
  entries.delete(key);
  entries.set(key, entry);
  return entry.response;
}

/** Stores an answer; empty answers are refused (they usually mean a rate limit). */
export function writeCachedSearch(key: string, response: SearchResponse): void {
  if (response.results.length === 0) return;
  entries.delete(key);
  entries.set(key, { response, storedAt: Date.now() });
  while (entries.size > MAX_CACHE_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done === true) break;
    entries.delete(oldest.value);
  }
}

/** Drops every answer — used when settings change and on provider edits. */
export function clearSearchCache(): void {
  entries.clear();
}

/** Number of stored answers (tests and diagnostics). */
export function searchCacheSize(): number {
  return entries.size;
}
