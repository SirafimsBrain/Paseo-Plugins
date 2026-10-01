import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMcpTool, MCP_TOOLS } from "../server/mcp-tools";
import type { RuntimeSettings } from "../shared/contracts";

function settings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    searchService: "searxng",
    searxngBaseUrl: "http://searxng.test/search",
    customBaseUrl: "",
    apiKey: "",
    timeoutMs: 5000,
    maxResults: 10,
    categories: "general,web",
    language: "",
    ...overrides,
  };
}

const CONTEXT = { settings: settings() };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          query: "cats",
          answers: ["42"],
          results: [
            { title: "First", url: "https://example.com/1", content: "One", engines: ["google"] },
          ],
        }),
        text: async () => "{}",
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP_TOOLS", () => {
  it("declares web_search and search_status with JSON schemas", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["web_search", "search_status"]),
    );
    const webSearch = MCP_TOOLS.find((tool) => tool.name === "web_search");
    expect(webSearch?.inputSchema.required).toContain("query");
    expect(webSearch?.inputSchema.properties.query.type).toBe("string");
    expect(webSearch?.inputSchema.properties.max_results.type).toBe("number");
  });
});

describe("dispatchMcpTool", () => {
  it("web_search returns formatted text for a real query", async () => {
    const result = await dispatchMcpTool("web_search", { query: "cats" }, CONTEXT);
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Query: cats");
    expect(text).toContain("Answer: 42");
    expect(text).toContain("1. First");
    expect(text).toContain("https://example.com/1");
  });

  it("web_search requires a non-empty query", async () => {
    for (const bad of [{}, { query: "" }, { query: "   " }, { query: 42 }]) {
      const result = await dispatchMcpTool("web_search", bad, CONTEXT);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("query is required");
    }
  });

  it("web_search clamps max_results to 1–30", async () => {
    const result = await dispatchMcpTool(
      "web_search",
      { query: "cats", max_results: 999 },
      CONTEXT,
    );
    expect(result.isError).toBeUndefined();
  });

  it("web_search surfaces provider failures as isError text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => "" })),
    );
    const result = await dispatchMcpTool("web_search", { query: "cats" }, CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 503");
  });

  it("search_status reports the configured provider and defaults", async () => {
    const result = await dispatchMcpTool("search_status", {}, CONTEXT);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(parsed.provider).toBe("searxng");
    expect(parsed.baseUrl).toBe("http://searxng.test/search");
    expect((parsed.defaults as Record<string, unknown>).maxResults).toBe(10);
    expect((parsed.defaults as Record<string, unknown>).categories).toBe("general,web");
  });

  it("brave without an API key fails with an actionable message", async () => {
    const result = await dispatchMcpTool(
      "web_search",
      { query: "cats" },
      { settings: settings({ searchService: "brave" }) },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("API key");
  });

  it("rejects unknown tools", async () => {
    const result = await dispatchMcpTool("nope", {}, CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool: nope");
  });
});
