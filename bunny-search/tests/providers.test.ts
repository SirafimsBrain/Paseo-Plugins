import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_AGENT,
  SearchServiceError,
  applyProxyUrl,
  checkSearchService,
  formatSearchResponse,
  getProvider,
  providerBaseUrl,
  searchWeb,
} from "../server/providers";
import type { RuntimeSettings } from "../shared/contracts";
import { clearSearchCache } from "../server/search-cache";

// ---------------------------------------------------------------------------
// DuckDuckJS mock — the real library performs live network requests; the
// adapter tests below exercise engine selection, normalization and errors
// with scripted engines instead (search itself is verified by the user).
// ---------------------------------------------------------------------------

const duckduckjsMock = vi.hoisted(() => ({
  calls: [] as Array<{ engine: string; query: string; options?: unknown }>,
  results: new Map<string, Array<Record<string, unknown>>>(),
  failures: new Set<string>(),
}));

vi.mock("@overclockedsenku/duckduckjs", () => {
  function makeEngine(id: string, name: string) {
    return class {
      readonly name = name;
      async search(query: string, options?: unknown): Promise<Array<Record<string, unknown>>> {
        duckduckjsMock.calls.push({ engine: id, query, options });
        if (duckduckjsMock.failures.has(id)) throw new Error(`[${name}] HTTP 429`);
        return duckduckjsMock.results.get(id) ?? [];
      }
    };
  }
  return {
    DuckDuckGoEngine: makeEngine("duckduckgo", "DuckDuckGo"),
    BraveEngine: makeEngine("brave", "Brave"),
    GoogleEngine: makeEngine("google", "Google"),
    MojeekEngine: makeEngine("mojeek", "Mojeek"),
    YahooEngine: makeEngine("yahoo", "Yahoo"),
  };
});

function settings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    searchService: "searxng",
    duckduckjsEngine: "auto",
    proxyUrl: "",
    ddgsPythonPath: "",
    searxngBaseUrl: "http://searxng.test/search",
    customBaseUrl: "",
    apiKey: "",
    timeoutMs: 5000,
    maxResults: 10,
    categories: "general,web",
    language: "",
    // Off by default so a mocked `fetch` sees every call; the cache tests opt in.
    cacheTtlSeconds: 0,
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
// DuckDuckJS adapter (default provider — engines mocked above)
// ---------------------------------------------------------------------------

describe("duckduckjs provider", () => {
  beforeEach(() => {
    duckduckjsMock.calls.length = 0;
    duckduckjsMock.results.clear();
    duckduckjsMock.failures.clear();
    // Reset the proxy dispatcher between tests.
    applyProxyUrl("");
  });

  afterEach(() => {
    applyProxyUrl("");
  });

  const textResult = (title: string, href: string, body: string) => ({
    type: "text",
    title,
    href,
    body,
  });

  it("auto mode falls through failing engines and maps the first answer", async () => {
    duckduckjsMock.failures.add("duckduckgo");
    duckduckjsMock.results.set("brave", [
      textResult("  Brave hit ", "https://example.com/a", "snip  pet   pet"),
    ]);
    const response = await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "duckduckjs" }),
    );
    expect(duckduckjsMock.calls.map((call) => call.engine)).toEqual(["duckduckgo", "brave"]);
    expect(response.results).toEqual([
      {
        title: "Brave hit",
        url: "https://example.com/a",
        content: "snip pet pet",
        engines: ["Brave"],
      },
    ]);
  });

  it("auto mode skips empty engines and returns an empty answer without errors", async () => {
    duckduckjsMock.results.set("yahoo", [textResult("Last", "https://example.com/y", "y")]);
    const response = await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "duckduckjs" }),
    );
    // duckduckgo..mojeek answered nothing, yahoo returned the result.
    expect(duckduckjsMock.calls.map((call) => call.engine)).toEqual([
      "duckduckgo",
      "brave",
      "google",
      "mojeek",
      "yahoo",
    ]);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.engines).toEqual(["Yahoo"]);
  });

  it("auto mode reports every engine failure when all fail", async () => {
    for (const id of ["duckduckgo", "brave", "google", "mojeek", "yahoo"]) {
      duckduckjsMock.failures.add(id);
    }
    await expect(
      searchWeb({ query: "cats", maxResults: 5 }, settings({ searchService: "duckduckjs" })),
    ).rejects.toThrow(/all engines failed/);
  });

  it("auto mode returns an empty response when every engine answers with nothing", async () => {
    const response = await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "duckduckjs" }),
    );
    expect(response.results).toEqual([]);
  });

  it("a pinned engine is used exclusively and surfaces its error", async () => {
    duckduckjsMock.failures.add("google");
    await expect(
      searchWeb(
        { query: "cats", maxResults: 5 },
        settings({ searchService: "duckduckjs", duckduckjsEngine: "google" }),
      ),
    ).rejects.toThrow(/DuckDuckJS \(Google\) failed: \[Google\] HTTP 429/);
    expect(duckduckjsMock.calls.map((call) => call.engine)).toEqual(["google"]);
  });

  it("maps the language setting to a region and clamps results", async () => {
    duckduckjsMock.results.set("duckduckgo", [
      textResult("1", "https://example.com/1", "one"),
      textResult("2", "https://example.com/2", "two"),
      textResult("3", "https://example.com/3", "three"),
    ]);
    const response = await searchWeb(
      { query: "cats", maxResults: 2, language: "ru" },
      settings({ searchService: "duckduckjs", language: "en" }),
    );
    expect(duckduckjsMock.calls[0]?.options).toEqual({ region: "ru-ru" });
    expect(response.results).toHaveLength(2);
  });

  it("omits the region when no language is configured", async () => {
    await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "duckduckjs" }),
    );
    expect(duckduckjsMock.calls[0]?.options).toBeUndefined();
  });

  it("rejects an invalid or non-http proxy URL", async () => {
    await expect(
      searchWeb(
        { query: "cats", maxResults: 5 },
        settings({ searchService: "duckduckjs", proxyUrl: "not a url" }),
      ),
    ).rejects.toThrow(/Invalid proxy URL/);
    await expect(
      searchWeb(
        { query: "cats", maxResults: 5 },
        settings({ searchService: "duckduckjs", proxyUrl: "socks5://127.0.0.1:1080" }),
      ),
    ).rejects.toThrow(/Unsupported proxy protocol/);
    expect(duckduckjsMock.calls).toHaveLength(0);
  });

  it("accepts a valid http proxy and still runs the search", async () => {
    duckduckjsMock.results.set("duckduckgo", [textResult("Hit", "https://example.com/p", "p")]);
    const response = await searchWeb(
      { query: "cats", maxResults: 5 },
      settings({ searchService: "duckduckjs", proxyUrl: "http://127.0.0.1:8080" }),
    );
    expect(response.results).toHaveLength(1);
  });

  it("check() succeeds on results and reports the rate-limit case", async () => {
    const okSettings = settings({ searchService: "duckduckjs" });
    duckduckjsMock.results.set("duckduckgo", [textResult("Hit", "https://example.com/p", "p")]);
    await expect(checkSearchService(okSettings)).resolves.toMatchObject({ ok: true });

    duckduckjsMock.results.clear();
    await expect(checkSearchService(okSettings)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/rate-limiting/),
    });
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
    for (const id of [
      "duckduckjs",
      "ddgs",
      "searxng",
      "duckduckgo",
      "brave",
      "custom-json",
      "tavily",
      "exa",
      "kagi",
      "perplexity",
    ] as const) {
      expect(getProvider(settings({ searchService: id })).id).toBe(id);
    }
  });

  it("reports the service base URL per provider", () => {
    expect(providerBaseUrl(settings())).toBe("http://searxng.test/search");
    expect(providerBaseUrl(settings({ searchService: "duckduckjs" }))).toBeNull();
    expect(providerBaseUrl(settings({ searchService: "ddgs" }))).toBeNull();
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

  it("marks an answer served from the cache", () => {
    const text = formatSearchResponse({
      query: "q",
      results: [{ title: "T", url: "U", content: "C" }],
      cached: true,
    });
    expect(text).toContain("Query: q (cached)");
  });
});

// ---------------------------------------------------------------------------
// API-key providers added in 0.7.5
// ---------------------------------------------------------------------------

describe("keyed providers", () => {
  function headersOf(call: FetchCall | undefined): Record<string, string> {
    return (call?.init?.headers ?? {}) as Record<string, string>;
  }

  it("advertises a base URL for every keyed service", () => {
    expect(providerBaseUrl(settings({ searchService: "tavily" }))).toBe(
      "https://api.tavily.com/search",
    );
    expect(providerBaseUrl(settings({ searchService: "exa" }))).toBe("https://api.exa.ai/search");
    expect(providerBaseUrl(settings({ searchService: "kagi" }))).toBe(
      "https://kagi.com/api/v0/search",
    );
    expect(providerBaseUrl(settings({ searchService: "perplexity" }))).toBe(
      "https://api.perplexity.ai/chat/completions",
    );
  });

  it("refuses to call a keyed service without a key, without touching the network", () => {
    const calls = stubFetch(() => jsonResponse({}));
    return Promise.all(
      (["tavily", "exa", "kagi", "perplexity"] as const).map((searchService) =>
        expect(
          searchWeb({ query: "q", maxResults: 1 }, settings({ searchService })),
        ).rejects.toThrow(/API key/),
      ),
    ).then(() => expect(calls).toHaveLength(0));
  });

  it("tavily: posts the query with a Bearer token and maps results", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ results: [{ title: "T", url: "https://e.com", content: "C" }] }),
    );
    const response = await searchWeb(
      { query: "vitest esm", maxResults: 3 },
      settings({ searchService: "tavily", apiKey: "tv-key" }),
    );
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headersOf(calls[0])["Authorization"]).toBe("Bearer tv-key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      query: "vitest esm",
      max_results: 3,
    });
    expect(response.results).toEqual([{ title: "T", url: "https://e.com", content: "C" }]);
  });

  it("exa: sends x-api-key and reads the page text", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ results: [{ title: "E", url: "https://e.com", text: "body" }] }),
    );
    const response = await searchWeb(
      { query: "q", maxResults: 2 },
      settings({ searchService: "exa", apiKey: "exa-key" }),
    );
    expect(headersOf(calls[0])["x-api-key"]).toBe("exa-key");
    expect(response.results[0]).toMatchObject({ title: "E", content: "body" });
  });

  it("kagi: sends Bot auth and keeps only t=0 results", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        data: [
          { t: 0, title: "K", url: "https://k.com", snippet: "s" },
          { t: 1, title: "related" },
        ],
      }),
    );
    const response = await searchWeb(
      { query: "q", maxResults: 5 },
      settings({ searchService: "kagi", apiKey: "kagi-key" }),
    );
    expect(new URL(calls[0]?.url ?? "").searchParams.get("q")).toBe("q");
    expect(headersOf(calls[0])["Authorization"]).toBe("Bot kagi-key");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ title: "K", content: "s" });
  });

  it("perplexity: answer plus citations, one result per source", async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [{ message: { content: "Short answer" } }],
        search_results: [{ title: "P", url: "https://p.com" }],
        citations: ["https://p.com", "https://c.com/page"],
      }),
    );
    const response = await searchWeb(
      { query: "q", maxResults: 5 },
      settings({ searchService: "perplexity", apiKey: "pp-key" }),
    );
    expect(response.answers).toEqual(["Short answer"]);
    expect(response.results.map((entry) => entry.url)).toEqual([
      "https://p.com",
      "https://c.com/page",
    ]);
    expect(formatSearchResponse(response)).toContain("Answer: Short answer");
  });

  it("reports a rejected key as a key problem", async () => {
    stubFetch(() => jsonResponse({}, 401));
    await expect(
      searchWeb(
        { query: "q", maxResults: 1 },
        settings({ searchService: "tavily", apiKey: "bad" }),
      ),
    ).rejects.toThrow(/rejected the API key/);
  });
});

// ---------------------------------------------------------------------------
// Response cache (0.7.5)
// ---------------------------------------------------------------------------

describe("response cache", () => {
  beforeEach(() => {
    clearSearchCache();
  });

  function answer(title: string) {
    return { query: "q", results: [{ title, url: "https://e.com", content: "C" }] };
  }

  it("reuses an identical answer and marks it cached", async () => {
    const calls = stubFetch(() => jsonResponse(answer("T")));
    const values = settings({ cacheTtlSeconds: 300 });
    const first = await searchWeb({ query: "q", maxResults: 10 }, values);
    const second = await searchWeb({ query: "  Q ", maxResults: 10 }, values);
    expect(calls).toHaveLength(1);
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(formatSearchResponse(second)).toContain("Query: q (cached)");
  });

  it("keys on the query, the result count and the service", async () => {
    const calls = stubFetch(() => jsonResponse(answer("T")));
    const values = settings({ cacheTtlSeconds: 300 });
    await searchWeb({ query: "q", maxResults: 10 }, values);
    await searchWeb({ query: "other", maxResults: 10 }, values);
    await searchWeb({ query: "q", maxResults: 5 }, values);
    expect(calls).toHaveLength(3);
  });

  it("neither stores nor reuses an answer when the TTL is 0", async () => {
    const calls = stubFetch(() => jsonResponse(answer("T")));
    const values = settings({ cacheTtlSeconds: 0 });
    await searchWeb({ query: "q", maxResults: 10 }, values);
    const second = await searchWeb({ query: "q", maxResults: 10 }, values);
    expect(calls).toHaveLength(2);
    expect(second.cached).toBeUndefined();
  });

  it("does not store an empty answer, which usually means a rate limit", async () => {
    const calls = stubFetch(() => jsonResponse({ query: "q", results: [] }));
    const values = settings({ cacheTtlSeconds: 300 });
    await searchWeb({ query: "q", maxResults: 10 }, values);
    await searchWeb({ query: "q", maxResults: 10 }, values);
    expect(calls).toHaveLength(2);
  });
});
