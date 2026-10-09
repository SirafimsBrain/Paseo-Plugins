import {
  mcpSaveInputSchema,
  mcpSearchInputSchema,
  memoryKindSchema,
  type Memory,
  type MemoryKind,
  type McpSearchInput,
  type McpSaveInput,
} from "../shared/memories";
import type { MemoryStore } from "./store";
import { diagnose, formatReport, type ControlQuery } from "./diagnose";

/**
 * MCP tool definitions and dispatch for the memory-flash server.
 *
 * The tool set follows the multi-agent memory pattern (see mcp-memory-service,
 * mcp-local-memory): save, search, read, update, delete, tag-oriented reads
 * and a handoff note. The dispatch layer is transport-independent so the stdio
 * server (mcp-server.ts) and tests share one implementation.
 */

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: { type?: string; description?: string; enum?: string[] };
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

function strArray(description: string): JsonSchemaProperty {
  return { type: "array", items: { type: "string" }, description };
}

function num(description: string): JsonSchemaProperty {
  return { type: "number", description };
}

const KIND_DESCRIPTION =
  "One of: decision, procedure, handoff, bugfix, pattern, pitfall, reference, note.";

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "memory_save",
    title: "Save a memory",
    description:
      "Save a durable note into the shared team memory: a decision, procedure, " +
      "handoff note for the next agent, bugfix explanation, a pattern that " +
      "worked, a pitfall that did not, or a reference to a file/URL. Tags make " +
      "the memory findable by other agents — always tag with the project name " +
      "and at least one topic.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["decision", "procedure", "handoff", "bugfix", "pattern", "pitfall", "reference", "note"], description: KIND_DESCRIPTION },
        title: str("Short unique title (max 200 chars)."),
        content: str("Full memory body. Include file paths, commands and reasoning."),
        tags: strArray("Lowercase topic tags, e.g. ['auth', 'login-flow', project]."),
        project: str("Project or repository name, if known."),
        agentId: str("Your agent id (e.g. 'opencode', 'cline'). Auto-set when omitted."),
      },
      required: ["title", "content"],
    },
  },
  {
    name: "memory_search",
    title: "Search shared memory",
    description:
      "Full-text search over the shared memory of ALL agents. Use before " +
      "starting work to recall prior decisions, known bugs and procedures. " +
      "Natural-language queries are fine (terms are ranked by relevance); " +
      "key=value pairs in the query (project=, kind=, tag=, agent=) act " +
      "as filters. Filters compose: query AND tags AND kind AND project.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Free-text query; empty returns the most recent memories. Quoted phrases match verbatim; key=value pairs (project=, kind=, tag=, agent=) act as filters."),
        tags: strArray("Filter: memories must carry at least one of these tags."),
        kinds: { type: "array", items: { type: "string" }, description: "Filter by memory kinds." },
        project: str("Filter by project name."),
        limit: num("Max results, 1-50 (default 10)."),
      },
    },
  },
  {
    name: "memory_get",
    title: "Read one memory",
    description: "Fetch a single memory by id, including its tags and metadata.",
    inputSchema: {
      type: "object",
      properties: { id: num("Memory id.") },
      required: ["id"],
    },
  },
  {
    name: "memory_update",
    title: "Update a memory",
    description:
      "Rewrite an existing memory (all fields are replaced). The previous " +
      "content stays in the revision history.",
    inputSchema: {
      type: "object",
      properties: {
        id: num("Memory id to update."),
        kind: { type: "string", enum: ["decision", "procedure", "handoff", "bugfix", "pattern", "pitfall", "reference", "note"], description: KIND_DESCRIPTION },
        title: str("New title."),
        content: str("New full body."),
        tags: strArray("Replacement tag list."),
        project: str("New project name."),
        agentId: str("New agent id."),
      },
      required: ["id", "title", "content"],
    },
  },
  {
    name: "memory_delete",
    title: "Delete a memory",
    description: "Delete an outdated or wrong memory by id. A tombstone is kept in history.",
    inputSchema: {
      type: "object",
      properties: { id: num("Memory id to delete.") },
      required: ["id"],
    },
  },
  {
    name: "memory_list_by_tag",
    title: "List memories by tag",
    description:
      "List recent memories carrying a specific tag (e.g. a project name or " +
      "'handoff'). Handy for picking up a topic without knowing what to search for. " +
      "Optionally narrow the listing to selected kinds (e.g. handoff and decision).",
    inputSchema: {
      type: "object",
      properties: {
        tag: str("Exact tag (case-insensitive)."),
        kinds: { type: "array", items: { type: "string", enum: ["decision", "procedure", "handoff", "bugfix", "pattern", "pitfall", "reference", "note"] }, description: KIND_DESCRIPTION },
        limit: num("Max results (default 20)."),
      },
      required: ["tag"],
    },
  },
  {
    name: "memory_diagnose",
    title: "Measure search quality",
    description:
      "Measure whether search actually finds the right memories. Pass control " +
      "queries together with the ids that answer them, and get back recall@1/" +
      "@5/@10/@50 plus, for every miss, WHETHER the answer was never retrieved " +
      "or merely ranked too low. Use this before and after changing search " +
      "behaviour: a 'not-retrieved' miss is a recall problem that no reordering " +
      "can fix, so it tells you whether to widen retrieval or only re-rank. " +
      "Read-only: it writes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description:
            "Control set: [{ \"query\": \"<what an agent would type>\", \"expectedIds\": [<memory id>] }]. " +
            "Several ids are allowed when any of them answers the question.",
          items: { type: "object" },
        },
      },
      required: ["queries"],
    },
  },
  {
    name: "memory_handoff",
    title: "Write a handoff note",
    description:
      "Write a handoff for the next agent working on this project: what was " +
      "done, what was tried and failed, current state, and the next steps. " +
      "Equivalent to memory_save with kind='handoff' plus a 'handoff' tag.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Handoff title, e.g. 'Auth refactor — state after step 2'."),
        content: str("Done / failed attempts / current state / next steps."),
        project: str("Project name."),
        tags: strArray("Additional topic tags."),
        agentId: str("Your agent id."),
      },
      required: ["title", "content"],
    },
  },
  {
    name: "memory_stats",
    title: "Memory statistics",
    description: "Counts by kind, agent, project and top tags of the shared memory.",
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

/** Formats one memory as a compact line for search results. */
function memoryLine(memory: Memory): string {
  const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
  const project = memory.project ? ` (${memory.project})` : "";
  return `#${memory.id} [${memory.kind}] ${memory.title}${project}${tags}`;
}

export interface McpDispatchContext {
  store: MemoryStore;
  /** Falls back into memory_save / memory_update when the client omits it. */
  defaultAgentId?: string;
}

export function dispatchMcpTool(name: string, args: unknown, context: McpDispatchContext): ToolResult {
  const { store } = context;
  const input = (args ?? {}) as Record<string, unknown>;

  // Normalize tool name: agents may prefix with server name (e.g. "memory-flash_memory_save")
  const normalizedName = name.startsWith("memory-flash_") ? name.slice("memory-flash_".length) : name;

  switch (normalizedName) {
    case "memory_save": {
      const parsed = mcpSaveInputSchema.safeParse(input);
      if (!parsed.success) return error(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const value: McpSaveInput = parsed.data;
      const agentId = value.agentId ?? (context.defaultAgentId || null);
      const memory = store.create({ ...value, agentId }, agentId ?? "mcp");
      return text({ saved: true, id: memory.id, kind: memory.kind, title: memory.title });
    }

    case "memory_search": {
      const parsed = mcpSearchInputSchema.safeParse(input);
      if (!parsed.success) return error(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const value: McpSearchInput = parsed.data;
      const results = store.search({
        query: value.query,
        tags: value.tags,
        kinds: value.kinds,
        project: value.project,
        agentId: null,
        tagMode: "any",
        limit: value.limit,
      });
      if (results.length === 0) return text({ matches: 0, results: [] });
      return text({
        matches: results.length,
        results: results.map((result) => ({
          line: memoryLine(result.memory),
          snippet: result.snippet ?? result.memory.content.slice(0, 300),
          id: result.memory.id,
          updatedAt: result.memory.updatedAt,
        })),
      });
    }

    case "memory_get": {
      const id = Number(input.id);
      if (!Number.isInteger(id) || id <= 0) return error("id must be a positive integer.");
      const memory = store.getById(id);
      if (!memory) return error(`Memory ${id} not found.`);
      return text(memory);
    }

    case "memory_update": {
      const id = Number(input.id);
      if (!Number.isInteger(id) || id <= 0) return error("id must be a positive integer.");
      const existing = store.getById(id);
      if (!existing) return error(`Memory ${id} not found.`);
      const agentId = (typeof input.agentId === "string" && input.agentId.trim()) || existing.agentId;
      const updated = store.update(
        id,
        {
          kind: (input.kind as McpSaveInput["kind"]) ?? existing.kind,
          title: String(input.title ?? existing.title),
          content: String(input.content ?? existing.content),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : existing.tags,
          project: input.project !== undefined ? (input.project as string | null) : existing.project,
          agentId: agentId ?? null,
          changedBy: agentId ?? "mcp",
        },
        agentId ?? "mcp",
      );
      return text({ updated: true, id: updated.id, revision: updated.revision });
    }

    case "memory_delete": {
      const id = Number(input.id);
      if (!Number.isInteger(id) || id <= 0) return error("id must be a positive integer.");
      const existing = store.getById(id);
      if (!existing) return error(`Memory ${id} not found.`);
      const deleted = store.delete(id, existing.agentId ?? "mcp");
      return text({ deleted });
    }

    case "memory_list_by_tag": {
      const tag = String(input.tag ?? "").trim();
      if (tag.length === 0) return error("tag is required.");
      const limit = Math.max(1, Math.min(50, Number(input.limit) || 20));
      const kinds: MemoryKind[] = [];
      for (const raw of Array.isArray(input.kinds) ? input.kinds : []) {
        const parsed = memoryKindSchema.safeParse(raw);
        if (!parsed.success) {
          return error(`Invalid kind: ${String(raw)}. ${KIND_DESCRIPTION}`);
        }
        kinds.push(parsed.data);
      }
      const results = store.search({
        query: "",
        tags: [tag],
        kinds,
        project: null,
        agentId: null,
        tagMode: "any",
        limit,
      });
      return text({
        tag,
        matches: results.length,
        memories: results.map((result) => ({
          line: memoryLine(result.memory),
          snippet: result.memory.content.slice(0, 300),
          id: result.memory.id,
        })),
      });
    }

    case "memory_handoff": {
      const title = String(input.title ?? "").trim();
      const content = String(input.content ?? "").trim();
      if (title.length === 0 || content.length === 0) return error("title and content are required.");
      const tags = (Array.isArray(input.tags) ? input.tags.map(String) : []).concat("handoff");
      const agentId = (typeof input.agentId === "string" && input.agentId.trim()) || context.defaultAgentId || null;
      const memory = store.create(
        {
          kind: "handoff",
          title,
          content,
          tags,
          project: typeof input.project === "string" && input.project.trim() ? input.project.trim() : null,
          agentId,
        },
        agentId ?? "mcp",
      );
      return text({ saved: true, id: memory.id, kind: memory.kind });
    }

    case "memory_diagnose": {
      const raw = Array.isArray(input.queries) ? input.queries : [];
      const control: ControlQuery[] = [];
      for (const entry of raw) {
        if (entry === null || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const query = typeof item.query === "string" ? item.query : "";
        const expectedIds = Array.isArray(item.expectedIds)
          ? item.expectedIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
          : [];
        control.push({ query, expectedIds });
      }
      const skipped = control.filter((c) => c.query.trim().length === 0 || c.expectedIds.length === 0).length;
      const report = diagnose(store, control);
      if (report.total === 0) {
        return error(
          "No usable control queries. Each entry needs { \"query\": \"...\", \"expectedIds\": [<memory id>] } " +
            "— first find the id with memory_search, then record the query you would have typed.",
        );
      }
      return text({
        summary: formatReport(report),
        recallAt: report.recallAt,
        hitsAt: report.hitsAt,
        total: report.total,
        poolCeiling: report.poolCeiling,
        retrievalFailures: report.retrievalFailures,
        rankingFailures: report.rankingFailures,
        misses: report.misses,
        skipped,
        queries: report.queries,
      });
    }

    case "memory_stats": {
      return text(store.stats());
    }

    default:
      return error(`Unknown tool: ${name} (normalized: ${normalizedName})`);
  }
}
