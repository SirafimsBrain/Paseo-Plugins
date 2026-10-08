import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettingsFile } from "../server/settings-file";

/** Environment variables the module reads — cleared for every test. */
const SETTINGS_ENV_KEYS = [
  "BUNNY_SEARCH_BASE_URL",
  "SEARXNG_BASE_URL",
  "BUNNY_SEARCH_PROVIDER",
  "BUNNY_SEARCH_DUCKDUCKJS_ENGINE",
  "BUNNY_SEARCH_PROXY_URL",
  "BUNNY_SEARCH_PYTHON",
  "BUNNY_SEARCH_CUSTOM_URL",
  "BUNNY_SEARCH_API_KEY",
  "BUNNY_SEARCH_TIMEOUT_MS",
  "BUNNY_SEARCH_MAX_RESULTS",
  "BUNNY_SEARCH_CATEGORIES",
  "BUNNY_SEARCH_LANGUAGE",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SETTINGS_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SETTINGS_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tempSettingsFile(content: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `bunny-search-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("parseSettingsFile", () => {
  it("returns defaults when the file is missing", () => {
    const settings = parseSettingsFile("/nonexistent/bunny-search/settings.json");
    expect(settings).toEqual({
      searchService: "duckduckjs",
      duckduckjsEngine: "auto",
      proxyUrl: "",
      ddgsPythonPath: "",
      searxngBaseUrl: "http://127.0.0.1:8888/search",
      customBaseUrl: "",
      apiKey: "",
      timeoutMs: 20000,
      maxResults: 10,
      categories: "general,web",
      language: "",
    });
  });

  it("reads the ddgs python path from the file and environment", () => {
    const filePath = tempSettingsFile(
      JSON.stringify({ searchService: "ddgs", ddgsPythonPath: "/opt/venv/bin/python" }),
    );
    const fromFile = parseSettingsFile(filePath);
    expect(fromFile.searchService).toBe("ddgs");
    expect(fromFile.ddgsPythonPath).toBe("/opt/venv/bin/python");

    process.env.BUNNY_SEARCH_PYTHON = "/env/bin/python";
    const fromEnv = parseSettingsFile(filePath);
    expect(fromEnv.ddgsPythonPath).toBe("/env/bin/python");
  });

  it("reads the duckduckjs engine and proxy from the file and environment", () => {
    const filePath = tempSettingsFile(
      JSON.stringify({
        searchService: "duckduckjs",
        duckduckjsEngine: "mojeek",
        proxyUrl: "http://127.0.0.1:8080",
      }),
    );
    const fromFile = parseSettingsFile(filePath);
    expect(fromFile.searchService).toBe("duckduckjs");
    expect(fromFile.duckduckjsEngine).toBe("mojeek");
    expect(fromFile.proxyUrl).toBe("http://127.0.0.1:8080");

    process.env.BUNNY_SEARCH_DUCKDUCKJS_ENGINE = "yahoo";
    process.env.BUNNY_SEARCH_PROXY_URL = "http://proxy.test:3128";
    const fromEnv = parseSettingsFile(filePath);
    expect(fromEnv.duckduckjsEngine).toBe("yahoo");
    expect(fromEnv.proxyUrl).toBe("http://proxy.test:3128");
  });

  it("reads the host layout {revision, values}", () => {
    const filePath = tempSettingsFile(
      JSON.stringify({
        revision: 3,
        values: {
          searchService: "brave",
          apiKey: "secret",
          maxResults: 25,
          timeoutMs: 15000,
          categories: "news",
          language: "ru",
        },
      }),
    );
    const settings = parseSettingsFile(filePath);
    expect(settings.searchService).toBe("brave");
    expect(settings.apiKey).toBe("secret");
    expect(settings.maxResults).toBe(25);
    expect(settings.timeoutMs).toBe(15000);
    expect(settings.categories).toBe("news");
    expect(settings.language).toBe("ru");
  });

  it("accepts a flat JSON object too", () => {
    const filePath = tempSettingsFile(
      JSON.stringify({ searchService: "duckduckgo", language: "uk" }),
    );
    const settings = parseSettingsFile(filePath);
    expect(settings.searchService).toBe("duckduckgo");
    expect(settings.language).toBe("uk");
  });

  it("falls back to defaults on invalid JSON", () => {
    const filePath = tempSettingsFile("{not json");
    const settings = parseSettingsFile(filePath);
    expect(settings.searchService).toBe("duckduckjs");
    expect(settings.maxResults).toBe(10);
  });

  it("clamps out-of-range numbers and ignores unknown services", () => {
    const filePath = tempSettingsFile(
      JSON.stringify({
        searchService: "not-a-service",
        maxResults: 999,
        timeoutMs: 999999,
      }),
    );
    const settings = parseSettingsFile(filePath);
    expect(settings.searchService).toBe("duckduckjs");
    expect(settings.maxResults).toBe(30);
    expect(settings.timeoutMs).toBe(60000);
  });

  it("lets environment variables override the file", () => {
    const filePath = tempSettingsFile(JSON.stringify({ maxResults: 5 }));
    process.env.BUNNY_SEARCH_MAX_RESULTS = "7";
    process.env.BUNNY_SEARCH_BASE_URL = "http://env.test/search";
    const settings = parseSettingsFile(filePath);
    expect(settings.maxResults).toBe(7);
    expect(settings.searxngBaseUrl).toBe("http://env.test/search");
  });

  it("honors SEARXNG_BASE_URL for compatibility with the reference MCP", () => {
    process.env.SEARXNG_BASE_URL = "http://127.0.0.1:8888/search";
    const settings = parseSettingsFile("/nonexistent/settings.json");
    expect(settings.searxngBaseUrl).toBe("http://127.0.0.1:8888/search");
  });

  it("ignores malformed environment values", () => {
    process.env.BUNNY_SEARCH_PROVIDER = "nope";
    process.env.BUNNY_SEARCH_DUCKDUCKJS_ENGINE = "nope";
    process.env.BUNNY_SEARCH_MAX_RESULTS = "abc";
    const settings = parseSettingsFile("/nonexistent/settings.json");
    expect(settings.searchService).toBe("duckduckjs");
    expect(settings.duckduckjsEngine).toBe("auto");
    expect(settings.maxResults).toBe(10);
  });

  it("reads custom-json and provider overrides from the environment", () => {
    process.env.BUNNY_SEARCH_PROVIDER = "custom-json";
    process.env.BUNNY_SEARCH_CUSTOM_URL = "https://api.example/search?term={query}";
    process.env.BUNNY_SEARCH_API_KEY = "env-key";
    process.env.BUNNY_SEARCH_CATEGORIES = "science";
    process.env.BUNNY_SEARCH_LANGUAGE = "de";
    const settings = parseSettingsFile("/nonexistent/settings.json");
    expect(settings.searchService).toBe("custom-json");
    expect(settings.customBaseUrl).toBe("https://api.example/search?term={query}");
    expect(settings.apiKey).toBe("env-key");
    expect(settings.categories).toBe("science");
    expect(settings.language).toBe("de");
  });
});
