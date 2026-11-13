import * as crypto from "node:crypto";
import { createLocalProvider } from "./embed/local";
import { BridgeStore } from "./store";

/**
 * Short-lived embedding job, spawned by the plugin host and run as its own
 * process (`dist/embed-worker.js`).
 *
 * Why a process and not a worker thread: the spike (`__research.md` §12) showed
 * ~1.1 GB peak RSS for a full vault that `dispose()` does not return. A process
 * that exits gives the memory back to the OS; a worker thread shares the
 * address space with the daemon.
 *
 * Protocol: one JSON object per line on stdout (`{state, done, total, rssMb}`).
 * SIGTERM stops after the current chunk; the next run resumes with the chunks
 * that still have no vector.
 */

function emit(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
  const dbPath = process.env.OBSIDIAN_BRIDGE_DB ?? "";
  const model = process.env.OBSIDIAN_BRIDGE_MODEL ?? "";
  const dtype = process.env.OBSIDIAN_BRIDGE_DTYPE || "q8";
  const cacheDir = process.env.OBSIDIAN_BRIDGE_CACHE || "";
  const stemming = process.env.OBSIDIAN_BRIDGE_STEMMING === "1";
  if (dbPath.length === 0 || model.length === 0) {
    emit({ state: "error", error: "embed-worker needs OBSIDIAN_BRIDGE_DB and OBSIDIAN_BRIDGE_MODEL." });
    process.exit(2);
  }

  // Same tokenizer setting as the host: opening with the other one would make
  // BridgeStore wipe the FTS tables it does not own.
  const store = new BridgeStore(dbPath, { stemming });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    store.clearEmbeddingsExcept(model);
    const pending = store.chunksToEmbed(model);
    const total = pending.length;
    emit({ state: "running", done: 0, total });
    if (total === 0) {
      store.close();
      emit({ state: "done", done: 0, total: 0, rssMb: mb(process.memoryUsage().rss) });
      return;
    }

    const provider = await createLocalProvider({ model, dtype, cacheDir });
    let done = 0;
    for (const chunk of pending) {
      if (stopping) break;
      // Batch of one: measured 3-4x faster than batching for this model.
      const vec = await provider.embedPassage(chunk.text);
      store.putEmbedding({
        chunkId: chunk.id,
        path: chunk.path,
        modelId: model,
        dim: vec.length,
        textHash: crypto.createHash("sha1").update(chunk.text).digest("hex"),
        vec,
      });
      done += 1;
      if (done % 25 === 0 || done === total) {
        emit({ state: "running", done, total, rssMb: mb(process.memoryUsage().rss) });
      }
      if (stopping) break;
    }
    await provider.dispose();
    store.close();
    emit({ state: "done", done, total, rssMb: mb(process.memoryUsage().rss) });
  } catch (cause) {
    try {
      store.close();
    } catch {
      // already closed
    }
    emit({ state: "error", error: cause instanceof Error ? cause.message : String(cause) });
    process.exit(1);
  }
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

void main();
