import * as fs from "node:fs";
import { continuationSchema } from "../shared/continuation";
import type { RuntimeSettings } from "../shared/settings";
import {
  CONTINUATION_TARGETS,
  makeContinuation,
  windowText,
  withTruncation,
} from "./continuation";
import { EMPTY_EVENT_STATE, readEnrichmentState } from "./enrichment-state";
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
import { replaceInNote } from "./edit";
import { embedQuery, queryProviderStatus } from "./embed/query";
import { fuzzySearch } from "./enrichment";
import { createObsidianApi } from "./obsidian-api";
import { memoryReport } from "./memory";
import { indexPathFor, resolveVaultRoot } from "./paths";
import { planRootSummary } from "./plan/paths";
import { PLAN_TOOLS, dispatchPlanTool } from "./plan/tools";
import { scanVault } from "./scan";
import { searchIndex } from "./search";
import { BridgeStore } from "./store";
import { isPlanSystemPath, looksLikeVault, readVaultNote, splitList } from "./vault";
import { writeRefusal } from "./write-gate";

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
 * `memory-flash`, project planning belongs to the `plan_*` tools in this server.
 * Writes are append only and confined to the configured roles.
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
  "it to record agent memory (that is memory-flash) or to plan project work (use `plan_*`). " +
  "Reading a plan note or `<project>/_journal.md` that a `plan_*` result points at is part of " +
  "that planning task, not a separate request. " +
  "Planning calls are confined to the configured planning directory (`planRoot`): their paths " +
  "are relative to it, and a plan file is only ever written by a `plan_*` tool — never with " +
  "`obsidian_edit`, `obsidian_write_*`, `shell` or an editor. " +
  "If a result says `[TRUNCATED]`, continue with `obsidian_continue` and its exact `continuation` " +
  "object; never replace it with a file tool.";

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
    "memory — memory-flash does — and project planning is handled by the `plan_*` tools in " +
    "this server. Results are snippets: read the note before quoting it.\n\n" +
    directoryGuide(dirs) +
    "\n\nTo find a document the user names, call `obsidian_search` with words from its title " +
    "(no path needed); read it with `obsidian_read`, and a long one by heading after " +
    "`obsidian_outline`. Call these tools by their exact names — do not probe for names, guess " +
    "a vault path, or fall back to `glob`/`grep`/`read`: the index finds a note by its title, " +
    "aliases, tags and body in one call.\n\n" +
    "A `[TRUNCATED]` result is a normal answer with a built-in next step: copy its `continuation` " +
    "object into `obsidian_continue` unchanged and keep working. Do not switch to `shell`, `read`, " +
    "`glob` or `grep`, and do not guess an offset or a path — a larger continuation costs fewer " +
    "tokens than an abandoned task.\n\n" +
    toolIndex() +
    "\n\nWrite only where the user asked you to: authored documents go to `out`, scratch and " +
    "intermediate notes to `raw`, and appends to incoming material to `inbox`. Never create a " +
    "note outside those directories.\n\n" +
    "Boundaries, which are enforced by code and not by these words: the configured directory " +
    "is the whole of what this plugin may touch — nothing above it, nothing outside it, and no " +
    "symlink around it. Read and edit tools accept only the configured document extensions " +
    "(`.md` by default) and never dot files. Write tools create notes only in `inbox`, `out` and " +
    "`raw`; `obsidian_edit` may change an existing note anywhere below the configured " +
    "directory, and nowhere above it. Never look for another path or a shell command when a " +
    "tool refuses: the refusal is the answer.\n\n" +
    "Planning sits in the same server: the plugin creates `planRoot` (default `Projects`) and " +
    "a folder named after the current Paseo project; `plan_*` reads and edits the whole project " +
    "tree, shared by all workspaces of that project. Each plan file records the calling workspace " +
    "by id in its YAML (`workspace_id`). The project, not the workspace, is the scope: another " +
    "project is out of reach for `plan_*` — do not pass `..` or a sibling project name. " +
    "`obsidian_*` may read plans of other projects when the " +
    "user's task asks for it, but never write a plan file with `obsidian_edit`, " +
    "`obsidian_write_*`, `shell`, `write` or `patch`, and never read `__history`/`_archive` " +
    "directly: `plan_*` is the only write path that snapshots, checks `expected_revision` and " +
    "journals the change, and `plan_history` is the only reader of a snapshot.\n\n" +
    "Planning workflow, in order — every tool below says what it returns, so read one " +
    "description instead of probing the catalogue: (1) `plan_scope` once per session; it names " +
    "the `<project>` folder every other path starts with and says whether writes are enabled. " +
    "(2) `plan_read` the node you are about to change, `plan_search` to find one, or " +
    "`plan_read {}` for the overview. (3) One write tool per change — `plan_create_node` to " +
    "grow the tree, `plan_update_node` for content, `plan_set_status` for lifecycle, " +
    "`plan_link`/`plan_incident`/`plan_goal`/`plan_growth` for relations and progress, " +
    "`plan_move_node`/`plan_archive_node` to restructure, `plan_restore` to bring a snapshot " +
    "back — passing the `revision` you read as `expected_revision`. (4) `plan_validate " +
    "{ project }` after a batch of changes. Planning writes are serialized per plan tree, one " +
    "writer at a time; if a write answers that another agent is writing, it wrote nothing — wait " +
    "ten seconds, re-read the node and repeat it. `plan_history` is the change log of one node; " +
    "`<project>/_journal.md` is the change log of the project and is read like a note.\n\n" +
    "Four skills document these workflows in more detail; load the one that matches the task: " +
    "`obsidian-bridge` (read → cite → write), `planning-create` (grow a tree), " +
    "`planning-execute` (carry a plan through the work), `planning-review` (plan against fact, " +
    "history and growth)."
  );
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: { type?: string; description?: string };
  enum?: string[];
  default?: unknown;
  /** Nested object schema (used by the `obsidian_continue` argument). */
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
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

/**
 * Every tool name with its one-line title, appended to the `initialize`
 * instructions.
 *
 * A client may show only a truncated tool catalogue — measured on Paseo 0.15.4
 * with an OpenCode agent: `obsidian-bridge (13 tools, 2 shown)` — and an agent
 * then spends turns guessing names (`search`, `obsidian_find_notes`, …) instead
 * of asking the vault a question, exactly the cost this plugin exists to avoid.
 * The instructions block arrives whole, so the complete index belongs here.
 */
function toolIndex(): string {
  const lines = MCP_TOOLS.map((tool) => `- \`${tool.name}\` — ${tool.title}`);
  return [`Tools in this server (${MCP_TOOLS.length}):`, ...lines].join("\n");
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
      "matches, wikilink proximity, local semantics and (when Obsidian is running with its Local " +
      "REST API) Obsidian's own fuzzy search. Returns ranked snippets with the note path, " +
      "heading and directory role, so the answer can be cited.",
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
        offset: {
          type: "number",
          description: "Skip the first N ranked hits; supplied by a [TRUNCATED] result.",
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
      "including its frontmatter, tags and link counts. Only files with an allowed extension " +
      "(`.md` by default) are readable; dot files and configuration are refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the configured directory." },
        heading: { type: "string", description: "Optional heading text; reads only that section." },
        char_offset: {
          type: "number",
          description: "Skip the first N characters of the body; supplied by a [TRUNCATED] result.",
        },
        max_chars: {
          type: "number",
          description: "Return at most this many characters; a larger window is a continuation.",
        },
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
        offset: {
          type: "number",
          description: "Skip the first N notes; supplied by a [TRUNCATED] result.",
        },
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
    name: "obsidian_edit",
    title: "Edit an existing Obsidian note",
    description:
      `${CONTRACT_SENTENCE} Replaces one exact fragment in an existing note addressed by its path ` +
      "below the configured directory — the tool that reaches notes outside the inbox/out/raw " +
      "roles. The fragment must occur exactly once (include surrounding context to make it " +
      "unique); everything else in the note is kept byte for byte. It never creates a note and it " +
      "never reaches a path above the configured directory, so a refusal is final — do not retry " +
      "through `shell`, `write` or another tool. A refusal lists the closest text with line " +
      "numbers, and `ignore_whitespace: true` matches a re-wrapped fragment.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the existing note to edit." },
        old_text: {
          type: "string",
          description:
            "Exact text to replace, whitespace and line breaks included. Must occur exactly once.",
        },
        new_text: {
          type: "string",
          description: "Replacement text; an empty string removes the fragment.",
        },
        ignore_whitespace: {
          type: "boolean",
          description:
            "Compare with every whitespace run collapsed to one space, for a fragment that was " +
            "re-wrapped or re-indented. Still requires exactly one match. Default false.",
        },
      },
      required: ["path", "old_text", "new_text"],
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
      "Reports the configured directory, the role map, index counts, freshness, whether " +
      "writes are enabled and whether optional Obsidian enrichment is reachable. Use it to " +
      "check that the bridge is connected before relying on it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "obsidian_continue",
    title: "Continue a truncated result",
    description:
      `${CONTRACT_SENTENCE} Re-runs the tool named in a \`[TRUNCATED]\` result with exactly ` +
      "the arguments printed there. Copy the `continuation` object verbatim; the plugin " +
      "rechecks its boundaries before answering.",
    inputSchema: {
      type: "object",
      properties: {
        continuation: {
          type: "object",
          description: "The `continuation` object from the truncated result, unchanged.",
          properties: {
            call: { type: "object", description: "{tool, arguments} chosen by the plugin." },
            reason: { type: "string", description: "Why the previous result was cut." },
            omitted: { type: "number", description: "How many items or characters were hidden." },
            hint: { type: "string", description: "One-line explanation for the agent." },
          },
          required: ["call", "reason", "omitted", "hint"],
        },
      },
      required: ["continuation"],
    },
  },
  // Planning tools (0.11.11) share this server and settings; their boundary is
  // the `planRoot` directory inside the vault, not the whole vault.
  ...PLAN_TOOLS,
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
  const body = typeof input.body === "string" ? input.body : "";
  const refusal = writeRefusal(settings, body.length);
  if (refusal) return fail(refusal);
  if (body.trim().length === 0) return fail("body is required.");
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

  // Planning tools own a narrower boundary (`planRoot`) and answer before the
  // vault index is opened: `plan_scope` must report a missing or empty root
  // without creating a database or a directory.
  if (name.startsWith("plan_")) {
    const planned = await dispatchPlanTool(name, input, settings);
    if (planned) return planned;
  }

  // A continuation re-runs one named tool with the arguments the plugin itself
  // produced. It never opens the index here: the target tool does that.
  if (name === "obsidian_continue") {
    const parsed = continuationSchema.safeParse(input.continuation);
    if (!parsed.success) {
      return fail(
        "continuation is required: copy the `continuation` object from a [TRUNCATED] result unchanged.",
      );
    }
    const target = parsed.data.call.tool;
    if (!CONTINUATION_TARGETS.has(target)) {
      return fail(
        `'${target}' is not a continuation target. Allowed: ${[...CONTINUATION_TARGETS].join(", ")}.`,
      );
    }
    return dispatchTool(target, parsed.data.call.arguments, settings);
  }

  // Pure configuration query: answered without opening (and creating) an index.
  if (name === "obsidian_directories") {
    const dirs = resolveRoleDirs(settings);
    return json({
      root: resolveVaultRoot(settings.vaultPath),
      directories: dirs,
      roles: describeRoleDirs(dirs),
      allowedExtensions: settings.allowedExtensions,
      writesEnabled: !settings.readOnly,
      boundary:
        "This directory is the whole boundary: nothing above it, nothing outside it, no symlink " +
        "around it. New notes are created only in inbox/out/raw; obsidian_edit may rewrite an " +
        "existing note anywhere below it.",
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
        const offset =
          typeof input.offset === "number" && Number.isFinite(input.offset)
            ? Math.max(0, Math.trunc(input.offset))
            : 0;
        const scope = parseScope(input.scope);
        const semanticWanted =
          input.semantic === undefined ? settings.semanticSearch : input.semantic === true;
        const queryEmbedding =
          semanticWanted && query.length > 0 ? await embedQuery(settings, query) : null;
        const fuzzy = await fuzzySearch(settings, query, 20);
        const result = searchIndex(runtime.store, {
          query,
          limit,
          folder,
          tags,
          scope,
          offset,
          budgetChars: budget,
          snippetChars: settings.snippetChars,
          dirs: runtime.dirs,
          semantic: queryEmbedding?.vector
            ? { vector: queryEmbedding.vector, modelId: queryEmbedding.modelId }
            : null,
          fuzzy: fuzzy.hits,
          enrichment: { enabled: fuzzy.enabled, error: fuzzy.error },
        });
        const text = result.text.length > 0 ? result.text : (result.note ?? "No results.");
        const remaining = Math.max(0, (result.total ?? 0) - offset - result.hits.length);
        const omitted = result.omitted ?? 0;
        const nextArgs: Record<string, unknown> = { query };
        if (input.limit !== undefined) nextArgs.limit = limit;
        if (folder.length > 0) nextArgs.folder = folder;
        if (tags.length > 0) nextArgs.tags = input.tags;
        if (scope !== "all") nextArgs.scope = scope;
        if (typeof input.budget_chars === "number") nextArgs.budget_chars = budget;
        if (offset > 0 || omitted > 0) nextArgs.offset = offset + result.hits.length;
        const continuation =
          omitted > 0
            ? makeContinuation(
                { tool: "obsidian_search", arguments: nextArgs },
                remaining > 0 ? "max_results" : "char_budget",
                omitted,
                `${omitted} search hits were not shown; ask for the next page to keep reading.`,
              )
            : null;
        return withTruncation(
          {
            query: result.query,
            hits: result.hits,
            signals: result.signals,
            tookMs: result.tookMs,
            note: result.note,
            directories: runtime.dirs,
            enrichment: result.enrichment,
            semantic: {
              requested: semanticWanted,
              used: result.signals.includes("semantic"),
              model: settings.embeddingModel,
              error: queryEmbedding?.error ?? null,
            },
          },
          continuation,
          text,
        );
      }

      case "obsidian_read": {
        const relPath = typeof input.path === "string" ? input.path.trim() : "";
        if (relPath.length === 0) return fail("path is required.");
        if (isPlanSystemPath(relPath)) {
          return fail(
            `'${relPath}' is planning history (__history) or the archive (_archive). ` +
              "Read it with the planning tools (`plan_history`); the document tools hide it " +
              "so snapshots and archived nodes do not mix with the live tree.",
          );
        }
        const heading = typeof input.heading === "string" ? input.heading : undefined;
        const note = readVaultNote(runtime.root, relPath, {
          heading,
          allowedExtensions: settings.allowedExtensions,
        });
        if ("error" in note) return fail(note.error);
        const meta = runtime.store.noteMeta(relPath);
        const charOffset =
          typeof input.char_offset === "number" && Number.isFinite(input.char_offset)
            ? Math.max(0, Math.trunc(input.char_offset))
            : 0;
        const maxChars =
          typeof input.max_chars === "number" && Number.isFinite(input.max_chars)
            ? Math.max(1, Math.trunc(input.max_chars))
            : null;
        const window = windowText(note.text, charOffset, maxChars);
        const nextArgs: Record<string, unknown> = { path: relPath };
        if (heading !== undefined) nextArgs.heading = heading;
        if (maxChars !== null) nextArgs.max_chars = maxChars;
        nextArgs.char_offset = charOffset + window.text.length;
        const continuation =
          window.omittedAfter > 0
            ? makeContinuation(
                { tool: "obsidian_read", arguments: nextArgs },
                "note_window",
                window.omittedAfter,
                `${window.omittedAfter} characters of the note were not shown; read the next window.`,
              )
            : null;
        // The body is part of the structured result too: an MCP client that
        // renders only `structuredContent` (OpenCode does) would otherwise
        // see the metadata and no text at all.
        return withTruncation(
          {
            content: window.text,
            path: relPath,
            role: roleOfPath(relPath, runtime.dirs),
            title: note.parsed.title,
            heading: heading ?? null,
            tags: note.parsed.tags,
            frontmatter: note.parsed.frontmatter,
            headings: note.parsed.headings,
            backlinks: runtime.store.backlinksOf(relPath).length,
            indexed: meta !== null,
            noteTruncated: note.truncated,
          },
          continuation,
          window.text,
        );
      }

      case "obsidian_edit": {
        if (settings.readOnly) {
          return fail(
            "Writes are disabled (readOnly is on). Ask the user to turn them off in " +
              "Settings → Plugins → Obsidian Bridge.",
          );
        }
        const relPath = typeof input.path === "string" ? input.path.trim() : "";
        if (relPath.length === 0) return fail("path is required.");
        if (isPlanSystemPath(relPath)) {
          return fail(
            `'${relPath}' is planning history (__history) or the archive (_archive): snapshots ` +
              "are immutable. Change the live node instead; the next revision writes a new " +
              "snapshot.",
          );
        }
        const ignoreWhitespace = input.ignore_whitespace === true;
        const outcome = replaceInNote({
          root: runtime.root,
          relPath,
          oldText: typeof input.old_text === "string" ? input.old_text : "",
          newText: typeof input.new_text === "string" ? input.new_text : "",
          maxWriteChars: settings.maxWriteChars,
          allowedExtensions: settings.allowedExtensions,
          ignoreWhitespace,
        });
        if ("error" in outcome) {
          // The structured part carries the near misses, so an agent that reads
          // only `structuredContent` still receives them.
          return {
            text: outcome.error,
            isError: true,
            structuredContent: {
              ok: false,
              path: relPath,
              error: outcome.error,
              occurrences: outcome.occurrences ?? 0,
              suggestions: outcome.suggestions ?? [],
            },
          };
        }
        return json({
          path: outcome.path,
          role: roleOfPath(outcome.path, runtime.dirs),
          replaced: true,
          occurrences: 1,
          charsBefore: outcome.charsBefore,
          charsAfter: outcome.charsAfter,
          bytesBefore: outcome.bytesBefore,
          bytesAfter: outcome.bytesAfter,
          normalizedLineEndings: outcome.normalizedLineEndings,
          ignoreWhitespace: outcome.ignoreWhitespace,
          note: "Search reflects the change once the plugin's indexer sees the file.",
        });
      }

      case "obsidian_outline": {
        const relPath = typeof input.path === "string" ? input.path.trim() : "";
        if (relPath.length === 0) return fail("path is required.");
        if (isPlanSystemPath(relPath)) {
          return fail(
            `'${relPath}' is planning history (__history) or the archive (_archive); the ` +
              "document tools do not outline it. Use the planning tools instead.",
          );
        }
        const note = readVaultNote(runtime.root, relPath, {
          maxBytes: 4 * 1024 * 1024,
          allowedExtensions: settings.allowedExtensions,
        });
        if ("error" in note) return fail(note.error);
        // Obsidian's metadata cache is authoritative when the app answers;
        // the parsed index remains the fallback.
        const obsidianApi = createObsidianApi(settings);
        const authority = obsidianApi ? await obsidianApi.noteLinks(relPath) : null;
        const indexedLinks = runtime.store.outgoingLinks(relPath);
        // A note written a moment ago may not be in the index yet (the watcher
        // flushes on a debounce). Its own parsed body is still the authority for
        // what it links to, so an empty index row must not answer `links: []`.
        const links =
          indexedLinks.length > 0
            ? indexedLinks
            : note.parsed.links.map((link) => ({
                raw_target: link.rawTarget,
                target_path: null,
                alias: link.alias,
                anchor: link.anchor,
                kind: link.kind,
              }));
        return json({
          path: relPath,
          role: roleOfPath(relPath, runtime.dirs),
          title: note.parsed.title,
          headings: note.parsed.headings,
          frontmatterKeys: Object.keys(note.parsed.frontmatter),
          tags: note.parsed.tags,
          /** Dataview inline fields (`key:: value`) from the note body (0.10.11). */
          inlineFields: note.parsed.inlineFields,
          links,
          backlinks: authority?.links?.backlinks ?? runtime.store.backlinksOf(relPath),
          unresolvedLinks: authority?.links?.unresolvedLinks ?? null,
          linkSource: authority?.links ? "obsidian" : "index",
          enrichmentError: authority?.error ?? null,
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
        const offset =
          typeof input.offset === "number" && Number.isFinite(input.offset)
            ? Math.max(0, Math.trunc(input.offset))
            : 0;
        const wanted = offset + limit + 1;
        const available = runtime.store
          .notesUnder(folder, scope === "all" ? wanted : wanted * 4)
          .filter((row) => scope === "all" || roleOfPath(row.path, runtime.dirs) === scope);
        const rows = available.slice(offset, offset + limit);
        const omitted = Math.max(0, available.length - offset - rows.length);
        const nextArgs: Record<string, unknown> = { limit, offset: offset + rows.length };
        if (input.folder !== undefined) nextArgs.folder = input.folder;
        if (scope !== "all") nextArgs.scope = scope;
        const continuation =
          omitted > 0
            ? makeContinuation(
                { tool: "obsidian_list", arguments: nextArgs },
                "list_window",
                omitted,
                `${omitted} notes were not shown; ask for the next page to keep listing.`,
              )
            : null;
        return withTruncation(
          {
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
          },
          continuation,
        );
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
        const obsidianApi = createObsidianApi(settings);
        const probe = obsidianApi ? await obsidianApi.probe() : null;
        // Event streams belong to the plugin process, not to this spawned
        // server, so the live flags come from the record it publishes.
        const events = obsidianApi && probe?.ok ? readEnrichmentState() : EMPTY_EVENT_STATE;
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
          plan: planRootSummary(settings),
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
          enrichment: {
            enabled: obsidianApi !== null,
            url: settings.obsidianApiUrl,
            reachable: probe?.ok ?? false,
            authenticated: probe?.authenticated ?? false,
            version: probe?.version ?? null,
            events: events.events,
            lastEventAt: events.lastEventAt,
            error: probe?.error ?? null,
          },
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
