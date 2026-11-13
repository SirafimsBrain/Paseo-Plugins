import type { RuntimeSettings } from "../../shared/settings";
import { modelsDir } from "../paths";
import { createLocalProvider, type EmbeddingProvider } from "./local";

/**
 * Query-side embedding inside the MCP process (or the plugin host).
 *
 * The model is loaded lazily on the first semantic query — an agent that never
 * searches never pays the ~1.4 s load or the ~0.5 GB it keeps resident — and is
 * unloaded after `embeddingIdleMinutes` of inactivity. `dispose()` does not
 * return the memory to the OS reliably (spike, `__research.md` §12.2), so
 * keeping the model only while it is useful is the point, not freeing bytes.
 */

export type EmbeddingProviderFactory = (
  settings: RuntimeSettings,
) => Promise<EmbeddingProvider>;

let injectedFactory: EmbeddingProviderFactory | null = null;
let provider: EmbeddingProvider | null = null;
let providerKey = "";
let loading: Promise<EmbeddingProvider | null> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let lastError: string | null = null;

/** Tests inject a deterministic provider; `null` restores the local one. */
export function setEmbeddingProviderFactory(next: EmbeddingProviderFactory | null): void {
  injectedFactory = next;
  void disposeQueryProvider();
  providerKey = "";
  lastError = null;
}

function keyOf(settings: RuntimeSettings): string {
  return `${settings.embeddingModel}\u0000${settings.embeddingDtype}`;
}

function factoryOf(settings: RuntimeSettings): EmbeddingProviderFactory {
  if (injectedFactory) return injectedFactory;
  return (input) =>
    createLocalProvider({
      model: input.embeddingModel,
      dtype: input.embeddingDtype,
      cacheDir: modelsDir(),
    });
}

function scheduleIdleUnload(settings: RuntimeSettings): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (settings.embeddingIdleMinutes <= 0) return;
  idleTimer = setTimeout(
    () => {
      void disposeQueryProvider();
    },
    settings.embeddingIdleMinutes * 60_000,
  );
  idleTimer.unref?.();
}

async function load(settings: RuntimeSettings): Promise<EmbeddingProvider | null> {
  const key = keyOf(settings);
  if (provider && providerKey === key) return provider;
  if (loading) return loading;
  if (provider) await disposeQueryProvider();

  loading = (async () => {
    try {
      const created = await factoryOf(settings)(settings);
      provider = created;
      providerKey = key;
      lastError = null;
      return created;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export interface QueryEmbedding {
  vector: Float32Array | null;
  modelId: string;
  error: string | null;
}

/** Embeds one query, or explains why semantic search is unavailable. */
export async function embedQuery(
  settings: RuntimeSettings,
  text: string,
): Promise<QueryEmbedding> {
  const modelId = settings.embeddingModel;
  if (!settings.semanticSearch) return { vector: null, modelId, error: null };
  const active = await load(settings);
  if (!active) return { vector: null, modelId, error: lastError };
  try {
    const vector = await active.embedQuery(text);
    scheduleIdleUnload(settings);
    return { vector, modelId, error: null };
  } catch (cause) {
    lastError = cause instanceof Error ? cause.message : String(cause);
    return { vector: null, modelId, error: lastError };
  }
}

export interface QueryProviderStatus {
  loaded: boolean;
  rssMb: number | null;
  error: string | null;
}

export function queryProviderStatus(): QueryProviderStatus {
  return {
    loaded: provider !== null,
    rssMb: provider === null ? null : Math.round(process.memoryUsage().rss / 1024 / 1024),
    error: lastError,
  };
}

export async function disposeQueryProvider(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = provider;
  provider = null;
  providerKey = "";
  if (!current) return;
  try {
    await current.dispose();
  } catch {
    // Disposal is best-effort: process exit is what actually frees the memory.
  }
}
