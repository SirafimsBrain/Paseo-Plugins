import { describe, expect, it } from "vitest";
import { checkSearchService, searchWeb } from "../server/providers";
import type { RuntimeSettings } from "../shared/contracts";

/**
 * LIVE smoke test: real Python subprocess, real PyPI ddgs, real network.
 * Skipped by default — run explicitly with BUNNY_LIVE=1 to smoke-test
 * the ddgs backend against the actual search providers:
 *
 *   BUNNY_LIVE=1 npx vitest run tests/live-ddgs.test.ts
 */
const describeLive = process.env.BUNNY_LIVE === "1" ? describe : describe.skip;
const settings: RuntimeSettings = {
  searchService: "ddgs",
  duckduckjsEngine: "duckduckgo",
  proxyUrl: "",
  ddgsPythonPath: "",
  searxngBaseUrl: "",
  customBaseUrl: "",
  apiKey: "",
  timeoutMs: 30000,
  maxResults: 5,
  categories: "general",
  language: "",
};

describeLive("live ddgs provider", () => {
  it("returns real results through the full path", async () => {
    const res = await searchWeb({ query: "typescript", maxResults: 5 }, settings);
    console.log("results:", res.results.length, res.results.slice(0, 2));
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]?.title).toBeTruthy();
    expect(res.results[0]?.url).toMatch(/^https?:\/\//);
  }, 60000);

  it("connection check reports ok", async () => {
    const check = await checkSearchService(settings);
    console.log("check:", check);
    expect(check.ok).toBe(true);
    expect(check.error).toBeNull();
  }, 60000);
});
