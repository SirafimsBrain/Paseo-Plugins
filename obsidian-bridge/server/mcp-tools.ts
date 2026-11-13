import * as fs from "node:fs";
import type { RuntimeSettings } from "../shared/settings";
import {
  appendToNote,
  describeRoleDirs,
  normalizeRoleDir,
  resolveRoleDirs,
  roleOfPath,
  type Role,
  type RoleDirs,
  type WritableRole,
} from "./dirs";
import { embedQuery, queryProviderStatus } from "./embed/query";
import { memoryReport } from "./memory";
import { indexPathFor, resolveVaultRoot } from "./paths";
import { scanVault } from "./scan";
import { searchIndex } from "./search";
import { BridgeStore } from "./store";
import { looksLikeVault, readVaultNote, splitList } from "./vault";

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
 * agent consult the vault on its own. An agent's own memory belongs to
 * `memory-flash`, project planning belongs to `luck-planner`. Writes are append
 * only and confined to the configured roles.
 *
 * ## Directory roles
 *
 * `vaultPath` is the only directory the plugin may touch at all. Inside it,
 * `inbox` (incoming sources), `out` (authored documents) and `raw` (scratch)
 * tell an agent where to work; anything above `vaultPath` cannot be addressed,
 * and reads outside the roles are limited to the workspace directory itself.
 */

export const CONTRACT_SENTENCE =
  "Reference tool for the user's Obsidian knowledge base: use it only when the user " +
  "explicitly asks about their Obsidian notes, documents, plans or research. Do not use " +
  "it to record agent memory (that is memory-flash) or to plan project work (luck-planner).";

/** Role descriptions shared by the MCP instructions and the agent tools. */
export function directoryGuide(dirs: RoleDirs): string {
  const lines = describeRoleDirs(dirs).map((entry) => `- ${entry.role}: ${entry.path} — ${entry.use}`);
  return [
    "Directories (all inside the configured Obsidian directory; nothing above it is reachable):",
    ...lines,
  ].join("\n");
}

export function mcpInstructions(dirs: RoleDirs): string {
  return (
    "Obsidian Bridge gives access to the user's Obsidian knowledge base: notes, plans, " +
    "recommendations and research. Use it only when the user asks about those documents, and " +
    "cite the note path (and heading) you took the answer from. It does not store agent " +
    "memory — memory-flash does — and it does not plan work — luck-planner does. Results are " +
    "snippets: read the note before quoting it.\n\n" +
    directoryGuide(dirs) +
    "\n\nWrite only where the user asked you to: authored documents go to `out`, scratch and " +
    "intermediate notes to `raw`, and appends to incoming material to `inbox`. Never create a " +
    "note outside those directories."
  );
}

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
    name: "obsidian_directories",
    title: "Vault directories",
    description:
      `${CONTRACT_SENTENCE} Returns the configured directory map — workspace, inbox (incoming ` +
      "sources), out (authored documents) and raw (scratch) — so you write in the right place.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "obsidian_search",
    title: "Search the Obsidian vault",
    description:
      `${CONTRACT_SENTENCE} Hybrid search: full-text over heading chunks fused with title/alias ` +
      "matches and wikilink proximity. Returns ranked snippets with the note path, heading and " +
      "directory role, so the answer can be cited.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for. Empty lists the most recent notes." },
        limit: { type: "number", description: "Maximum hits, 1–50 (default from plugin settings)." },
        folder: { type: "string", description: "Restrict to a directory, relative to the configured root." },
        tags: { type: "string", description: "Comma-separated tags every hit must carry." },
        scope: {
          type: "string",
          enum: ["all", "workspace", "inbox", "out", "raw"],
          description: "Restrict to one directory role. Default: all.",
        },
        budget_chars: {
          type: "number",
          description: "Character budget for the packed answer text (default from settings).",
        },
        semantic: {
          type: "boolean",
          description:
            "Force the local semantic signal on/off for this query (default from plugin settings).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "obsidian_read",
    title: "Read an Obsidian note",
    description:
      `${CONTRACT_SENTENCE} Reads a note (or one heading subtree) from the configured directory, ` +
      "including its frontmatter, tags and link counts.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the configured directory." },
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
        path: { type: "string", description: "Path relative to the configured directory." },
      },
      required: ["path"],
    },
  },
  {
    name: "obsidian_list",
    title: "List Obsidian notes",
    description:
      `${CONTRACT_SENTENCE} Lists notes under a folder with title, size, modification time and role.`,
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder relative to the configured root; empty lists everything." },
        scope: {
          type: "string",
          enum: ["all", "workspace", "inbox", "out", "raw"],
          description: "Restrict to one directory role. Default: all.",
        },
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
        path: { type: "string", description: "Path relative to the configured directory. Empty = unresolved links." },
        limit: { type: "number", description: "Maximum entries, 1–500 (default 100)." },
      },
    },
  },
  {
    name: "obsidian_write_document",
    title: "Write an authored document",
    description:
      `${CONTRACT_SENTENCE} Appends a section to a document in the configured \`out\` directory, ` +
      "creating it when it does not exist. Use for guides, instructions and recommendations the " +
      "user asked for; pass the document name the user gave, or a descriptive one.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name inside the out directory, with or without .md." },
        title: { type: "string", description: "Section title; defaults to the file name." },
        body: { type: "string", description: "Markdown to append." },
        create: { type: "boolean", description: "Create the document when missing (default true)." },
      },
      required: ["name", "body"],
    },
  },
  {
    name: "obsidian_write_scratch",
    title: "Write a scratch note",
    description:
      `${CONTRACT_SENTENCE} Appends to a note in the configured \`raw\` directory: clarifications, ` +
      "bugfix alternatives, intermediate material that will lose value once the work lands. Use " +
      "when you need somewhere to think on paper.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name inside the raw directory, with or without .md." },
        title: { type: "string", description: "Section title; defaults to the file name." },
        body: { type: "string", description: "Markdown to append." },
        create: { type: "boolean", description: "Create the note when missing (default true)." },
      },
      required: ["name", "body"],
    },
  },
  {
    name: "obsidian_append_inbox",
    title: "Append to the inbox",
    description:
      `${CONTRACT_SENTENCE} Appends to an explicitly named note in the configured \`inbox\` ` +
      "directory (incoming sources, references). Only when the user asked to add material there — " +
      "the inbox is the user's, not a place to file your own notes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Note to append to, inside the inbox directory, with or without .md." },
        title: { type: "string", description: "Section title; defaults to the file name." },
        body: { type: "string", description: "Markdown to append." },
        create: { type: "boolean", description: "Create the note when missing (default true)." },
      },
      required: ["name", "body"],
    },
  },
  {
    name: "obsidian_index",
    title: "Reindex the vault",
    description:
      "Rebuilds the local index from the configured directory. Use after notes changed outside " +
      "the watcher's reach, or when search results look stale.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "obsidian_diagnose",
    title: "Measure retrieval quality",
    description:
      "Measures recall@k of lexical versus hybrid retrieval over cases you supply " +
      "(`{query, expected_paths}`), and reports vector coverage and the signals in use. Use it " +
      "to check whether semantic search actually helps on this vault.",
    inputSchema: {
      type: "object",
      properties: {
        cases: {
          type: "array",
          description: "Cases: [{query, expected_paths: [note paths that must be in the top k]}].",
          items: { type: "object", description: "{query, expected_paths}" },
        },
        k: { type: "number", description: "Cut-off for recall, 1–20 (default 5)." },
        semantic: {
          type: "boolean",
          description: "Force the semantic signal on/off; default from settings.",
        },
      },
    },
  },
  {
    name: "obsidian_status",
    title: "Vault index status",
    description:
      "Reports the configured directory, the role map, index counts, freshness and whether " +
      "writes are enabled. Use it to check that the bridge is connected before relying on it.",
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
  dirs: RoleDirs;
}

/** Opens the vault and its index, or explains why it cannot. */
export function openRuntime(
  settings: RuntimeSettings,
): { runtime: ToolRuntime } | { error: string } {
  const root = resolveVaultRoot(settings.vaultPath);
  if (root.length === 0) {
    return {
      error:
        "The Obsidian directory is not configured. Ask the user to open Settings → Plugins → " +
        "Obsidian Bridge and set the directory available to Paseo; do not guess it.",
    };
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return { error: `Obsidian directory '${root}' is not a readable directory.` };
  }
  try {
    const store = new BridgeStore(indexPathFor(root), { stemming: settings.ftsStemming });
    return { runtime: { root, store, dirs: resolveRoleDirs(settings) } };
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

/**
 * `obsidian_diagnose`: recall@k for lexical versus hybrid retrieval.
 *
 * There is no universal ground truth for a personal vault, so the caller
 * supplies cases. Without cases the tool reports coverage and how to measure,
 * instead of inventing a number.
 */
async function diagnose(
  store: BridgeStore,
  dirs: RoleDirs,
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const k =
    typeof input.k === "number" && Number.isFinite(input.k)
      ? Math.max(1, Math.min(20, Math.trunc(input.k)))
      : 5;
  const semanticWanted =
    input.semantic === undefined ? settings.semanticSearch : input.semantic === true;
  const vectors = store.embeddingStats(settings.embeddingModel);
  const semanticUsable = semanticWanted && vectors.embedded > 0;

  const cases = (Array.isArray(input.cases) ? input.cases : [])
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const query = typeof record.query === "string" ? record.query.trim() : "";
      const expected = Array.isArray(record.expected_paths)
        ? record.expected_paths.filter((path): path is string => typeof path === "string")
        : [];
      return { query, expected };
    })
    .filter((item) => item.query.length > 0);

  if (cases.length === 0) {
    return json({
      k,
      cases: 0,
      chunks: vectors.chunks,
      embedded: vectors.embedded,
      model: settings.embeddingModel,
      semantic: semanticUsable,
      note: "Pass cases: [{query, expected_paths}] to measure recall@k on this vault.",
    });
  }

  const results: Array<{
    query: string;
    lexical: string[];
    hybrid: string[];
    lexicalRecall: number | null;
    hybridRecall: number | null;
  }> = [];
  let semanticError: string | null = null;

  for (const item of cases) {
    const lexical = searchIndex(store, { query: item.query, limit: k, dirs });
    let hybrid = lexical;
    if (semanticUsable) {
      const embedding = await embedQuery(settings, item.query);
      if (embedding.error) semanticError = embedding.error;
      if (embedding.vector) {
        hybrid = searchIndex(store, {
          query: item.query,
          limit: k,
          dirs,
          semantic: { vector: embedding.vector, modelId: embedding.modelId },
        });
      }
    }
    const recallOf = (paths: string[]): number | null =>
      item.expected.length === 0
        ? null
        : item.expected.filter((path) => paths.includes(path)).length / item.expected.length;
    const lexicalPaths = lexical.hits.map((hit) => hit.path);
    const hybridPaths = hybrid.hits.map((hit) => hit.path);
    results.push({
      query: item.query,
      lexical: lexicalPaths,
      hybrid: hybridPaths,
      lexicalRecall: recallOf(lexicalPaths),
      hybridRecall: recallOf(hybridPaths),
    });
  }

  const mean = (key: "lexicalRecall" | "hybridRecall"): number | null => {
    const values = results.map((row) => row[key]).filter((value): value is number => value !== null);
    return values.length === 0
      ? null
      : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
  };

  return json({
    k,
    cases: results.length,
    model: settings.embeddingModel,
    semantic: semanticUsable,
    semanticError,
    chunks: vectors.chunks,
    embedded: vectors.embedded,
    meanLexicalRecall: mean("lexicalRecall"),
    meanHybridRecall: mean("hybridRecall"),
    results,
  });
}

/**
 * Folder argument of a read tool, normalized so it cannot address anything
 * above the configured root. `null` = refused, `""` = the whole root.
 */
function normalizeFolder(value: unknown): string | null {
  const folder = typeof value === "string" ? value.trim() : "";
  return folder.length === 0 ? "" : normalizeRoleDir(folder);
}

function parseScope(value: unknown): Role | "all" {
  return value === "workspace" || value === "inbox" || value === "out" || value === "raw"
    ? value
    : "all";
}

function write(
  settings: RuntimeSettings,
  runtime: ToolRuntime,
  role: WritableRole,
  input: Record<string, unknown>,
): ToolOutcome {
  if (settings.readOnly) {
    return fail(
      "Writes are disabled (readOnly is on). Ask the user to turn them off in " +
        "Settings → Plugins → Obsidian Bridge.",
    );
  }
  const body = typeof input.body === "string" ? input.body : "";
  if (body.trim().length === 0) return fail("body is required.");
  if (body.length > settings.maxWriteChars) {
    return fail(
      `The document body is ${body.length} characters; the configured limit is ` +
        `${settings.maxWriteChars}. Split it into sections.`,
    );
  }
  // A write always names its note: the inbox is the user's, so it is never a
  // default dumping ground.
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) {
    return fail(`name is required: pass the note to append to inside the ${role} directory.`);
  }
  const create = input.create === undefined ? true : input.create === true;

  const outcome = appendToNote({
    root: runtime.root,
    dirs: runtime.dirs,
    role,
    name,
    title: typeof input.title === "string" ? input.title : undefined,
    body,
    create,
  });
  if ("error" in outcome) return fail(outcome.error);
  if (outcome.duplicate) {
    return json({
      path: outcome.path,
      role,
      created: false,
      duplicate: true,
      note: "This exact text is already in the document; nothing was written.",
    });
  }
  return json({
    path: outcome.path,
    role,
    created: outcome.created,
    duplicate: false,
    bytes: outcome.bytes,
  });
}

export async function dispatchTool(
  name: string,
  args: unknown,
  settings: RuntimeSettings,
): Promise<ToolOutcome> {
  const input = (args ?? {}) as Record<string, unknown>;

  // Pure configuration query: answered without opening (and creating) an index.
  if (name === "obsidian_directories") {
    const dirs = resolveRoleDirs(settings);
    return json({
      root: resolveVaultRoot(settings.vaultPath),
      directories: dirs,
      roles: describeRoleDirs(dirs),
      writesEnabled: !settings.readOnly,
    });
  }

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
        const folder = normalizeFolder(input.folder);
        if (folder === null) return fail(`'${String(input.folder)}' is not a folder inside the configured directory.`);
        const tags =
          typeof input.tags === "string" && input.tags.trim().length > 0
            ? splitList(input.tags)
            : [];
        const budget =
          typeof input.budget_chars === "number" && Number.isFinite(input.budget_chars)
            ? Math.max(500, Math.min(60000, Math.trunc(input.budget_chars)))
            : settings.searchBudgetChars;
        const semanticWanted =
          input.semantic === undefined ? settings.semanticSearch : input.semantic === true;
        const queryEmbedding =
          semanticWanted && query.length > 0 ? await embedQuery(settings, query) : null;
        const result = searchIndex(runtime.store, {
          query,
          limit,
          folder,
          tags,
          scope: parseScope(input.scope),
          budgetChars: budget,
          snippetChars: settings.snippetChars,
          dirs: runtime.dirs,
          semantic: queryEmbedding?.vector
            ? { vector: queryEmbedding.vector, modelId: queryEmbedding.modelId }
            : null,
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
            directories: runtime.dirs,
            semantic: {
              requested: semanticWanted,
              used: result.signals.includes("semantic"),
              model: settings.embeddingModel,
              error: queryEmbedding?.error ?? null,
            },
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
            role: roleOfPath(relPath, runtime.dirs),
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
          role: roleOfPath(relPath, runtime.dirs),
          title: note.parsed.title,
          headings: note.parsed.headings,
          frontmatterKeys: Object.keys(note.parsed.frontmatter),
          tags: note.parsed.tags,
          links: runtime.store.outgoingLinks(relPath),
          backlinks: runtime.store.backlinksOf(relPath),
        });
      }

      case "obsidian_list": {
        const folder = normalizeFolder(input.folder);
        if (folder === null) return fail(`'${String(input.folder)}' is not a folder inside the configured directory.`);
        const scope = parseScope(input.scope);
        const limit =
          typeof input.limit === "number" && Number.isFinite(input.limit)
            ? Math.max(1, Math.min(500, Math.trunc(input.limit)))
            : 50;
        const rows = runtime.store
          .notesUnder(folder, scope === "all" ? limit : limit * 4)
          .filter((row) => scope === "all" || roleOfPath(row.path, runtime.dirs) === scope)
          .slice(0, limit);
        return json({
          folder: folder || "(everything)",
          scope,
          count: rows.length,
          notes: rows.map((row) => ({
            path: row.path,
            role: roleOfPath(row.path, runtime.dirs),
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
          role: roleOfPath(relPath, runtime.dirs),
          outgoing: runtime.store.outgoingLinks(relPath),
          backlinks: runtime.store.backlinksOf(relPath),
        });
      }

      case "obsidian_write_document":
        return write(settings, runtime, "out", input);

      case "obsidian_write_scratch":
        return write(settings, runtime, "raw", input);

      case "obsidian_append_inbox":
        return write(settings, runtime, "inbox", input);

      case "obsidian_index": {
        const outcome = scanVault({
          root: runtime.root,
          store: runtime.store,
          settings,
          force: true,
        });
        return json({ ok: true, ...outcome });
      }

      case "obsidian_diagnose": {
        return await diagnose(runtime.store, runtime.dirs, settings, input);
      }

      case "obsidian_status": {
        const counts = runtime.store.counts();
        const lastScan = runtime.store.getMeta("last_scan_ms");
        const byRole = runtime.store.listNoteFiles().reduce<Record<string, number>>((acc, row) => {
          const role = roleOfPath(row.path, runtime.dirs);
          acc[role] = (acc[role] ?? 0) + 1;
          return acc;
        }, {});
        const vectors = runtime.store.embeddingStats(settings.embeddingModel);
        const provider = queryProviderStatus();
        const memory = memoryReport(process.memoryUsage().rss);
        const semanticState = !settings.semanticSearch
          ? "idle"
          : vectors.chunks > 0 && vectors.embedded >= vectors.chunks
            ? "done"
            : vectors.embedded > 0
              ? "running"
              : "idle";
        return json({
          vaultPath: runtime.root,
          directories: runtime.dirs,
          notesByRole: byRole,
          isObsidianVault: looksLikeVault(runtime.root),
          notes: counts.notes,
          chunks: counts.chunks,
          links: counts.links,
          unresolvedLinks: counts.unresolvedLinks,
          indexBytes: runtime.store.sizeBytes(),
          lastScanAt: lastScan ? new Date(Number(lastScan)).toISOString() : null,
          readOnly: settings.readOnly,
          writesEnabled: !settings.readOnly,
          embedding: {
            enabled: settings.semanticSearch,
            model: settings.embeddingModel,
            dtype: settings.embeddingDtype,
            state: provider.error !== null && settings.semanticSearch ? "error" : semanticState,
            chunks: vectors.chunks,
            embedded: vectors.embedded,
            stale: vectors.stale,
            done: vectors.embedded,
            total: vectors.chunks,
            modelLoaded: provider.loaded,
            rssMb: provider.rssMb,
            error: provider.error,
            note:
              vectors.chunks > 0 && vectors.embedded < vectors.chunks
                ? "The plugin host is still embedding the vault; lexical search works meanwhile."
                : null,
          },
          memory,
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
