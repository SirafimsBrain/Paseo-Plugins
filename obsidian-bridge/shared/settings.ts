import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

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
  version: 1,
  schema: z.object({
    /**
     * Absolute path of the local Obsidian vault. Empty means "not
     * configured": nothing is indexed, no tools answer with content, and the
     * panel/settings screen asks for the path. This is the single value the
     * plugin cannot guess.
     */
    vaultPath: z.string().trim().max(1024).default(""),
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
    /** Default result limit for `obsidian_search`. */
    maxResults: z.number().int().min(1).max(50).default(10),
    /** Character budget for one search answer's packed text. */
    searchBudgetChars: z.number().int().min(500).max(60000).default(8000),
    /** Snippet length per hit. */
    snippetChars: z.number().int().min(120).max(4000).default(600),
    /**
     * Reserved for the write tools introduced in 0.2.0. 0.1.0 ships read-only
     * tools, so this switch is documented but inert.
     */
    readOnly: z.boolean().default(true),
    /** Inject the MCP server (or the fallback agent tools) into agents. */
    injectIntoAgents: z.boolean().default(true),
  }),
});

export type ObsidianBridgeSettings = z.infer<(typeof obsidianBridgeSettings)["schema"]>;

/** Settings subset the MCP server process needs (no UI-only values). */
export interface RuntimeSettings {
  vaultPath: string;
  indexingEnabled: boolean;
  includeFolders: string;
  excludeGlobs: string;
  ftsStemming: boolean;
  reconcileMinutes: number;
  maxResults: number;
  searchBudgetChars: number;
  snippetChars: number;
  readOnly: boolean;
}

export function runtimeSettingsOf(values: ObsidianBridgeSettings): RuntimeSettings {
  return {
    vaultPath: values.vaultPath,
    indexingEnabled: values.indexingEnabled,
    includeFolders: values.includeFolders,
    excludeGlobs: values.excludeGlobs,
    ftsStemming: values.ftsStemming,
    reconcileMinutes: values.reconcileMinutes,
    maxResults: values.maxResults,
    searchBudgetChars: values.searchBudgetChars,
    snippetChars: values.snippetChars,
    readOnly: values.readOnly,
  };
}
