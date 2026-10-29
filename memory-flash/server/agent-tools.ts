import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { MemoryStore } from "./store";

/**
 * Read-only `memory_flash_recall` agent tool (Paseo 0.14 `defineAgentTool`, 0.9.4).
 *
 * ## Why an attached tool exists next to the MCP server
 *
 * The nine `memory_*` MCP tools reach an agent through Paseo's MCP injection, which
 * is exactly the path that has failed before: OpenCode evicts an idle location and
 * the runtime-registered server (and its tools) disappear until the session reopens
 * (§13 of `__doc.md`). An attached tool is contributed by the plugin process on every
 * session open and delivered through Paseo's own tool transport, so it does not depend
 * on MCP registration at all.
 *
 * ## Why read-only, and why it does not duplicate anything
 *
 * * **Read-only** — writes must go through the MCP server (or the HTTP endpoint), where
 *   the store's validation, tagging rules and revision history apply unchanged; a second
 *   write path would be a second place for a memory to be written twice.
 * * **No duplication** — `index.server.ts` attaches it only when the agent has no
 *   memory-flash MCP server coming from its saved configuration, from the config file,
 *   or from this session's own injection (see `decideSessionOpen`). An agent that
 *   already has `memory-flash_memory_search` never sees this tool.
 *
 * The name is `memory_flash_recall`, not `memory_search`: attached-tool names are
 * checked against Paseo's own tools and other plugins' tools (a collision aborts the
 * session open), and this spelling can never collide with the MCP-side name.
 */
export function createMemoryRecallTool(store: MemoryStore): AgentToolDefinition {
  return defineAgentTool({
    name: "memory_flash_recall",
    title: "Recall from shared memory",
    description:
      "Read-only search of the shared team memory used by every coding agent " +
      "(decisions, bugfixes, procedures, handoffs, patterns). Use this when the " +
      "`memory-flash_memory_*` MCP tools are not in your tool list: run it before " +
      "starting a task with 2-4 differently worded queries, and read a hit fully by " +
      "passing its id. Saving, updating and handoffs stay with the MCP tools — this " +
      "one only reads.",
    input: z.object({
      query: z
        .string()
        .describe(
          "Free-text search; the user's phrasing, symbol names or the literal error text. Empty returns the most recent memories.",
        ),
      id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Fetch one memory by id instead of searching (content included)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results to return, 1-20 (default 10)."),
    }),
    execute(input, { agent, signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };

      if (input.id !== undefined) {
        const memory = store.getById(input.id);
        if (!memory) return { text: `No memory #${input.id}.`, isError: false };
        return {
          text: formatMemory(memory),
          structuredContent: { memory },
        };
      }

      const results = store.search({
        query: input.query,
        limit: input.limit ?? 10,
        kinds: [],
        tags: [],
        tagMode: "any",
        project: null,
        agentId: null,
      });

      if (results.length === 0) {
        return {
          text:
            `No memories matched ${JSON.stringify(input.query)}. An empty result says ` +
            `something about the wording, not about the base: retry with different words ` +
            `(synonyms, the error string, the file name) before concluding nothing is known.`,
          structuredContent: { count: 0, agent: agent.id },
        };
      }

      const lines = results.map((result, index) => {
        const memory = result.memory;
        const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
        const project = memory.project ? ` project=${memory.project}` : "";
        const body = (result.snippet ?? memory.content).replace(/\s+/g, " ").trim();
        return `${index + 1}. #${memory.id} ${memory.kind}: ${memory.title}${tags}${project}\n   ${body}`;
      });

      return {
        text: `${results.length} result(s) for ${JSON.stringify(input.query)}:\n${lines.join("\n")}\n\nPass an id to read one memory in full; use the memory-flash_* MCP tools to save or update.`,
        structuredContent: {
          count: results.length,
          ids: results.map((result) => result.memory.id),
        },
      };
    },
  });
}

/** Single memory rendered for the model (used by the `id` branch). */
function formatMemory(memory: {
  id: number;
  kind: string;
  title: string;
  content: string;
  tags: string[];
  project: string | null;
  updatedAt: string;
  revision: number;
}): string {
  const tags = memory.tags.length > 0 ? ` tags=[${memory.tags.join(", ")}]` : "";
  const project = memory.project ? ` project=${memory.project}` : "";
  return (
    `#${memory.id} ${memory.kind}: ${memory.title}\n` +
    `updated=${memory.updatedAt} revision=${memory.revision}${project}${tags}\n\n` +
    memory.content
  );
}
