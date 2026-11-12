import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Shared contracts: value types used by the plugin server, the MCP bundle and
 * the Paseo UI, plus the plugin RPC surface (UI ↔ plugin server).
 */

/** One search hit as it leaves the retrieval layer. */
export const searchHitSchema = z.object({
  /** Vault-relative note path, e.g. `Projects/orion/Research/queue.md`. */
  path: z.string(),
  title: z.string(),
  /** Heading path inside the note, `""` for the introduction. */
  heading: z.string(),
  /** Highlighted snippet (FTS5 markers stripped, truncated). */
  snippet: z.string(),
  /** Fused relevance score, higher is better. */
  score: z.number(),
  /** Number of notes linking to this one. */
  backlinks: z.number().int(),
});

export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResultSchema = z.object({
  query: z.string(),
  hits: z.array(searchHitSchema),
  /** Text block packed into the configured character budget. */
  text: z.string(),
  tookMs: z.number().int(),
  /** Signals that actually contributed (e.g. ["chunks","titles","graph"]). */
  signals: z.array(z.string()),
  /** Set when the vault is not configured or the index is empty. */
  note: z.string().nullable(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

/** Live status of the vault and its index. */
export const vaultStatusSchema = z.object({
  vaultPath: z.string(),
  configured: z.boolean(),
  vaultExists: z.boolean(),
  /** True when the directory carries `.obsidian`. */
  isObsidianVault: z.boolean(),
  indexingEnabled: z.boolean(),
  indexedNotes: z.number().int(),
  indexedChunks: z.number().int(),
  indexedLinks: z.number().int(),
  unresolvedLinks: z.number().int(),
  indexBytes: z.number().int(),
  lastScanAt: z.string().nullable(),
  lastChangeAt: z.string().nullable(),
  watching: z.boolean(),
  indexRunning: z.boolean(),
  readOnly: z.boolean(),
  dbPath: z.string().nullable(),
  error: z.string().nullable(),
});

export type VaultStatus = z.infer<typeof vaultStatusSchema>;

/** Result of validating a candidate vault path (settings screen "Check"). */
export const verifyVaultResultSchema = z.object({
  ok: z.boolean(),
  path: z.string(),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  isObsidianVault: z.boolean(),
  /** Markdown files found in a bounded walk (capped, see `capped`). */
  markdownFiles: z.number().int(),
  capped: z.boolean(),
  /** A few note paths, to show the user what was found. */
  sample: z.array(z.string()),
  error: z.string().nullable(),
});

export type VerifyVaultResult = z.infer<typeof verifyVaultResultSchema>;

/** A note as rendered by the panel's preview. */
export const notePreviewSchema = z.object({
  path: z.string(),
  title: z.string(),
  frontmatter: z.string(),
  headings: z.array(z.object({ level: z.number().int(), text: z.string() })),
  tags: z.array(z.string()),
  links: z.array(z.object({ target: z.string(), resolved: z.string().nullable() })),
  backlinks: z.array(z.string()),
  content: z.string(),
  truncated: z.boolean(),
});

export type NotePreview = z.infer<typeof notePreviewSchema>;

// ---------------------------------------------------------------------------
// Plugin RPC surface (Paseo UI ↔ plugin server).
// ---------------------------------------------------------------------------

/** Current vault/index status; polled by the panel and the settings screen. */
export const vaultStatus = defineRpc({
  name: "obsidian-bridge.status",
  input: z.object({}),
  output: vaultStatusSchema,
});

/**
 * Validates a candidate vault path without saving it. Backs the "Check path"
 * action so a typo is caught before indexing starts.
 */
export const verifyVault = defineRpc({
  name: "obsidian-bridge.verify-vault",
  input: z.object({ path: z.string().trim().min(1).max(1024) }),
  output: verifyVaultResultSchema,
});

/** Runs a retrieval query through the same engine the agents use. */
export const searchVaultRpc = defineRpc({
  name: "obsidian-bridge.search",
  input: z.object({
    query: z.string().trim().min(1).max(1000),
    limit: z.number().int().min(1).max(50).optional(),
    folder: z.string().trim().max(512).optional(),
  }),
  output: searchResultSchema,
});

/** Forces a full reconcile of the index against the vault on disk. */
export const reindexVault = defineRpc({
  name: "obsidian-bridge.reindex",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    notes: z.number().int(),
    chunks: z.number().int(),
    tookMs: z.number().int(),
    error: z.string().nullable(),
  }),
});

/** Full note preview for the panel. */
export const readNote = defineRpc({
  name: "obsidian-bridge.note",
  input: z.object({ path: z.string().trim().min(1).max(1024) }),
  output: notePreviewSchema,
});
