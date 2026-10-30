import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { RuntimeSettings } from "../shared/contracts";
import { formatSearchResponse, searchWeb } from "./providers";

/**
 * Attached `bunny_web_search` agent tool (Paseo 0.14 `defineAgentTool`, 0.5.2).
 *
 * ## Why an attached tool next to the MCP server
 *
 * The MCP server reaches an agent through Paseo's MCP injection, and that path has
 * two documented failure modes: a provider that does not support MCP servers at all
 * (0.14.0 aborts such an open with `does not support MCP servers`), and an agent whose
 * saved configuration or record cannot be read, where the collision-safe answer is to
 * contribute nothing. In both cases the agent would otherwise ship without web search.
 * An attached tool is contributed by the plugin process on every session open and
 * delivered through Paseo's own tool transport, so it needs no MCP registration.
 *
 * ## Why it is named `bunny_web_search`, not `web_search`
 *
 * Paseo rejects a plugin tool whose name equals one of its own built-in tool names
 * (`plugin-tools.js`: *collides with Paseo tool …*) and the plugin runtime rejects a
 * name already taken by another plugin — both are load/open-time failures, so a
 * prefixed name is the collision-free spelling. It also cannot collide with the MCP
 * side, whose server key is `bunny-search` and whose tool name is `web_search`.
 *
 * ## Why it never duplicates the MCP server
 *
 * `decideSessionOpen` attaches it exactly where no launch-only `bunny-search` server
 * is being contributed in the same open and the agent's saved configuration does not
 * already carry it, so an agent never sees two names for the same search.
 */

/** The plugin's own ceiling for one call (the rec: a 10-minute limit). */
export const WEB_SEARCH_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/** Reads the effective settings from the host store (or its mirror on failure). */
export type RuntimeSettingsReader = () => Promise<RuntimeSettings>;

export function createWebSearchTool(
  readRuntimeSettings: RuntimeSettingsReader,
): AgentToolDefinition {
  return defineAgentTool({
    name: "bunny_web_search",
    title: "Search the web",
    description:
      "Search the web through the configured search service (default: DuckDuckJS " +
      "multi-engine, no API key). Returns formatted results: title, URL, content " +
      "snippet and source engines. Use when you need current information, " +
      "documentation, news or any content that is not in the local codebase.",
    input: z.object({
      query: z.string().min(1).describe("Search query."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("Maximum number of results, 1–30 (default from plugin settings)."),
      categories: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("SearXNG categories, comma-separated (e.g. 'general,web')."),
      language: z
        .string()
        .trim()
        .max(20)
        .optional()
        .describe("Language code ('ru', 'en', …); empty means auto-detect."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };

      try {
        const settings = await readRuntimeSettings();
        const query = input.query.trim();
        if (query.length === 0) {
          return { text: "query is required and must be a non-empty string.", isError: true };
        }

        const response = await withTimeout(
          searchWeb(
            {
              query,
              maxResults: input.max_results ?? settings.maxResults,
              categories: input.categories ?? settings.categories,
              language: input.language ?? settings.language,
            },
            settings,
          ),
          WEB_SEARCH_TOOL_TIMEOUT_MS,
        );

        if (signal.aborted) return { text: "Cancelled.", isError: true };

        return {
          text: formatSearchResponse(response),
          structuredContent: {
            query: response.query,
            provider: settings.searchService,
            count: response.results.length,
          },
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { text: message, isError: true };
      }
    },
  });
}

/**
 * One call ceiling. The provider's own `timeoutMs` (≤ 60 s) already bounds a single
 * request, but a provider may walk several engines, so the tool refuses to occupy an
 * agent turn for longer than ten minutes.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`web_search timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}
