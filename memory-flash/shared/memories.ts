import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Shared contracts and types for the memory-flash plugin.
 *
 * A "memory" is a tagged text record stored in a shared SQLite database. Every
 * coding agent connected through the MCP server reads and writes the same
 * database; the Paseo surface manages the same rows through plugin RPCs.
 *
 * Memory kinds follow the handoff-oriented taxonomy from the requirements:
 * decisions, procedures, handoffs, bugfix notes, patterns (what worked),
 * pitfalls (what did not), references (links to files/URLs) and free notes.
 */

export const memoryKindSchema = z.enum([
  "decision",
  "procedure",
  "handoff",
  "bugfix",
  "pattern",
  "pitfall",
  "reference",
  "note",
]);

export type MemoryKind = z.infer<typeof memoryKindSchema>;

/** Free-form tag: agent ids, project names, topics. Normalized on write. */
export const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase());

export const memorySchema = z.object({
  id: z.number().int().positive(),
  kind: memoryKindSchema,
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()),
  project: z.string().nullable(),
  agentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Bumped on every content edit; 1 on creation. */
  revision: z.number().int().positive(),
});

export type Memory = z.infer<typeof memorySchema>;

/** A content revision kept in memory_history for audit/restore. */
export const memoryRevisionSchema = z.object({
  id: z.number().int().positive(),
  memoryId: z.number().int().positive(),
  revision: z.number().int().positive(),
  title: z.string(),
  content: z.string(),
  kind: memoryKindSchema,
  tags: z.array(z.string()),
  changedBy: z.string().nullable(),
  changedAt: z.string(),
  changeKind: z.enum(["create", "update", "delete"]),
});

export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;

export const memoryInputSchema = z.object({
  kind: memoryKindSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1),
  tags: z.array(z.string()).max(24).default([]),
  project: z.string().trim().max(120).nullable().default(null),
  agentId: z.string().trim().max(120).nullable().default(null),
});

export type MemoryInput = z.infer<typeof memoryInputSchema>;

export const memoryUpdateSchema = memoryInputSchema.extend({
  /** Author of the change, recorded in history ("who changed what"). */
  changedBy: z.string().trim().max(120).nullable().default(null),
});

export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;

export const searchResultSchema = z.object({
  memory: memorySchema,
  /** Search rank (lower is better for FTS matches; 0 for exact reads). */
  score: z.number(),
  /** Highlighted snippet from FTS5 when the row matched a text query. */
  snippet: z.string().nullable(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchOptionsSchema = z.object({
  query: z.string().default(""),
  kinds: z.array(memoryKindSchema).default([]),
  tags: z.array(z.string()).default([]),
  /** Match ANY selected tag (OR); empty = no tag filter. */
  tagMode: z.enum(["any", "all"]).default("any"),
  project: z.string().nullable().default(null),
  agentId: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(20),
});

export type SearchOptions = z.infer<typeof searchOptionsSchema>;

// ---------------------------------------------------------------------------
// MCP-facing contracts. The MCP server imports the same store module as the
// plugin RPC handlers, so both write through identical validation.
// ---------------------------------------------------------------------------

export const mcpSaveInputSchema = z.object({
  kind: memoryKindSchema.default("note"),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1),
  tags: z.array(z.string()).max(24).default([]),
  project: z.string().trim().max(120).nullable().default(null),
  agentId: z.string().trim().max(120).nullable().default(null),
});

export type McpSaveInput = z.infer<typeof mcpSaveInputSchema>;

export const mcpSearchInputSchema = z.object({
  query: z.string().default(""),
  tags: z.array(z.string()).default([]),
  kinds: z.array(memoryKindSchema).default([]),
  project: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(50).default(10),
});

export type McpSearchInput = z.infer<typeof mcpSearchInputSchema>;

// ---------------------------------------------------------------------------
// Plugin RPC surface (Paseo UI ↔ plugin server).
// ---------------------------------------------------------------------------

export const listMemories = defineRpc({
  name: "memory-flash.list",
  input: searchOptionsSchema.extend({ offset: z.number().int().min(0).default(0) }),
  output: z.object({
    memories: z.array(memorySchema),
    total: z.number().int(),
  }),
});

export const searchMemories = defineRpc({
  name: "memory-flash.search",
  input: searchOptionsSchema,
  output: z.object({ results: z.array(searchResultSchema) }),
});

// ---------------------------------------------------------------------------
// Search diagnostics (since 0.7.0)
//
// Makes recall measurable: a control set of queries with known answers is run
// through the real search, and the report says per query whether a miss was a
// retrieval failure (answer never in the pool — a recall problem no reordering
// can fix) or a ranking failure. See ROADMAP.md.
// ---------------------------------------------------------------------------

export const controlQuerySchema = z.object({
  /** The free-text query exactly as an agent would send it. */
  query: z.string().min(1),
  /** Ids that count as correct; several allowed for equivalent records. */
  expectedIds: z.array(z.number().int().positive()).min(1),
});

export type ControlQueryInput = z.infer<typeof controlQuerySchema>;

export const searchDiagnoseInputSchema = z.object({
  queries: z.array(controlQuerySchema),
});

export type SearchDiagnoseInput = z.infer<typeof searchDiagnoseInputSchema>;

export const searchDiagnoseSchema = defineRpc({
  name: "memory-flash.search-diagnose",
  input: searchDiagnoseInputSchema,
  output: z.object({
    /** One-line human summary, e.g. "recall @10 17/20 (85%) — …". */
    summary: z.string(),
    /** Share of queries whose answer appeared within each cutoff. */
    recallAt: z.record(z.string(), z.number()),
    /** Raw counts per cutoff. */
    hitsAt: z.record(z.string(), z.number()),
    total: z.number(),
    /** Worst rank at which an answer was still found — the pool ceiling. */
    poolCeiling: z.number(),
    /** Misses caused by the answer never entering the candidate pool. */
    retrievalFailures: z.number(),
    /** Misses caused by the answer being retrieved but ranked too low. */
    rankingFailures: z.number(),
    misses: z.array(z.object({ query: z.string(), rank: z.number().nullable() })),
    /** Control entries rejected as unusable (empty query or no ids). */
    skipped: z.number(),
  }),
});

export const saveMemory = defineRpc({
  name: "memory-flash.save",
  input: z.object({
    /** Omit to create. */
    id: z.number().int().positive().optional(),
    input: memoryUpdateSchema,
  }),
  output: z.object({
    ok: z.boolean(),
    id: z.number().int().positive().nullable(),
    error: z.string().nullable(),
  }),
});

export const deleteMemory = defineRpc({
  name: "memory-flash.delete",
  input: z.object({ id: z.number().int().positive() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const getMemory = defineRpc({
  name: "memory-flash.get",
  input: z.object({ id: z.number().int().positive() }),
  output: z.object({
    memory: memorySchema.nullable(),
    history: z.array(memoryRevisionSchema),
  }),
});

export const restoreRevision = defineRpc({
  name: "memory-flash.restore",
  input: z.object({ revisionId: z.number().int().positive() }),
  output: z.object({ ok: z.boolean(), id: z.number().int().positive().nullable(), error: z.string().nullable() }),
});

export const memoryStats = defineRpc({
  name: "memory-flash.stats",
  input: z.object({}),
  output: z.object({
    total: z.number().int(),
    byKind: z.array(z.object({ kind: memoryKindSchema, count: z.number().int() })),
    byAgent: z.array(z.object({ agentId: z.string(), count: z.number().int() })),
    byProject: z.array(z.object({ project: z.string(), count: z.number().int() })),
    topTags: z.array(z.object({ tag: z.string(), count: z.number().int() })),
    dbSizeBytes: z.number().int(),
  }),
});

export const listTags = defineRpc({
  name: "memory-flash.tags",
  input: z.object({}),
  output: z.object({ tags: z.array(z.object({ tag: z.string(), count: z.number().int() })) }),
});

export const clearHistory = defineRpc({
  name: "memory-flash.history-clear",
  input: z.object({ olderThan: z.string().datetime().nullable().default(null) }),
  output: z.object({ removed: z.number().int() }),
});

export const purgeMemories = defineRpc({
  name: "memory-flash.purge",
  input: z.object({
    tags: z.array(z.string()).default([]),
    project: z.string().nullable().default(null),
    kind: memoryKindSchema.nullable().default(null),
    /** Confirmation string; must equal "DELETE". */
    confirm: z.literal("DELETE"),
  }),
  output: z.object({ removed: z.number().int() }),
});

// ---------------------------------------------------------------------------
// Agent task delegation ("дать задачу агенту, чтобы удалить или изменить
// данные в базе данных"). The surface composes a prompt; the server sends it
// to a chosen agent, and the agent edits the database through its MCP tools.
// ---------------------------------------------------------------------------

export const delegateTask = defineRpc({
  name: "memory-flash.delegate",
  input: z.object({
    agentId: z.string().min(1),
    /** What to do with memories, in natural language. */
    instruction: z.string().trim().min(1).max(4000),
    /** Memory ids to reference in the prompt (optional context). */
    memoryIds: z.array(z.number().int().positive()).max(50).default([]),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Skill installation.
// ---------------------------------------------------------------------------

export const skillTargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Absolute directory that receives the skill folder. */
  path: z.string(),
  /** Whether the directory existed on this machine at startup. */
  detected: z.boolean(),
});

export type SkillTarget = z.infer<typeof skillTargetSchema>;

export const skillStatusTargetSchema = skillTargetSchema.extend({
  installed: z.boolean(),
  /** True when the on-disk copy matches the bundled skill content. */
  upToDate: z.boolean().nullable(),
});

export type SkillStatusTarget = z.infer<typeof skillStatusTargetSchema>;

/** First lines of the bundled SKILL.md — shown as a preview in settings. */
export const skillPreview = defineRpc({
  name: "memory-flash.skill-preview",
  input: z.object({}),
  output: z.object({ markdown: z.string() }),
});

export const listSkillTargets = defineRpc({
  name: "memory-flash.skill-targets",
  input: z.object({}),
  output: z.object({ targets: z.array(skillTargetSchema) }),
});

export const installSkill = defineRpc({
  name: "memory-flash.skill-install",
  input: z.object({ targetId: z.string() }),
  output: z.object({ ok: z.boolean(), path: z.string().nullable(), error: z.string().nullable() }),
});

export const uninstallSkill = defineRpc({
  name: "memory-flash.skill-uninstall",
  input: z.object({ targetId: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const skillStatus = defineRpc({
  name: "memory-flash.skill-status",
  input: z.object({}),
  output: z.object({
    targets: z.array(skillStatusTargetSchema),
  }),
});

// ---------------------------------------------------------------------------
// Direct MCP registration for agents that ignore stdio MCP servers
// delivered through the agent session (Cline, Cursor, Codex CLI).
// Each keeps MCP servers in its own global config file, so the plugin
// registers the server there directly.
// ---------------------------------------------------------------------------

/** File-based registration state, shared by the JSON and TOML agents. */
export const agentMcpStatusSchema = z.object({
  /** Absolute path of the agent's MCP config file. */
  path: z.string(),
  detected: z.boolean(),
  installed: z.boolean(),
  upToDate: z.boolean().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()).nullable(),
});

export const clineMcpStatus = defineRpc({
  name: "memory-flash.cline-mcp-status",
  input: z.object({}),
  output: agentMcpStatusSchema.extend({
    /** Live spawn check: the registered command answers an MCP initialize handshake. */
    live: z.boolean().nullable(),
  }),
});

export const registerClineMcp = defineRpc({
  name: "memory-flash.cline-mcp-register",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const unregisterClineMcp = defineRpc({
  name: "memory-flash.cline-mcp-unregister",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const cursorMcpStatus = defineRpc({
  name: "memory-flash.cursor-mcp-status",
  input: z.object({}),
  output: agentMcpStatusSchema,
});

export const registerCursorMcp = defineRpc({
  name: "memory-flash.cursor-mcp-register",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const unregisterCursorMcp = defineRpc({
  name: "memory-flash.cursor-mcp-unregister",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const codexMcpStatus = defineRpc({
  name: "memory-flash.codex-mcp-status",
  input: z.object({}),
  output: agentMcpStatusSchema,
});

export const registerCodexMcp = defineRpc({
  name: "memory-flash.codex-mcp-register",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const unregisterCodexMcp = defineRpc({
  name: "memory-flash.codex-mcp-unregister",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

// OpenCode and Kilo read MCP servers from their own `mcp` config object
// (`~/.config/opencode/opencode.json`, `~/.config/kilo/kilo.jsonc`). A
// server registered there is re-created whenever OpenCode boots an idle
// directory, while a server Paseo registers at runtime disappears with
// that directory's evicted services — and with it every memory-flash tool
// of a long-lived agent. See server/opencode-mcp.ts for the full story.

export const opencodeMcpStatus = defineRpc({
  name: "memory-flash.opencode-mcp-status",
  input: z.object({}),
  output: agentMcpStatusSchema,
});

export const registerOpencodeMcp = defineRpc({
  name: "memory-flash.opencode-mcp-register",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const unregisterOpencodeMcp = defineRpc({
  name: "memory-flash.opencode-mcp-unregister",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const kiloMcpStatus = defineRpc({
  name: "memory-flash.kilo-mcp-status",
  input: z.object({}),
  output: agentMcpStatusSchema,
});

export const registerKiloMcp = defineRpc({
  name: "memory-flash.kilo-mcp-register",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const unregisterKiloMcp = defineRpc({
  name: "memory-flash.kilo-mcp-unregister",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

/** Result of registering memory-flash in one agent's MCP config. */
export const agentMcpRegistrationResultSchema = z.object({
  /** Human-readable agent label ("Cline", "Cursor", "Codex CLI"). */
  agent: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

/** Registers memory-flash in every supported local agent config at once. */
export const registerAllAgentMcp = defineRpc({
  name: "memory-flash.agent-mcp-register-all",
  input: z.object({}),
  output: z.object({ results: z.array(agentMcpRegistrationResultSchema) }),
});

// ---------------------------------------------------------------------------
// Remote hosts (requirement 8). Only the "paseo-ssh" transport is functional;
// other transports are stubs reserved for later work.
// ---------------------------------------------------------------------------

export const remoteTransportSchema = z.enum(["paseo-ssh", "tcp", "relay"]);

export const remoteHostSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  transport: remoteTransportSchema,
  /** SSH host or IP of the machine running the Paseo server. */
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  /** SSH user; the plugin uses the local `paseo --host <ssh-url>` transport. */
  user: z.string().trim().max(120).default(""),
  enabled: z.boolean().default(true),
  status: z.enum(["unknown", "ok", "error", "unsupported"]).default("unknown"),
  lastError: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
});

export type RemoteHost = z.infer<typeof remoteHostSchema>;

export const listRemoteHosts = defineRpc({
  name: "memory-flash.hosts",
  input: z.object({}),
  output: z.object({ hosts: z.array(remoteHostSchema) }),
});

export const saveRemoteHost = defineRpc({
  name: "memory-flash.hosts-save",
  input: z.object({ host: remoteHostSchema.omit({ status: true, lastError: true, checkedAt: true }) }),
  output: z.object({ ok: z.boolean(), id: z.string(), error: z.string().nullable() }),
});

export const deleteRemoteHost = defineRpc({
  name: "memory-flash.hosts-delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const checkRemoteHost = defineRpc({
  name: "memory-flash.hosts-check",
  input: z.object({ id: z.string() }),
  output: z.object({
    ok: z.boolean(),
    status: z.enum(["ok", "error", "unsupported"]),
    error: z.string().nullable(),
    /** Absolute path of the memory database as seen on the remote host. */
    remoteDbPath: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Remote access over HTTP (0.5.0). The HTTP MCP endpoint
// (`http://<host>:<port>/mcp`) authenticates clients with API keys:
// the secret is generated here, shown once, and carried by the
// remote client as `Authorization: Bearer <secret>`. Only the
// SHA-256 hash of the secret is stored; the full secret is
// returned by the generate RPC exactly once and never persisted.
// ---------------------------------------------------------------------------

/** `read` — search/read tools only; `read_write` — the full tool set. */
export const apiKeyScopeSchema = z.enum(["read", "read_write"]);

export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

/** An API key as listed in the UI — never carries the secret or its hash. */
export const apiKeySchema = z.object({
  /** Public key id (`mfk_…`). */
  id: z.string(),
  label: z.string(),
  /** First characters of the secret, for recognizing the key in the UI. */
  prefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  createdAt: z.string(),
  /** ISO timestamp; null = never expires. */
  expiresAt: z.string().nullable(),
  /** ISO timestamp; null = active. */
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

export type ApiKey = z.infer<typeof apiKeySchema>;

/** State of the HTTP MCP endpoint, for the settings UI indicator. */
export const httpStatusSchema = z.object({
  /** Enabled in the settings, whatever the socket did. */
  enabled: z.boolean(),
  /** A socket is bound right now. */
  listening: z.boolean(),
  /** Configured bind address (what the user typed). */
  host: z.string(),
  /** Configured port (what the user typed). */
  port: z.number(),
  /** Interface the live socket is bound to; null when not listening. */
  boundHost: z.string().nullable(),
  /** Port the live socket is bound to; null when not listening. */
  boundPort: z.number().nullable(),
  /** True when the live bind is a wildcard (`0.0.0.0` / `::`). */
  wildcard: z.boolean(),
  /**
   * Verbatim bound URL for the status line — may contain a wildcard address
   * (`http://0.0.0.0:8787/mcp`), which is not dialable.
   */
  bindUrl: z.string().nullable(),
  /**
   * Dialable URL for the copy block: a wildcard bind is replaced with a
   * non-internal LAN/Wi-Fi address, falling back to loopback.
   */
  url: z.string().nullable(),
  error: z.string().nullable(),
  keyCount: z.number().int(),
});

export type HttpStatus = z.infer<typeof httpStatusSchema>;

export const listApiKeys = defineRpc({
  name: "memory-flash.api-keys",
  input: z.object({}),
  output: z.object({ keys: z.array(apiKeySchema) }),
});

export const generateApiKey = defineRpc({
  name: "memory-flash.api-key-generate",
  input: z.object({
    label: z.string().trim().min(1).max(80),
    /** Time-to-live in days; 0 (default) = never expires. */
    ttlDays: z.number().int().min(0).max(3650).default(0),
    scope: apiKeyScopeSchema.default("read_write"),
  }),
  output: z.object({
    ok: z.boolean(),
    id: z.string().nullable(),
    /** The full secret — returned once, never stored, never logged. */
    secret: z.string().nullable(),
    key: apiKeySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const deleteApiKey = defineRpc({
  name: "memory-flash.api-key-delete",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const httpStatus = defineRpc({
  name: "memory-flash.http-status",
  input: z.object({}),
  output: httpStatusSchema,
});
