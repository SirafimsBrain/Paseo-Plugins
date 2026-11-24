import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configuredPluginPath } from "../mcp-launch";
import { bridgeHome, isStandaloneBridge, settingsMirrorPath } from "../paths";

/**
 * The local embedding provider: `@huggingface/transformers` + ONNX Runtime,
 * in-process, no daemon and no Python (spike results: `__research.md` §12).
 *
 * Two measured constraints shape this module:
 * - batch size 1 is 3–4× faster than batching for e5-small on CPU;
 * - the model cache must live outside the plugin checkout, otherwise
 *   `paseo plugin update` deletes it and re-downloads ~118 MB.
 *
 * Resolution is the third constraint (0.26.23, live test D1): the package is
 * external in the bundle, and the copy agents launch
 * (`$PASEO_HOME/plugins/obsidian-bridge/mcp-server.js`) has no `node_modules`
 * next to it, so a bare `import("@huggingface/transformers")` from that copy
 * always failed — while the same code, run from the checkout, worked. The
 * package is therefore looked up from the installed checkout first and loaded
 * by absolute path, and the answer is available as a cheap probe so
 * `obsidian_status` can say "unavailable" instead of reporting a healthy index
 * that no query can use.
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

export interface TransformersResolution {
  /** Absolute path of the package entry; `null` when it cannot be loaded. */
  entry: string | null;
  /** Why it cannot be loaded, phrased for an operator. */
  error: string | null;
}

/**
 * Places the package may live, most specific first: the installed plugin
 * checkout (its `node_modules` is what `npm ci` built), then whatever the
 * running bundle can see (a development checkout, or a standalone install that
 * ran `npm install` itself).
 */
function resolutionBases(): string[] {
  const bases: string[] = [];
  const configured = configuredPluginPath();
  if (configured) bases.push(path.join(configured, "package.json"));
  try {
    bases.push(fileURLToPath(import.meta.url));
  } catch {
    // No module URL: the checkout candidates are all that is left.
  }
  return [...new Set(bases)];
}

function remedy(): string {
  return isStandaloneBridge()
    ? `Run \`npm install @huggingface/transformers\` in \`${bridgeHome()}\`, or set ` +
        `\`semanticSearch: false\` in \`${settingsMirrorPath()}\`.`
    : "Run `npm ci` in the plugin checkout so its `node_modules` exists, or turn semantic " +
        "search off in Settings → Plugins → Obsidian Bridge.";
}

let cachedResolution: TransformersResolution | null = null;

/**
 * Locates the embedding stack without loading it (a `package.json`/`exports`
 * lookup, no ONNX runtime, no model). The result is cached for the process:
 * the installation does not change under a running server.
 */
export function resolveTransformers(): TransformersResolution {
  if (cachedResolution) return cachedResolution;
  const bases = resolutionBases();
  let detail = "no lookup base";
  for (const base of bases) {
    try {
      const entry = createRequire(base).resolve(TRANSFORMERS_SPECIFIER);
      cachedResolution = { entry, error: null };
      return cachedResolution;
    } catch (cause) {
      detail = cause instanceof Error ? cause.message : String(cause);
    }
  }
  cachedResolution = {
    entry: null,
    error:
      "Semantic search needs the '@huggingface/transformers' package, which this " +
      `installation cannot load (${detail}). ${remedy()}`,
  };
  return cachedResolution;
}

/** `true` when a semantic query can be answered from this installation. */
export function transformersAvailability(): { available: boolean; error: string | null } {
  const resolution = resolveTransformers();
  return resolution.entry === null
    ? { available: false, error: resolution.error }
    : { available: true, error: null };
}

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
  const resolution = resolveTransformers();
  if (resolution.entry === null) throw new Error(resolution.error ?? "Embeddings are unavailable.");
  try {
    // An absolute file URL, so the package loads from where it was found — the
    // stable copy agents launch has no `node_modules` of its own.
    transformers = (await import(pathToFileURL(resolution.entry).href)) as unknown as typeof transformers;
  } catch (cause) {
    throw new Error(
      `Semantic search could not load '${resolution.entry}': ${
        cause instanceof Error ? cause.message : String(cause)
      }. ${remedy()}`,
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
