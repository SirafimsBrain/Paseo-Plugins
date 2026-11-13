/**
 * The local embedding provider: `@huggingface/transformers` + ONNX Runtime,
 * in-process, no daemon and no Python (spike results: `__research.md` §12).
 *
 * Two measured constraints shape this module:
 * - batch size 1 is 3–4× faster than batching for e5-small on CPU;
 * - the model cache must live outside the plugin checkout, otherwise
 *   `paseo plugin update` deletes it and re-downloads ~118 MB.
 */

export interface EmbeddingProvider {
  readonly modelId: string;
  /** Embeds one chunk for the index (`passage:` prefix for e5). */
  embedPassage(text: string): Promise<Float32Array>;
  /** Embeds one search query (`query:` prefix for e5). */
  embedQuery(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

export interface LocalProviderOptions {
  model: string;
  dtype: string;
  cacheDir: string;
}

/** e5 has a 512-token window; this keeps tokenisation bounded even for long notes. */
const MAX_EMBED_CHARS = 6000;

/**
 * Resolved through a variable so neither esbuild nor the Paseo bundler tries to
 * inline the package or its native `.node` binaries.
 */
const TRANSFORMERS_SPECIFIER = "@huggingface/transformers";

export async function createLocalProvider(options: LocalProviderOptions): Promise<EmbeddingProvider> {
  let transformers: {
    env?: { cacheDir?: string; allowRemoteModels?: boolean };
    pipeline: (
      task: string,
      model: string,
      config: { dtype: string },
    ) => Promise<
      (
        text: string,
        config: { pooling: string; normalize: boolean },
      ) => Promise<{ data: Float32Array | number[]; dims: number[] }>
    >;
  };
  try {
    transformers = (await import(TRANSFORMERS_SPECIFIER)) as unknown as typeof transformers;
  } catch (cause) {
    throw new Error(
      "Semantic search needs the '@huggingface/transformers' package, which is not " +
        `installed (${cause instanceof Error ? cause.message : String(cause)}). Run npm install ` +
        "in the plugin directory, or turn semantic search off in Settings → Plugins → Obsidian Bridge.",
    );
  }

  if (transformers.env) {
    transformers.env.cacheDir = options.cacheDir;
    transformers.env.allowRemoteModels = true;
  }

  const extractor = await transformers.pipeline("feature-extraction", options.model, {
    dtype: options.dtype,
  });

  const embed = async (prefix: "passage" | "query", text: string): Promise<Float32Array> => {
    const output = await extractor(`${prefix}: ${text.slice(0, MAX_EMBED_CHARS)}`, {
      pooling: "mean",
      normalize: true,
    });
    // Copy: the tensor buffer may be reused by the next call.
    return Float32Array.from(output.data as ArrayLike<number>);
  };

  return {
    modelId: options.model,
    embedPassage: (text) => embed("passage", text),
    embedQuery: (text) => embed("query", text),
    async dispose() {
      const disposable = extractor as unknown as { dispose?: () => Promise<void> };
      await disposable.dispose?.();
    },
  };
}
