import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { ObsidianApi, type VaultEvent } from "../server/obsidian-api";
import { scanVault } from "../server/scan";
import { searchIndex } from "../server/search";
import { BridgeStore } from "../server/store";
import { indexPathFor } from "../server/paths";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * Optional Local REST API enrichment: the client degrades instead of throwing,
 * and Obsidian's fuzzy search joins retrieval only when it answers.
 */

interface FakeServer {
  base: string;
  requests: Array<{ method: string; url: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

function fakeServer(options: { key?: string } = {}): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const clients = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      authorization: req.headers.authorization,
    });
    if (options.key && req.headers.authorization !== `Bearer ${options.key}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    const url = req.url ?? "/";
    if (url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authenticated: true, versions: { self: "5.5.2" } }));
      return;
    }
    if (url.startsWith("/search/simple/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            filename: "Garden.md",
            score: -1.5,
            matches: [{ match: { start: 0, end: 4, source: "content" }, context: "Tomatoes on the balcony" }],
          },
          { filename: "/Inbox/Plan.md", score: -0.5, matches: [] },
        ]),
      );
      return;
    }
    if (url.startsWith("/vault/")) {
      res.writeHead(200, { "Content-Type": "application/vnd.olrapi.note+json" });
      res.end(
        JSON.stringify({
          path: "Inbox/Plan.md",
          content: "# Plan",
          tags: ["plan"],
          links: ["Documentation/Spec.md"],
          backlinks: [{ path: "Inbox/Source.md" }],
          unresolvedLinks: ["Missing.md"],
        }),
      );
      return;
    }
    if (url.startsWith("/open/")) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.startsWith("/events/vault/modify/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "1", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events/stream` }));
      return;
    }
    if (url === "/events/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      clients.add(res);
      res.write(`data: ${JSON.stringify({ path: "Inbox/Live.md", file: { path: "Inbox/Live.md" } })}\n\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        async close() {
          for (const client of clients) client.destroy();
          clients.clear();
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

const workspaces: TestWorkspace[] = [];

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function indexedWorkspace(): TestWorkspace {
  const created = makeWorkspace({
    "Queue.md": "# Queue\n\nA bounded queue with retries.\n",
    "Garden.md": "# Garden\n\nTomatoes and basil.\n",
  });
  workspaces.push(created);
  const settings = runtimeSettings(created.vault);
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  scanVault({ root: created.vault, store, settings, force: true });
  store.close();
  return created;
}

describe("Local REST API client", () => {
  it("probes reachability and reports the version", async () => {
    const fake = await fakeServer({ key: "secret" });
    try {
      const api = new ObsidianApi({ url: fake.base, apiKey: "secret" });
      const probe = await api.probe();
      expect(probe.ok).toBe(true);
      expect(probe.authenticated).toBe(true);
      expect(probe.version).toBe("5.5.2");
      expect(probe.error).toBeNull();
      expect(fake.requests[0].authorization).toBe("Bearer secret");
    } finally {
      await fake.close();
    }
  });

  it("reports a rejected key instead of throwing", async () => {
    const fake = await fakeServer({ key: "secret" });
    try {
      const api = new ObsidianApi({ url: fake.base, apiKey: "wrong" });
      const probe = await api.probe();
      expect(probe.ok).toBe(false);
      expect(probe.authenticated).toBe(false);
      expect(probe.error).toContain("key was rejected");
    } finally {
      await fake.close();
    }
  });

  it("parses fuzzy search hits in Obsidian's ranking order", async () => {
    const fake = await fakeServer();
    try {
      const api = new ObsidianApi({ url: fake.base, apiKey: "" });
      const result = await api.simpleSearch("tomatoes", 5);
      expect(result.error).toBeNull();
      expect(result.hits.map((hit) => hit.path)).toEqual(["Garden.md", "Inbox/Plan.md"]);
      expect(result.hits[0].rank).toBe(0);
      expect(result.hits[0].snippet).toContain("balcony");
    } finally {
      await fake.close();
    }
  });

  it("reads note JSON links and backlinks, and opens a note", async () => {
    const fake = await fakeServer();
    try {
      const api = new ObsidianApi({ url: fake.base, apiKey: "" });
      const note = await api.noteLinks("Inbox/Plan.md");
      expect(note.error).toBeNull();
      expect(note.links?.links).toEqual(["Documentation/Spec.md"]);
      expect(note.links?.backlinks).toEqual(["Inbox/Source.md"]);
      expect(note.links?.unresolvedLinks).toEqual(["Missing.md"]);
      expect(note.links?.tags).toEqual(["plan"]);

      const opened = await api.openNote("Inbox/Plan.md");
      expect(opened.ok).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("follows an SSE vault event stream", async () => {
    const fake = await fakeServer();
    const events: VaultEvent[] = [];
    try {
      const api = new ObsidianApi({ url: fake.base, apiKey: "" });
      const { subscription, error } = await api.subscribeEvents((event) => events.push(event), [
        "modify",
      ]);
      expect(error).toBeNull();
      expect(subscription).not.toBeNull();
      for (let attempt = 0; attempt < 50 && events.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(events[0]).toMatchObject({ type: "modify", path: "Inbox/Live.md" });
      subscription?.stop();
    } finally {
      await fake.close();
    }
  });

  it("returns an error when Obsidian is not listening", async () => {
    const api = new ObsidianApi({ url: "http://127.0.0.1:9", apiKey: "", timeoutMs: 300 });
    const probe = await api.probe();
    expect(probe.ok).toBe(false);
    expect(probe.error).not.toBeNull();
  });
});

describe("fuzzy signal in retrieval", () => {
  it("lets Obsidian's own ranking surface a note with no lexical overlap", () => {
    const created = indexedWorkspace();
    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    const result = searchIndex(store, {
      query: "очередь",
      limit: 5,
      fuzzy: [{ path: "Garden.md", rank: 0, snippet: "Tomatoes and basil." }],
      enrichment: { enabled: true, error: null },
    });
    expect(result.signals).toContain("obsidian");
    expect(result.enrichment).toEqual({ enabled: true, used: true, error: null });
    expect(result.hits[0].path).toBe("Garden.md");
    store.close();
  });

  it("ignores fuzzy paths that are not in the index", () => {
    const created = indexedWorkspace();
    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    const result = searchIndex(store, {
      query: "очередь",
      fuzzy: [{ path: "Private/Secret.md", rank: 0, snippet: "hidden" }],
      enrichment: { enabled: true, error: null },
    });
    expect(result.signals).not.toContain("obsidian");
    expect(result.enrichment.used).toBe(false);
    store.close();
  });

  it("reports enrichment in the agent search result", async () => {
    const created = indexedWorkspace();
    const fake = await fakeServer();
    try {
      const settings = runtimeSettings(created.vault, {
        obsidianApiEnabled: true,
        obsidianApiUrl: fake.base,
      });
      const outcome = await dispatchTool("obsidian_search", { query: "очередь" }, settings);
      const result = outcome.structuredContent as {
        hits: Array<{ path: string }>;
        signals: string[];
        enrichment: { enabled: boolean; used: boolean; error: string | null };
      };
      expect(result.signals).toContain("obsidian");
      expect(result.enrichment).toEqual({ enabled: true, used: true, error: null });
      expect(result.hits[0].path).toBe("Garden.md");
    } finally {
      await fake.close();
    }
  });

  it("keeps search working when Obsidian is unreachable", async () => {
    const created = indexedWorkspace();
    const settings = runtimeSettings(created.vault, {
      obsidianApiEnabled: true,
      obsidianApiUrl: "http://127.0.0.1:9",
    });
    const outcome = await dispatchTool("obsidian_search", { query: "bounded queue" }, settings);
    const result = outcome.structuredContent as {
      hits: Array<{ path: string }>;
      enrichment: { enabled: boolean; used: boolean; error: string | null };
    };
    expect(outcome.isError).toBeUndefined();
    expect(result.hits[0].path).toBe("Queue.md");
    expect(result.enrichment.enabled).toBe(true);
    expect(result.enrichment.used).toBe(false);
    expect(result.enrichment.error).not.toBeNull();
  });
});
