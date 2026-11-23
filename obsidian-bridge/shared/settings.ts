import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";
import { DEFAULT_AGENT_INSTRUCTIONS } from "./agent-instructions";

/**
 * Default exclude list: the vault's own configuration directory, its trash,
 * VCS metadata and the index directory of Smart Connections-style plugins.
 * Comma-separated globs, matching vault-relative paths.
 */
export const DEFAULT_EXCLUDES = ".obsidian/**, .trash/**, .git/**, .smart-env/**";

/**
 * Plugin settings (host-scoped, edited in Paseo Settings → Plugins →
 * Obsidian Bridge).
 *
 * The spawned MCP server cannot use the plugin API, so the same values are
 * mirrored by the plugin into `$PASEO_HOME/plugins/obsidian-bridge/settings.json`
 * and read from there by every agent-side process
 * (`server/settings-file.ts`).
 */
export const obsidianBridgeSettings = defineSettings({
  id: "obsidian-bridge",
  scope: "host",
  // 4: optional Obsidian Local REST API enrichment (0.4.0). 3 added the
  // semantic settings; 2 added directory roles and maxWriteChars. Adding
  // `registerOpencodeMcp` (0.5.5) kept the version: a stored document without
  // it validates to the schema default, while bumping the version turned every
  // existing document invalid.
  version: 4,
  /**
   * Convert a document written by an older install to the current schema.
   *
   * Every bump so far only added keys (2 → 3 the semantic settings, 3 → 4 the
   * enrichment settings) and the schema fills a missing key from its default,
   * so the stored values need no rewriting — only the version envelope does.
   * The host requires this hook all the same: without it a document from an
   * older install is reported as `Settings version N requires a migration` and
   * the settings screen refuses to open (measured on a 0.4.1 → 0.8.8 update,
   * stored version 2). The host persists the migrated document, so the repair
   * is permanent.
   */
  migrate(values: unknown, _fromVersion: number): unknown {
    if (typeof values !== "object" || values === null || Array.isArray(values)) return {};
    return { ...(values as Record<string, unknown>) };
  },
  schema: z.object({
    /**
     * Absolute path of the local Obsidian vault. Empty means "not
     * configured": nothing is indexed, no tools answer with content, and the
     * panel/settings screen asks for the path. This is the single value the
     * plugin cannot guess.
     */
    vaultPath: z.string().trim().max(1024).default(""),
    /**
     * Vault-relative directory for incoming material: converted documents,
     * reference books and other primary sources the agents read ("Inbox").
     * Empty = not configured; the role then does not exist for the tools.
     */
    inboxDir: z.string().trim().max(512).default("Inbox"),
    /**
     * Vault-relative directory for authored documents produced on request
     * ("Documentation"). Agents may append and create notes here.
     */
    outDir: z.string().trim().max(512).default("Documentation"),
    /**
     * Vault-relative directory for scratch work: clarifications, bugfix
     * alternatives, temporary notes ("raw"). Agents may write here freely.
     */
    rawDir: z.string().trim().max(512).default("raw"),
    /**
     * Vault-relative directory the planning tools (`plan_*`) are confined to.
     * Default `Projects`, the folder right below the configured directory.
     * It is not a second vault: everything is resolved against `vaultPath`
     * first, so `..`, absolute paths and symlinks out of the vault are refused
     * by the same code that guards the document tools. Empty = planning is not
     * configured and `plan_scope` answers `planning_available: false`.
     */
    // Empty means "use Projects"; the plugin creates it and the project folder.
    planRoot: z.string().trim().max(512).default("Projects"),
    /**
     * Document extensions the read and edit tools accept, comma-separated.
     * Default `.md`: the plugin is a Markdown bridge to Obsidian. A user who
     * keeps plain-text or reStructuredText notes in the same directory can add
     * `.txt`, `.rst`; anything not listed — including extensionless files such
     * as `LICENSE`, `.env` or `.git/config` — is refused by the read and edit
     * tools. Needs no schema bump: a stored document without the key validates
     * to this default.
     */
    allowedExtensions: z.string().trim().max(512).default(".md"),
    /**
     * Indexing starts automatically once `vaultPath` resolves to a real
     * directory — the user typing the path in the settings screen is the
     * consent for the first scan. This switch only exists so an operator can
     * pause indexing without clearing the path.
     */
    indexingEnabled: z.boolean().default(true),
    /**
     * Comma-separated vault-relative folders to index. Empty = the whole
     * vault (minus `excludeGlobs`).
     */
    includeFolders: z.string().trim().max(2000).default(""),
    /** Comma-separated vault-relative globs to skip. */
    excludeGlobs: z.string().trim().max(2000).default(DEFAULT_EXCLUDES),
    /**
     * Use the `porter` stemmer in the FTS5 tokenizer. Off by default: the
     * stemmer is English-only, while `unicode61` handles Russian and English
     * equally well, and changing this triggers a full reindex.
     */
    ftsStemming: z.boolean().default(false),
    /** Background reconcile interval, in minutes (watch events are immediate). */
    reconcileMinutes: z.number().int().min(1).max(240).default(10),
    /**
     * How often a standalone `obsidian_search` may re-walk the vault before it
     * answers (0.25.22). The Paseo plugin ignores it: its watcher keeps the
     * index current. 1–3600 seconds; 15 keeps a burst of searches to one walk.
     */
    indexRefreshSeconds: z.number().int().min(1).max(3600).default(15),
    /** Default result limit for `obsidian_search`. */
    maxResults: z.number().int().min(1).max(50).default(10),
    /** Character budget for one search answer's packed text. */
    searchBudgetChars: z.number().int().min(500).max(60000).default(8000),
    /** Snippet length per hit. */
    snippetChars: z.number().int().min(120).max(4000).default(600),
    /**
     * Refuse every write tool. Writes are append-only and confined to the
     * configured inbox/out/raw directories, so this is an extra brake rather
     * than the primary boundary.
     */
    readOnly: z.boolean().default(false),
    /** Hard cap for one written document body, in characters. */
    maxWriteChars: z.number().int().min(1000).max(400_000).default(200_000),
    /**
     * Add a semantic signal to search: local embeddings from
     * `@huggingface/transformers`, fused with full text and the link graph.
     * Off leaves retrieval lexical + graph only.
     */
    semanticSearch: z.boolean().default(true),
    /** Embedding model id (Hugging Face repo, ONNX weights). */
    embeddingModel: z.string().trim().max(200).default("Xenova/multilingual-e5-small"),
    /** ONNX dtype: `q8` (~118 MB), `fp32` (~470 MB), `q4`, `int8`. */
    embeddingDtype: z.string().trim().max(16).default("q8"),
    /**
     * Unload the query model after this many idle minutes. `0` keeps it loaded
     * for the whole MCP process lifetime. Memory is a warning, not a limit: up
     * to 2 GB is normal, 2-4 GB is reported in the panel, never blocked.
     */
    embeddingIdleMinutes: z.number().int().min(0).max(240).default(10),
    /**
     * Optional enrichment through the Local REST API plugin: Obsidian's own
     * fuzzy search joins retrieval, its metadata cache provides authoritative
     * links/backlinks, vault events supplement the filesystem watcher, and the
     * panel can open a note in the app. Never required; off by default.
     */
    obsidianApiEnabled: z.boolean().default(false),
    /** Base URL of the Local REST API plugin. Loopback HTTPS with its generated CA. */
    obsidianApiUrl: z.string().trim().max(512).default("https://127.0.0.1:27124"),
    /**
     * Bearer token from Obsidian → Settings → Local REST API. Local credential:
     * it is mirrored to the plugin's settings file so agent-side MCP processes
     * can use enrichment, and it is never logged or sent with note text.
     */
    obsidianApiKey: z.string().trim().max(512).default(""),
    /** Inject the MCP server (or the fallback agent tools) into agents. */
    injectIntoAgents: z.boolean().default(true),
    /**
     * Instruction appended to every session open that leaves the agent with a
     * working vault surface (0.22.18, Paseo 0.17 `appendSystemPrompt`).
     * `{server}` is replaced with the MCP prefix the agent's tools carry; an
     * empty value switches the instruction off. Not mirrored to the settings
     * file: only this plugin process appends it.
     */
    agentInstructions: z.string().trim().max(2000).default(DEFAULT_AGENT_INSTRUCTIONS),
    /**
     * Register the MCP server in OpenCode's and Kilo's own config files
     * (`mcp.obsidian-bridge`). Paseo 0.15.x refuses custom MCP servers on an
     * OpenCode agent that shares the local OpenCode service, and attached
     * tools do not reach OpenCode, so this is the path that actually delivers
     * the Obsidian tools to those agents. The entry survives a plugin restart
     * (an update would otherwise yank the namespace from a live session) and is
     * removed when this switch is turned off. Off = no config file is touched.
     */
    registerOpencodeMcp: z.boolean().default(true),
    /**
     * Install the plugin's own agent skill (`skills/obsidian-bridge/SKILL.md`)
     * into the skills directories the installed agents actually use
     * (`~/.config/opencode/skills`, `~/.opencode/skills`, `~/.agents/skills`,
     * `~/.claude/skills`). It teaches the writing and reading workflow and the
     * Obsidian Markdown vocabulary. Off = no skills directory is touched.
     */
    installAgentSkill: z.boolean().default(true),
    /**
     * Register the MCP server in Cline's own settings file. Cline ignores a
     * stdio server from the session payload, so this is the only way its agents
     * see the Obsidian tools. Off = the file is not touched.
     */
    registerClineMcp: z.boolean().default(true),
  }),
});

export type ObsidianBridgeSettings = z.infer<(typeof obsidianBridgeSettings)["schema"]>;

/** Settings subset the MCP server process needs (no UI-only values). */
export interface RuntimeSettings {
  vaultPath: string;
  inboxDir: string;
  outDir: string;
  rawDir: string;
  planRoot: string;
  /** Comma-separated extensions the read and edit tools accept (`.md` by default). */
  allowedExtensions: string;
  indexingEnabled: boolean;
  includeFolders: string;
  excludeGlobs: string;
  ftsStemming: boolean;
  reconcileMinutes: number;
  indexRefreshSeconds: number;
  maxResults: number;
  searchBudgetChars: number;
  snippetChars: number;
  readOnly: boolean;
  maxWriteChars: number;
  semanticSearch: boolean;
  embeddingModel: string;
  embeddingDtype: string;
  embeddingIdleMinutes: number;
  obsidianApiEnabled: boolean;
  obsidianApiUrl: string;
  obsidianApiKey: string;
}

export function runtimeSettingsOf(values: ObsidianBridgeSettings): RuntimeSettings {
  return {
    vaultPath: values.vaultPath,
    inboxDir: values.inboxDir,
    outDir: values.outDir,
    rawDir: values.rawDir,
    planRoot: values.planRoot,
    allowedExtensions: values.allowedExtensions,
    indexingEnabled: values.indexingEnabled,
    includeFolders: values.includeFolders,
    excludeGlobs: values.excludeGlobs,
    ftsStemming: values.ftsStemming,
    reconcileMinutes: values.reconcileMinutes,
    indexRefreshSeconds: values.indexRefreshSeconds,
    maxResults: values.maxResults,
    searchBudgetChars: values.searchBudgetChars,
    snippetChars: values.snippetChars,
    readOnly: values.readOnly,
    maxWriteChars: values.maxWriteChars,
    semanticSearch: values.semanticSearch,
    embeddingModel: values.embeddingModel,
    embeddingDtype: values.embeddingDtype,
    embeddingIdleMinutes: values.embeddingIdleMinutes,
    obsidianApiEnabled: values.obsidianApiEnabled,
    obsidianApiUrl: values.obsidianApiUrl,
    obsidianApiKey: values.obsidianApiKey,
  };
}
