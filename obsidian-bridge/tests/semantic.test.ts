import { afterEach, describe, expect, it } from "vitest";
import { disposeQueryProvider, setEmbeddingProviderFactory } from "../server/embed/query";
import { dispatchTool } from "../server/mcp-tools";
import { MEMORY_NORMAL_BYTES, MEMORY_WARN_BYTES, memoryReport } from "../server/memory";
import { indexPathFor } from "../server/paths";
import { scanVault } from "../server/scan";
import { searchIndex } from "../server/search";
import { BridgeStore } from "../server/store";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const MODEL = "fake:test-model";
const DIM = 8;

const workspaces: TestWorkspace[] = [];

afterEach(async () => {
  await disposeQueryProvider();
  setEmbeddingProviderFactory(null);
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

/** Two orthogonal unit vectors stand in for a real 384-dim embedding. */
function vectorFor(text: string): Float32Array {
  const vec = new Float32Array(DIM);
  const queue = /queue|очеред|bounded|retry/i.test(text);
  vec[queue ? 0 : 1] = 1;
  return vec;
}

const QUERY_VECTOR = vectorFor("очередь");

function workspace(): TestWorkspace {
  const created = makeWorkspace({
    "Queue.md": "# Queue\n\nA bounded queue with retries and metrics.\n",
    "Garden.md": "# Garden\n\nTomatoes and basil on the balcony.\n",
  });
  workspaces.push(created);
  const settings = runtimeSettings(created.vault);
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  scanVault({ root: created.vault, store, settings, force: true });
  store.close();
  return created;
}

function seedVectors(created: TestWorkspace): number {
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  const pending = store.chunksToEmbed(MODEL);
  for (const chunk of pending) {
    store.putEmbedding({
      chunkId: chunk.id,
      path: chunk.path,
      modelId: MODEL,
      dim: DIM,
      textHash: "test",
      vec: vectorFor(chunk.text),
    });
  }
  store.close();
  return pending.length;
}

function installFakeProvider(): void {
  setEmbeddingProviderFactory(async () => ({
    modelId: MODEL,
    embedPassage: async (text: string) => vectorFor(text),
    embedQuery: async (text: string) => vectorFor(text),
    dispose: async () => {},
  }));
}

function semanticSettings(created: TestWorkspace, overrides: Record<string, unknown> = {}) {
  return runtimeSettings(created.vault, {
    semanticSearch: true,
    embeddingModel: MODEL,
    embeddingDtype: "q8",
    ...overrides,
  });
}

describe("vector storage", () => {
  it("stores, reads and clears vectors per model", () => {
    const created = workspace();
    const seeded = seedVectors(created);
    expect(seeded).toBeGreaterThan(0);

    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    const stats = store.embeddingStats(MODEL);
    expect(stats.chunks).toBe(seeded);
    expect(stats.embedded).toBe(seeded);
    expect(stats.stale).toBe(0);
    expect(store.embeddingsFor(MODEL)).toHaveLength(seeded);
    expect(store.chunksToEmbed(MODEL)).toHaveLength(0);

    store.clearEmbeddings();
    expect(store.embeddingStats(MODEL).embedded).toBe(0);
    expect(store.chunksToEmbed(MODEL)).toHaveLength(seeded);
    store.close();
  });

  it("drops vectors when the note changes", () => {
    const created = workspace();
    seedVectors(created);
    created.write("Queue.md", "# Queue\n\nRewritten: a bounded queue with metrics.\n");
    const settings = runtimeSettings(created.vault);
    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    scanVault({ root: created.vault, store, settings, force: true });
    const stats = store.embeddingStats(MODEL);
    expect(stats.embedded).toBeLessThan(stats.chunks);
    expect(store.chunksToEmbed(MODEL).length).toBeGreaterThan(0);
    store.close();
  });
});

describe("semantic fusion", () => {
  it("finds a note with no lexical overlap with the query", () => {
    const created = workspace();
    seedVectors(created);
    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    const lexical = searchIndex(store, { query: "очередь", limit: 5 });
    expect(lexical.hits).toHaveLength(0);

    const hybrid = searchIndex(store, {
      query: "очередь",
      limit: 5,
      semantic: { vector: QUERY_VECTOR, modelId: MODEL },
    });
    expect(hybrid.signals).toContain("semantic");
    expect(hybrid.hits[0].path).toBe("Queue.md");
    store.close();
  });

  it("keeps lexical results first when both signals agree", () => {
    const created = workspace();
    seedVectors(created);
    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    const result = searchIndex(store, {
      query: "bounded queue",
      limit: 5,
      semantic: { vector: QUERY_VECTOR, modelId: MODEL },
    });
    expect(result.hits[0].path).toBe("Queue.md");
    expect(result.signals).toEqual(expect.arrayContaining(["chunks", "semantic"]));
    store.close();
  });
});

describe("dispatch with the semantic layer", () => {
  it("uses the injected provider and reports it in search and status", async () => {
    const created = workspace();
    seedVectors(created);
    installFakeProvider();
    const settings = semanticSettings(created);

    const search = await dispatchTool("obsidian_search", { query: "очередь" }, settings);
    expect(search.isError).toBeUndefined();
    const structured = search.structuredContent as {
      hits: Array<{ path: string }>;
      signals: string[];
      semantic: { requested: boolean; used: boolean; error: string | null };
    };
    expect(structured.semantic.requested).toBe(true);
    expect(structured.semantic.used).toBe(true);
    expect(structured.semantic.error).toBeNull();
    expect(structured.hits[0].path).toBe("Queue.md");

    const status = await dispatchTool("obsidian_status", {}, settings);
    const snapshot = status.structuredContent as {
      embedding: { enabled: boolean; model: string; embedded: number; chunks: number; state: string };
      memory: { rssMb: number; level: string; note: string | null };
    };
    expect(snapshot.embedding.enabled).toBe(true);
    expect(snapshot.embedding.model).toBe(MODEL);
    expect(snapshot.embedding.embedded).toBe(snapshot.embedding.chunks);
    expect(snapshot.embedding.state).toBe("done");
    expect(["ok", "warning", "high"]).toContain(snapshot.memory.level);
  });

  it("falls back to lexical results when the model cannot be loaded", async () => {
    const created = workspace();
    setEmbeddingProviderFactory(async () => {
      throw new Error("model unavailable in this test");
    });
    const settings = semanticSettings(created);

    const search = await dispatchTool("obsidian_search", { query: "bounded queue" }, settings);
    expect(search.isError).toBeUndefined();
    const structured = search.structuredContent as {
      hits: Array<{ path: string }>;
      semantic: { used: boolean; error: string | null };
    };
    expect(structured.semantic.used).toBe(false);
    expect(structured.semantic.error).toContain("model unavailable");
    expect(structured.hits[0].path).toBe("Queue.md");
  });

  it("can be turned off per call", async () => {
    const created = workspace();
    seedVectors(created);
    installFakeProvider();
    const settings = semanticSettings(created);
    const search = await dispatchTool(
      "obsidian_search",
      { query: "очередь", semantic: false },
      settings,
    );
    const structured = search.structuredContent as { semantic: { requested: boolean } };
    expect(structured.semantic.requested).toBe(false);
  });

  it("measures recall@k with obsidian_diagnose", async () => {
    const created = workspace();
    seedVectors(created);
    installFakeProvider();
    const settings = semanticSettings(created);

    const outcome = await dispatchTool(
      "obsidian_diagnose",
      { cases: [{ query: "очередь", expected_paths: ["Queue.md"] }], k: 3 },
      settings,
    );
    const report = outcome.structuredContent as {
      meanLexicalRecall: number | null;
      meanHybridRecall: number | null;
      results: Array<{ lexical: string[]; hybrid: string[] }>;
    };
    expect(report.meanHybridRecall).toBe(1);
    expect(report.meanLexicalRecall).toBe(0);
    expect(report.results[0].hybrid[0]).toBe("Queue.md");

    const withoutCases = await dispatchTool("obsidian_diagnose", {}, settings);
    const empty = withoutCases.structuredContent as { cases: number; note: string | null };
    expect(empty.cases).toBe(0);
    expect(empty.note).toContain("expected_paths");
  });
});

describe("memory policy", () => {
  it("is silent up to 2 GB, warns up to 4 GB, and never blocks", () => {
    const quiet = memoryReport(1024 ** 3);
    expect(quiet.level).toBe("ok");
    expect(quiet.note).toBeNull();

    const warning = memoryReport(3 * 1024 ** 3);
    expect(warning.level).toBe("warning");
    expect(warning.rssMb).toBe(3072);
    expect(warning.note).toContain("not a limit");

    const high = memoryReport(5 * 1024 ** 3);
    expect(high.level).toBe("high");
    expect(high.note).toContain("not a hard limit");

    expect(memoryReport(MEMORY_NORMAL_BYTES - 1).level).toBe("ok");
    expect(memoryReport(MEMORY_WARN_BYTES).level).toBe("high");
  });
});
