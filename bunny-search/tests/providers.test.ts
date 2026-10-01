import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_AGENT,
  SearchServiceError,
  checkSearchService,
  formatSearchResponse,
  getProvider,
  providerBaseUrl,
  searchWeb,
} from "../server/providers";
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

/** Minimal fetch Response stand-in. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse(html: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not JSON");
    },
    text: async () => html,
  };
}

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: FetchCall[] = [];
  const stub = vi.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

/** fetch that rejects on abort, like the real one. */
function stubAbortingFetch() {
  const stub = vi.fn((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        (error as Error & { code?: string }).code = "ABORT_ERR";
        reject(error);
      });
    }),
  );
  vi.stubGlobal("fetch", stub);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// SearXNG adapter (ported from the reference searxng_mcp_server.py)
// ---------------------------------------------------------------------------

describe("searxng provider", () => {
  it("builds the query URL and sends the reference user agent", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ query: "cats", results: [] }),
    );
    await searchWeb(
      { query: "cats & dogs", maxResults: 5, categories: "news", language: "ru" },
      settings({ language: "en" }),
    );
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("q")).toBe("cats & dogs");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("categories")).toBe("news");
    expect(url.searchParams.get("language")).toBe("ru");
    expect((calls[0]?.init?.headers as Record<string, string>)["User-Agent"]).toBe(
      USER_AGENT,
    );
  });

  it("normalizes results, engines, answers and the singular suggestion", async () => {
    stubFetch(() =>
      jsonResponse({
        query: "cats",
        answers: ["42"],
        suggestion: "cat",
        results: [
          {
            title: "  Cats  ",
            url: "https://example.com/cats",
            content: "About  cats\tcats",
            engines: ["google", "bing"],
          },
        ],
      }),
    );
    const response = await searchWeb({ query: "cats", maxResults: 10 }, settings());
    expect(response.query).toBe("cats");
    expect(response.answers).toEqual(["42"]);
    expect(response.suggestion).toBe("cat");
    expect(response.results).toEqual([
      {
        title: "Cats",
        url: "https://example.com/cats",
        content: "About cats cats",
        engines: ["google", "bing"],
      },
    ]);
  });

  it("falls back to suggestions[] (live SearXNG) and then corrections[]", async () => {
    stubFetch(() => jsonResponse({ suggestions: ["live hint"] }));
    const fromSuggestions = await searchWeb(
      { query: "cats", maxResults: 10 },
      settings(),
    );
    expect(fromSuggestions.suggestion).toBe("live hint");

    stubFetch(() => jsonResponse({ corrections: ["corrected"] }));
    const fromCorrections = await searchWeb(
      { query: "cats", maxResults: 10 },
      settings(),
    );
    expect(fromCorrections.suggestion).toBe("corrected");
  });

  it("clamps results to max_results", async () => {
    stubFetch(() =>
      jsonResponse({
        results: [1, 2, 3].map((n) => ({
          title: `Result ${n}`,
          url: `https://example.com/${n}`,
          content: "snippet",
        })),
      }),
    );
    const response = await searchWeb({ query: "cats", maxResults: 2 }, settings());
    expect(response.results).toHaveLength(2);
  });

  it("maps HTTP failures to a friendly error", async () => {
    stubFetch(() => jsonResponse({}, 500));
    await expect(searchWeb({ query: "cats", maxResults: 5 }, settings())).rejects.toThrow(
      "SearXNG returned HTTP 500",
    );
  });

  it("maps invalid JSON to a friendly error", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
      text: async () => "{",
    }));
    await expect(searchWeb({ query: "cats", maxResults: 5 }, settings())).rejects.toThrow(
      "invalid JSON",
    );
  });

  it("maps connection failures to actionable messages", async () => {
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:8888");
    (refused as Error & { code?: string }).code = "ECONNREFUSED";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(refused)),
    );
    await expect(searchWeb({ query: "cats", maxResults: 5 }, settings())).rejects.toThrow(
      SearchServiceError,
    );
    await expect(searchWeb({ query: "cats", maxResults: 5 }, settings())).rejects.toThrow(
      /connection refused/i,
    );

    const dns = new Error("getaddrinfo ENOTFOUND searxng.test");
    (dns as Error & { code?: string }).code = "ENOTFOUND";
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(dns)));
    await expect(searchWeb({ query: "cats", maxResults: 5 }, settings())).rejects.toThrow(
      /Cannot resolve the host/i,
    );
  });

  it("maps the configured timeout to a friendly error", async () => {
    stubAbortingFetch();
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings({ timeoutMs: 25 })),
    ).rejects.toThrow(/did not respond within the configured timeout/i);
  });

  it("check() reports ok with a filled latency", async () => {
    stubFetch(() => jsonResponse({ results: [] }));
    const result = await checkSearchService(settings());
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(typeof result.latencyMs).toBe("number");
  });

  it("check() reports the failure instead of throwing", async () => {
    stubFetch(() => jsonResponse({}, 503));
    const result = await checkSearchService(settings());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 503");
  });
});

// ---------------------------------------------------------------------------
// DuckDuckGo HTML adapter
// ---------------------------------------------------------------------------

describe("duckduckgo provider", () => {
  const ddgHtml = `
    <div class="links_main">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;uddg2=x">Cats &amp; <b>Dogs</b></a>
      <a class="result__snippet">A snippet &quot;about&quot; cats</a>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second</a>
    </div>
  `;

  it("parses results, unwraps redirect links and decodes entities", async () => {
    const calls = stubFetch(() => htmlResponse(ddgHtml));
    const response = await searchWeb({ query: "cats", maxResults: 10 }, settings({ searchService: "duckduckgo" }));
    expect(calls[0]?.url).toContain("https://html.duckduckgo.com/html/?q=cats");
    expect(response.results).toEqual([
      {
        title: "Cats & Dogs",
        url: "https://example.com/a",
        content: 'A snippet "about" cats',
      },
      { title: "Second", url: "https://example.org/b", content: "" },
    ]);
  });

  it("keeps non-redirect hrefs as-is", async () => {
    stubFetch(() =>
      htmlResponse('<a class="result__a" href="https://direct.example/x">Direct</a>'),
    );
    const response = await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "duckduckgo" }),
    );
    expect(response.results[0]?.url).toBe("https://direct.example/x");
  });

  it("maps HTTP failures to a friendly error", async () => {
    stubFetch(() => htmlResponse("", 403));
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings({ searchService: "duckduckgo" })),
    ).rejects.toThrow("DuckDuckGo returned HTTP 403");
  });
});

// ---------------------------------------------------------------------------
// Brave Search adapter
// ---------------------------------------------------------------------------

describe("brave provider", () => {
  it("rejects without an API key", async () => {
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings({ searchService: "brave" })),
    ).rejects.toThrow(/API key/i);
  });

  it("sends the subscription token and maps results", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        web: {
          results: [
            { title: "Brave result", url: "https://brave.example/1", description: "Desc" },
          ],
        },
      }),
    );
    const response = await searchWeb(
      { query: "cats", maxResults: 5, language: "en" },
      settings({ searchService: "brave", apiKey: "TEST-KEY" }),
    );
    expect(calls[0]?.url).toContain("https://api.search.brave.com/res/v1/web/search?q=cats&count=5&search_lang=en");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("TEST-KEY");
    expect(response.results).toEqual([
      { title: "Brave result", url: "https://brave.example/1", content: "Desc" },
    ]);
  });

  it("maps 401/403 to an actionable key error", async () => {
    stubFetch(() => jsonResponse({}, 401));
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings({ searchService: "brave", apiKey: "BAD" })),
    ).rejects.toThrow(/rejected the API key/i);
  });
});

// ---------------------------------------------------------------------------
// Custom JSON endpoint adapter
// ---------------------------------------------------------------------------

describe("custom-json provider", () => {
  it("rejects without a configured URL", async () => {
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings({ searchService: "custom-json" })),
    ).rejects.toThrow(/Custom search endpoint URL/i);
  });

  it("substitutes and URL-encodes the {query} placeholder", async () => {
    const calls = stubFetch(() => jsonResponse([]));
    await searchWeb(
      { query: "cats & dogs", maxResults: 5 },
      settings({ searchService: "custom-json", customBaseUrl: "https://api.example/search?term={query}" }),
    );
    expect(calls[0]?.url).toBe("https://api.example/search?term=cats%20%26%20dogs");
  });

  it("appends q= to a URL without a placeholder, respecting existing params", async () => {
    const calls = stubFetch(() => jsonResponse([]));
    await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "custom-json", customBaseUrl: "https://api.example/search?lang=en" }),
    );
    expect(calls[0]?.url).toBe("https://api.example/search?lang=en&q=cats");
  });

  it("accepts a top-level array payload", async () => {
    stubFetch(() =>
      jsonResponse([{ title: "T1", url: "https://example.com/1", snippet: "S1" }]),
    );
    const response = await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "custom-json", customBaseUrl: "https://api.example/search" }),
    );
    expect(response.results).toEqual([
      { title: "T1", url: "https://example.com/1", content: "S1" },
    ]);
  });

  it("accepts nested results/data/items/web shapes and heuristic fields", async () => {
    const shapes = [
      { results: [{ name: "N1", link: "https://example.com/1", description: "D1" }] },
      { data: { items: [{ heading: "H2", href: "https://example.com/2", body: "B2" }] } },
      { web: { results: [{ title: "T3", url: "https://example.com/3", text: "X3" }] } },
    ];
    for (const payload of shapes) {
      stubFetch(() => jsonResponse(payload));
      const response = await searchWeb(
        { query: "cats", maxResults: 5 },
        settings({ searchService: "custom-json", customBaseUrl: "https://api.example/search" }),
      );
      expect(response.results).toHaveLength(1);
    }
  });

  it("sends the API key as a bearer token when configured", async () => {
    const calls = stubFetch(() => jsonResponse([]));
    await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "custom-json", customBaseUrl: "https://api.example/search", apiKey: "KEY" }),
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer KEY");
  });
});

// ---------------------------------------------------------------------------
// Registry, status helpers and formatting
// ---------------------------------------------------------------------------

describe("registry and helpers", () => {
  it("resolves every provider by id", () => {
    for (const id of ["searxng", "duckduckgo", "brave", "custom-json"] as const) {
      expect(getProvider(settings({ searchService: id })).id).toBe(id);
    }
  });

  it("reports the service base URL per provider", () => {
    expect(providerBaseUrl(settings())).toBe("http://searxng.test/search");
    expect(providerBaseUrl(settings({ searchService: "duckduckgo" }))).toBe(
      "https://html.duckduckgo.com/html/",
    );
    expect(providerBaseUrl(settings({ searchService: "brave" }))).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(providerBaseUrl(settings({ searchService: "custom-json", customBaseUrl: "" }))).toBeNull();
    expect(providerBaseUrl(settings({ searchService: "custom-json", customBaseUrl: "https://api.example/search" }))).toBe(
      "https://api.example/search",
    );
  });
});

describe("formatSearchResponse", () => {
  it("renders query, answer, numbered results and suggestion", () => {
    const text = formatSearchResponse({
      query: "cats",
      answers: ["42"],
      suggestion: "cat",
      results: [
        { title: "First", url: "https://example.com/1", content: "One", engines: ["google"] },
        { title: "", url: "https://example.com/2", content: "" },
      ],
    });
    expect(text).toContain("Query: cats");
    expect(text).toContain("Answer: 42");
    expect(text).toContain("1. First");
    expect(text).toContain("   https://example.com/1");
    expect(text).toContain("   One");
    expect(text).toContain("   Engines: google");
    expect(text).toContain("2. (no title)");
    expect(text).toContain("Did you mean: cat");
  });

  it("truncates snippets to 300 characters with an ellipsis", () => {
    const long = "x".repeat(500);
    const text = formatSearchResponse({
      query: "q",
      results: [{ title: "T", url: "U", content: long }],
    });
    expect(text).toContain(`${"x".repeat(300)}…`);
    expect(text).not.toContain("x".repeat(301));
  });

  it("renders an empty-result fallback", () => {
    const text = formatSearchResponse({ query: "q", results: [] });
    expect(text).toContain("No results found.");
  });
});
