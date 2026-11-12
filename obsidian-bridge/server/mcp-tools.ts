import * as fs from "node:fs";
import type { RuntimeSettings } from "../shared/settings";
import { indexPathFor } from "./paths";
import { scanVault } from "./scan";
import { searchIndex } from "./search";
import { BridgeStore } from "./store";
import { checkVault, readVaultNote, splitList } from "./vault";

/**
 * Tool definitions and dispatch for the obsidian-bridge MCP server.
 *
 * The dispatch layer is transport-independent: the stdio server
 * (`mcp-server.ts`), the attached agent tools (`agent-tools.ts`) and the tests
 * all share it.
 *
 * ## Operating contract, encoded in the descriptions
 *
 * This is a **reference** tool for the user's Obsidian knowledge base. It is
 * injected so an agent *can* answer an explicit request; nothing here makes an
 * agent consult the vault on its own, and nothing writes. An agent's own
 * memory belongs to `memory-flash`, project planning belongs to
 * `luck-planner`. The sentences below are the only contract an agent always
 * sees, so they state that explicitly.
 */

export const CONTRACT_SENTENCE =
  "Reference tool for the user's Obsidian knowledge base: use it only when the user " +
  "explicitly asks about their Obsidian notes, documents, plans or research. Do not use " +
  "it to record agent memory (that is memory-flash) or to plan project work (luck-planner).";

export const MCP_INSTRUCTIONS =
  "Obsidian Bridge gives read access to the user's Obsidian vault: notes, plans, " +
  "recommendations and research. Use it only when the user asks about those documents, and " +
  "cite the note path (and heading) you took the answer from. It does not store agent " +
  "memory — memory-flash does — and it does not plan work — luck-planner does. Results are " +
  "snippets: read the note before quoting it.";

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

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "obsidian_search",
    title: "Search the Obsidian vault",
    description:
      `${CONTRACT_SENTENCE} Hybrid search: full-text over heading chunks fused with title/alias ` +
      "matches and wikilink proximity. Returns ranked snippets with the note path and heading, " +
      "so the answer can be cited.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for. Empty lists the most recent notes." },
        limit: { type: "number", description: "Maximum hits, 1–50 (default from plugin settings)." },
        folder: { type: "string", description: "Restrict to a vault-relative folder." },
        tags: { type: "string", description: "Comma-separated tags every hit must carry." },
        budget_chars: {
          type: "number",
          description: "Character budget for the packed answer text (default from settings).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "obsidian_read",
    title: "Read an Obsidian note",
    description:
      `${CONTRACT_SENTENCE} Reads a note (or one heading subtree) from the vault, including its ` +
      "frontmatter, tags and link counts.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path, e.g. Projects/x/Plan.md." },
        heading: { type: "string", description: "Optional heading text; reads only that section." },
      },
      required: ["path"],
    },
  },
  {
    name: "obsidian_outline",
    title: "Outline an Obsidian note",
    description:
      `${CONTRACT_SENTENCE} Returns a note's headings, frontmatter keys, tags, outgoing links and ` +
      "backlinks without the body text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path." },
      },
      required: ["path"],
    },
  },
  {
    name: "obsidian_list",
    title: "List Obsidian notes",
    description:
      `${CONTRACT_SENTENCE} Lists notes under a folder with title, size and modification time.`,
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Vault-relative folder; empty lists the whole vault." },
        limit: { type: "number", description: "Maximum notes, 1–500 (default 50)." },
      },
    },
  },
  {
    name: "obsidian_links",
    title: "Inspect vault links",
    description:
      `${CONTRACT_SENTENCE} Returns a note's resolved wikilinks and backlinks, or the vault's ` +
      "unresolved links (typos and missing notes).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path. Empty = unresolved links." },
        limit: { type: "number", description: "Maximum entries, 1–500 (default 100)." },
      },
    },
  },
  {
    name: "obsidian_index",
    title: "Reindex the vault",
    description:
      "Rebuilds the local index from the vault folder. Use after notes changed outside the " +
      "watcher's reach, or when search results look stale.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "obsidian_status",
    title: "Vault index status",
    description:
      "Reports the configured vault path, index counts, index freshness and read-only state. " +
      "Use it to check that the bridge is connected before relying on it.",
    inputSchema: { type: "object", properties: {} },
  },
];

export interface ToolOutcome {
  text: string;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ToolRuntime {
  root: string;
  store: BridgeStore;
}

/** Opens the vault and its index, or explains why it cannot. */
export function openRuntime(
  settings: RuntimeSettings,
  options: { readOnly?: boolean } = {},
): { runtime: ToolRuntime } | { error: string } {
  const root = settings.vaultPath.trim();
  if (root.length === 0) {
    return {
      error:
        "The Obsidian vault path is not configured. Ask the user to open Settings → Plugins → " +
        "Obsidian Bridge and set the vault path; do not guess it.",
    };
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return { error: `Vault path '${root}' is not a readable directory.` };
  }
  try {
    const store = new BridgeStore(indexPathFor(root), { stemming: settings.ftsStemming });
    void options;
    return { runtime: { root, store } };
  } catch (cause) {
    return {
      error: `Could not open the index: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

function json(value: unknown): ToolOutcome {
  return { text: JSON.stringify(value, null, 2), structuredContent: value };
}

function fail(message: string): ToolOutcome {
  return { text: message, isError: true };
}

export function dispatchTool(
  name: string,
  args: unknown,
  settings: RuntimeSettings,
): ToolOutcome {
  const input = (args ?? {}) as Record<string, unknown>;
  const opened = openRuntime(settings);
  if ("error" in opened) return fail(opened.error);
  const { runtime } = opened;
  try {
    switch (name) {
      case "obsidian_search": {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        const limit =
          typeof input.limit === "number" && Number.isFinite(input.limit)
            ? Math.max(1, Math.min(50, Math.trunc(input.limit)))
            : settings.maxResults;
        const folder = typeof input.folder === "string" ? input.folder.trim() : "";
        const tags =
          typeof input.tags === "string" && input.tags.trim().length > 0
            ? splitList(input.tags)
            : [];
        const budget =
          typeof input.budget_chars === "number" && Number.isFinite(input.budget_chars)
            ? Math.max(500, Math.min(60000, Math.trunc(input.budget_chars)))
            : settings.searchBudgetChars;
        const result = searchIndex(runtime.store, {
          query,
          limit,
          folder,
          tags,
          budgetChars: budget,
          snippetChars: settings.snippetChars,
        });
        const text = result.text.length > 0 ? result.text : (result.note ?? "No results.");
        return {
          text,
          structuredContent: {
            query: result.query,
            hits: result.hits,
            signals: result.signals,
            tookMs: result.tookMs,
            note: result.note,
          },
        };
      }

      case "obsidian_read": {
        const relPath = typeof input.path === "string" ? input.path.trim() : "";
        if (relPath.length === 0) return fail("path is required.");
        const heading = typeof input.heading === "string" ? input.heading : undefined;
        const note = readVaultNote(runtime.root, relPath, { heading });
        if ("error" in note) return fail(note.error);
        const meta = runtime.store.noteMeta(relPath);
        return {
          text: note.text,
          structuredContent: {
            path: relPath,
            title: note.parsed.title,
            heading: heading ?? null,
            tags: note.parsed.tags,
            frontmatter: note.parsed.frontmatter,
            headings: note.parsed.headings,
            backlinks: runtime.store.backlinksOf(relPath).length,
            indexed: meta !== null,
            truncated: note.truncated,
          },
        };
      }

      case "obsidian_outline": {
        const relPath = typeof input.path === "string" ? input.path.trim() : "";
        if (relPath.length === 0) return fail("path is required.");
        const note = readVaultNote(runtime.root, relPath, { maxBytes: 4 * 1024 * 1024 });
        if ("error" in note) return fail(note.error);
        return json({
          path: relPath,
          title: note.parsed.title,
          headings: note.parsed.headings,
          frontmatterKeys: Object.keys(note.parsed.frontmatter),
          tags: note.parsed.tags,
          links: runtime.store.outgoingLinks(relPath),
          backlinks: runtime.store.backlinksOf(relPath),
        });
      }

      case "obsidian_list": {
        const folder = typeof input.folder === "string" ? input.folder.trim() : "";
        const limit =
          typeof input.limit === "number" && Number.isFinite(input.limit)
            ? Math.max(1, Math.min(500, Math.trunc(input.limit)))
            : 50;
        const rows = runtime.store.notesUnder(folder, limit);
        return json({
          folder: folder || "(whole vault)",
          count: rows.length,
          notes: rows.map((row) => ({
            path: row.path,
            title: row.title,
            words: row.word_count,
            modifiedAt: new Date(row.mtime_ms).toISOString(),
          })),
        });
      }

      case "obsidian_links": {
        const relPath = typeof input.path === "string" ? input.path.trim() : "";
        const limit =
          typeof input.limit === "number" && Number.isFinite(input.limit)
            ? Math.max(1, Math.min(500, Math.trunc(input.limit)))
            : 100;
        if (relPath.length === 0) {
          return json({ unresolved: runtime.store.unresolvedLinks(limit) });
        }
        return json({
          path: relPath,
          outgoing: runtime.store.outgoingLinks(relPath),
          backlinks: runtime.store.backlinksOf(relPath),
        });
      }

      case "obsidian_index": {
        const outcome = scanVault({
          root: runtime.root,
          store: runtime.store,
          settings,
          force: true,
        });
        return json({ ok: true, ...outcome });
      }

      case "obsidian_status": {
        const counts = runtime.store.counts();
        const check = checkVault(runtime.root, 0);
        const lastScan = runtime.store.getMeta("last_scan_ms");
        return json({
          vaultPath: runtime.root,
          isObsidianVault: check.isObsidianVault,
          notes: counts.notes,
          chunks: counts.chunks,
          links: counts.links,
          unresolvedLinks: counts.unresolvedLinks,
          indexBytes: runtime.store.sizeBytes(),
          lastScanAt: lastScan ? new Date(Number(lastScan)).toISOString() : null,
          readOnly: settings.readOnly,
          writeTools: "not available in 0.1.0",
        });
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  } finally {
    try {
      runtime.store.close();
    } catch {
      // already closed
    }
  }
}
