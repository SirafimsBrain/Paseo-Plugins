import {
  formatSearchResponse,
  getProvider,
  providerBaseUrl,
  searchWeb,
} from "./providers";
import type { RuntimeSettings } from "../shared/contracts";

/**
 * MCP tool definitions and dispatch for the bunny-search server.
 *
 * The dispatch layer is transport-independent so the stdio
 * server (`mcp-server.ts`) and tests share one implementation.
 * Tool semantics follow the reference SearXNG MCP: a single
 * `web_search` tool with `query`, `max_results` (1–30),
 * `categories` and `language` arguments, returning formatted
 * text an agent can use directly.
 */

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: { type?: string; description?: string };
  enum?: string[];
  default?: unknown;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

function str(description: string): JsonSchemaProperty {
  return { type: "string", description };
}

function num(description: string): JsonSchemaProperty {
  return { type: "number", description };
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "web_search",
    title: "Search the web",
    description:
      "Search the web through the configured search service " +
      "(default: SearXNG). Returns formatted results: title, URL, " +
      "content snippet and source engines. Use when you need " +
      "current information, documentation, news or any content " +
      "that is not in the local codebase.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search query."),
        max_results: num("Maximum number of results, 1–30 (default 10)."),
        categories: str(
          "SearXNG categories, comma-separated (e.g. 'general,web', " +
            "'news', 'science'). Ignored by other providers.",
        ),
        language: str(
          "Language code ('ru', 'en', 'uk', …) or empty for auto-detect.",
        ),
      },
      required: ["query"],
    },
  },
  {
    name: "search_status",
    title: "Search service status",
    description:
      "Reports which search service is configured (SearXNG by " +
      "default), its base URL and the default result settings. " +
      "Use to check that the web search MCP is connected before " +
      "relying on it.",
    inputSchema: { type: "object", properties: {} },
  },
];

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(result: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function error(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export interface McpDispatchContext {
  settings: RuntimeSettings;
}

export function dispatchMcpTool(
  name: string,
  args: unknown,
  context: McpDispatchContext,
): ToolResult | Promise<ToolResult> {
  const { settings } = context;
  const input = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "web_search": {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (query.length === 0) {
        return error("query is required and must be a non-empty string.");
      }
      const maxResults =
        typeof input.max_results === "number" && Number.isFinite(input.max_results)
          ? Math.max(1, Math.min(30, Math.trunc(input.max_results)))
          : settings.maxResults;
      const categories =
        typeof input.categories === "string" && input.categories.trim().length > 0
          ? input.categories.trim()
          : settings.categories;
      const language = typeof input.language === "string" ? input.language.trim() : settings.language;
      return searchWeb(
        { query, maxResults, categories, language },
        settings,
      )
        .then((response) => text({ text: formatSearchResponse(response) }))
        .catch((cause: unknown) => {
          const message =
            cause instanceof Error
              ? cause.message
              : String(cause);
          return error(message);
        });
    }

    case "search_status": {
      return text({
        provider: settings.searchService,
        baseUrl: providerBaseUrl(settings),
        defaults: {
          maxResults: settings.maxResults,
          categories: settings.categories,
          language: settings.language || "(auto)",
          timeoutMs: settings.timeoutMs,
        },
      });
    }

    default:
      return error(`Unknown tool: ${name}`);
  }
}
