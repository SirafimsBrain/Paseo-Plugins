import { describe, expect, it } from "vitest";
import { searchInterfaceUrl } from "../server/ui-url";

describe("searchInterfaceUrl", () => {
  it("uses the explicit searchUiUrl when set", () => {
    expect(
      searchInterfaceUrl({
        searchService: "searxng",
        searxngBaseUrl: "http://127.0.0.1:8888/search",
        customBaseUrl: "",
        searchUiUrl: "http://omnirouter",
      }),
    ).toBe("http://omnirouter");
  });

  it("derives the API base URL origin for searxng", () => {
    expect(
      searchInterfaceUrl({
        searchService: "searxng",
        searxngBaseUrl: "http://omnirouter/search",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBe("http://omnirouter");
  });

  it("keeps the port when deriving the origin", () => {
    expect(
      searchInterfaceUrl({
        searchService: "searxng",
        searxngBaseUrl: "http://127.0.0.1:8888/search",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBe("http://127.0.0.1:8888");
  });

  it("derives from the custom endpoint for custom-json", () => {
    expect(
      searchInterfaceUrl({
        searchService: "custom-json",
        searxngBaseUrl: "",
        customBaseUrl: "https://example.com/api/search?q={query}",
        searchUiUrl: "",
      }),
    ).toBe("https://example.com");
  });

  it("falls back to provider front pages", () => {
    expect(
      searchInterfaceUrl({
        searchService: "duckduckjs",
        searxngBaseUrl: "",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBe("https://duckduckgo.com");
    expect(
      searchInterfaceUrl({
        searchService: "duckduckgo",
        searxngBaseUrl: "",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBe("https://duckduckgo.com");
    expect(
      searchInterfaceUrl({
        searchService: "brave",
        searxngBaseUrl: "",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBe("https://search.brave.com");
  });

  it("returns null for the ddgs subprocess provider", () => {
    expect(
      searchInterfaceUrl({
        searchService: "ddgs",
        searxngBaseUrl: "",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBeNull();
  });

  it("returns null when nothing can be derived", () => {
    expect(
      searchInterfaceUrl({
        searchService: "searxng",
        searxngBaseUrl: "   ",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBeNull();
    expect(
      searchInterfaceUrl({
        searchService: "searxng",
        searxngBaseUrl: "not a url",
        customBaseUrl: "",
        searchUiUrl: "",
      }),
    ).toBeNull();
  });
});
