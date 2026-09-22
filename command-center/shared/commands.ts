import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Commands are templates rendered into a prompt or shell line. A command never
 * executes on the daemon by itself: the client resolves the target workspace
 * and agent, then the daemon-side API creates the agent or sends the prompt.
 */
export const commandTypeSchema = z.enum(["prompt", "shell"]);

/**
 * `{{input:name}}` / `{{input:name|default}}` — prompted at run time.
 * `{{workspace.name}}`, `{{workspace.path}}` — run-time workspace context.
 * `{{date}}` — current date, `{{time}}` — current time (server clock).
 */
export const commandVariableSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  defaultValue: z.string().optional(),
});

export const commandSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: commandTypeSchema.default("prompt"),
  template: z.string().min(1),
  variables: z.array(commandVariableSchema).max(12).default([]),
  /** `agent` commands run against one workspace and never target a new one. */
  scope: z.enum(["global", "workspace"]).default("global"),
  /** Shell commands only: a title for the created terminal. */
  terminalName: z.string().optional(),
  /** Prompt commands only: `provider/model` of the agent created for a run. */
  provider: z.string().optional(),
  favorite: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Monotonic usage counter for the "most used" ordering. */
  useCount: z.number().int().min(0).default(0),
});

export type CommandDefinition = z.infer<typeof commandSchema>;
export type CommandVariable = z.infer<typeof commandVariableSchema>;

/** One selectable model of a provider, as reported by the daemon. */
export interface ProviderModelInfo {
  id: string;
  label: string;
  isDefault: boolean;
}

/** An enabled provider with its models, qualified by host. Client-safe. */
export interface ProviderWithModels {
  id: string;
  serverId: string;
  hostLabel: string;
  models: ProviderModelInfo[];
}

/**
 * Full `provider/model` reference for `PaseoAgentConfig.provider`.
 * Tolerates both daemon shapes: a bare model id (`opus-4.6`) and an already
 * qualified one (`claude/opus-4.6`).
 */
export function fullModelRef(providerId: string, modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.includes("/")) return trimmed;
  return `${providerId}/${trimmed}`;
}

/** True when the value is usable as `PaseoAgentConfig.provider`. */
export function isFullModelRef(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1;
}

/**
 * Normalizes a daemon `models` array into picker-ready entries, storing the
 * full `provider/model` reference as `id`. Non-selectable entries are dropped.
 * Returns null when the input is not an array (caller should fall back to
 * `listModels`), or an empty array when nothing usable was reported.
 */
export function normalizeProviderModels(raw: unknown, providerId: string): ProviderModelInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const models: ProviderModelInfo[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record["isSelectable"] === false) continue;
    const rawId = record["id"];
    if (typeof rawId !== "string" || rawId.trim().length === 0) continue;
    const label = typeof record["label"] === "string" && record["label"].length > 0 ? record["label"] : rawId.trim();
    models.push({
      id: fullModelRef(providerId, rawId),
      label,
      isDefault: record["isDefault"] === true,
    });
  }
  return models;
}

/** One history entry per run, appended after the run is dispatched. */
export const historyEntrySchema = z.object({
  id: z.string(),
  commandId: z.string(),
  commandName: z.string(),
  /** Rendered prompt (input filled in) or shell line, as it was dispatched. */
  rendered: z.string(),
  targetWorkspaceId: z.string().nullable(),
  targetAgentId: z.string().nullable(),
  kind: z.enum(["new-agent", "existing-agent", "terminal"]),
  ok: z.boolean(),
  error: z.string().nullable(),
  at: z.string(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const runResultSchema = z.object({
  ok: z.boolean(),
  kind: z.enum(["new-agent", "existing-agent", "terminal"]),
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
  terminalId: z.string().nullable(),
  title: z.string().nullable(),
  error: z.string().nullable(),
});

export type RunResult = z.infer<typeof runResultSchema>;

export const listCommands = defineRpc({
  name: "command-center.list",
  input: z.object({}),
  output: z.object({
    commands: z.array(commandSchema),
  }),
});

export const saveCommand = defineRpc({
  name: "command-center.save",
  input: z.object({
    /** Missing id means "create"; an unknown id is also treated as create. */
    command: commandSchema.partial({ id: true, createdAt: true }).optional(),
    /** When set together with `command`, `delete` runs after the save. */
    deleteId: z.string().optional(),
  }),
  output: z.object({
    saved: z.boolean(),
    id: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const deleteCommand = defineRpc({
  name: "command-center.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
});

export const toggleFavorite = defineRpc({
  name: "command-center.favorite",
  input: z.object({ id: z.string(), favorite: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const listHistory = defineRpc({
  name: "command-center.history",
  input: z.object({}),
  output: z.object({ entries: z.array(historyEntrySchema) }),
});

export const clearHistory = defineRpc({
  name: "command-center.history-clear",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export const runCommand = defineRpc({
  name: "command-center.run",
  input: z.object({
    commandId: z.string(),
    /** Final values for every declared variable, already validated client-side. */
    values: z.record(z.string(), z.string()),
    /** Required for `workspace` scope and for shell commands. */
    workspaceId: z.string().optional(),
    /** Send to an existing agent instead of creating a new one. */
    agentId: z.string().optional(),
    /** Create the agent in a branch-off worktree of the target workspace. */
    newWorktree: z.boolean().optional(),
    /** Run-time provider/model override; falls back to the stored command provider. */
    provider: z.string().optional(),
  }),
  output: runResultSchema,
});

/** One fan-out target inside a batch run. All fields optional; the executor
 * falls back to the stored command defaults and the best-guess workspace. */
export const runTargetSchema = z.object({
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  provider: z.string().optional(),
  newWorktree: z.boolean().optional(),
});

export type RunTarget = z.infer<typeof runTargetSchema>;

export const runBatch = defineRpc({
  name: "command-center.run-batch",
  input: z.object({
    commandId: z.string(),
    /** Final values for every declared variable, already validated client-side. */
    values: z.record(z.string(), z.string()),
    targets: z.array(runTargetSchema).min(1).max(20),
  }),
  output: z.object({
    results: z.array(runResultSchema),
  }),
});

export const appendHistory = defineRpc({
  name: "command-center.history-append",
  input: z.object({
    entry: historyEntrySchema.omit({ id: true, at: true }),
  }),
  output: z.object({
    ok: z.boolean(),
    id: z.string().nullable(),
  }),
});
