import type { BunnySearchSettings } from "../shared/settings";

/**
 * Derives the human-facing web interface URL of the configured
 * search service.
 *
 * The search API endpoint and the service's web interface are
 * deliberately separate settings: an instance like
 * `http://omnirouter/search` (JSON API) serves its interface at
 * `http://omnirouter`. When the user leaves `searchUiUrl` empty
 * the interface URL is derived from the API base URL's origin;
 * built-in providers (DuckDuckGo, Brave) fall back to their
 * public front pages.
 */

/** Built-in interface URLs for providers without a user-configured base URL. */
const PROVIDER_INTERFACES: Record<
  "duckduckgo" | "brave" | "tavily" | "exa" | "kagi" | "perplexity",
  string
> = {
  duckduckgo: "https://duckduckgo.com",
  brave: "https://search.brave.com",
  tavily: "https://tavily.com",
  exa: "https://exa.ai",
  kagi: "https://kagi.com",
  perplexity: "https://www.perplexity.ai",
};

/** Input: the settings fields the derivation needs. */
export interface InterfaceUrlInput {
  searchService: BunnySearchSettings["searchService"];
  searxngBaseUrl: string;
  customBaseUrl: string;
  searchUiUrl: string;
}

/**
 * Returns the web interface URL to open, or null when it cannot
 * be determined (no explicit URL and no usable API base URL).
 */
export function searchInterfaceUrl(values: InterfaceUrlInput): string | null {
  const explicit = values.searchUiUrl.trim();
  if (explicit.length > 0) return explicit;

  switch (values.searchService) {
    case "searxng":
      return originOf(values.searxngBaseUrl);
    case "custom-json":
      return originOf(values.customBaseUrl);
    case "duckduckgo":
      return PROVIDER_INTERFACES.duckduckgo;
    case "brave":
      return PROVIDER_INTERFACES.brave;
    case "duckduckjs":
      // Multi-engine provider: open the primary engine's interface.
      return PROVIDER_INTERFACES.duckduckgo;
    case "ddgs":
      // A Python subprocess against many engines — no single interface.
      return null;
    case "tavily":
      return PROVIDER_INTERFACES.tavily;
    case "exa":
      return PROVIDER_INTERFACES.exa;
    case "kagi":
      return PROVIDER_INTERFACES.kagi;
    case "perplexity":
      return PROVIDER_INTERFACES.perplexity;
  }
}

/** Origin of an absolute URL (scheme + host + port), or null when unparsable. */
function originOf(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}
