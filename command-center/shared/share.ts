import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  commandSchema,
  validateCommandForSave,
  type CommandDefinition,
} from "./commands";

/**
 * Portable library bundle (0.8.0): the exchange format behind export/import and
 * the answer to "share a command with someone else / move a library between
 * daemons". The envelope is versioned so a future schema change can be
 * detected instead of silently mis-parsed; a bare `CommandDefinition[]` is also
 * accepted on import, because that is what a hand-written or copied
 * `commands.json` looks like.
 *
 * Pure and client-safe: the server handlers and the tests share exactly one
 * definition of the format.
 */
export const SHARE_FORMAT = "command-center/commands";
export const SHARE_VERSION = 1;

export const shareBundleSchema = z.object({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION),
  exportedAt: z.string(),
  commands: z.array(commandSchema),
});

export type ShareBundle = z.infer<typeof shareBundleSchema>;

/**
 * Exports the selected commands (all when `ids` is omitted). Server-owned
 * counters are reset: a shared `useCount` from another machine would inflate
 * the local "most used" analytics, which describe *this* library's usage.
 */
export function buildShareBundle(
  commands: CommandDefinition[],
  ids: string[] | undefined,
  nowIso: string = new Date().toISOString(),
): ShareBundle {
  const selected = ids && ids.length > 0
    ? commands.filter((command) => ids.includes(command.id))
    : commands;
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: nowIso,
    commands: selected.map((command) => ({ ...command, useCount: 0 })),
  };
}

export interface ParsedShare {
  /** Raw command records; each is validated by `planImport`. */
  commands: unknown[];
  error: string | null;
}

/** Accepts the versioned envelope or a bare command array. */
export function parseShareBundle(text: string): ParsedShare {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      commands: [],
      error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (Array.isArray(parsed)) return { commands: parsed, error: null };
  if (typeof parsed !== "object" || parsed === null) {
    return { commands: [], error: "Expected a command array or a Command Center bundle object." };
  }
  const record = parsed as Record<string, unknown>;
  if (record["format"] !== SHARE_FORMAT) {
    return {
      commands: [],
      error: `Unrecognized bundle format — expected "${SHARE_FORMAT}".`,
    };
  }
  if (record["version"] !== SHARE_VERSION) {
    return {
      commands: [],
      error: `Unsupported bundle version ${String(record["version"])}; this plugin reads version ${SHARE_VERSION}.`,
    };
  }
  if (!Array.isArray(record["commands"])) {
    return { commands: [], error: "The bundle has no commands array." };
  }
  return { commands: record["commands"], error: null };
}

/** `Name`, `Name (2)`, `Name (3)`… — the first free name in the library. */
export function uniqueCommandName(name: string, taken: Set<string>): string {
  const base = name.trim() || "Command";
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (${counter})`;
    counter += 1;
  }
  return candidate;
}

export type ImportMode = "merge" | "copy";

export interface ImportPlan {
  /** The library after the import — save this. */
  library: CommandDefinition[];
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface ImportOptions {
  mode: ImportMode;
  nowIso?: string;
  /** Deterministic id factory for tests; defaults to time + random. */
  makeId?: () => string;
}

function defaultId(): string {
  return `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Merges an exported bundle into a library.
 *
 * - `merge` updates the command with the same id, else the same
 *   case-insensitive name, and adds everything else. Favorite flags and usage
 *   counters stay local (server-owned), and the existing id/createdAt win.
 * - `copy` always adds new commands with fresh ids and a de-duplicated name,
 *   so importing your own export does not overwrite the originals.
 *
 * Workflow steps are remapped through the bundle→final id mapping, which is
 * what makes `copy` produce a working chain instead of dangling references.
 * Every candidate goes through the same `validateCommandForSave` the save
 * handler uses; a broken one is skipped and reported, never written.
 */
export function planImport(
  existing: CommandDefinition[],
  rawCommands: unknown[],
  options: ImportOptions,
): ImportPlan {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const makeId = options.makeId ?? defaultId;
  const library = existing.map((command) => ({ ...command }));
  const byId = new Map(library.map((command) => [command.id, command]));
  const byName = new Map(library.map((command) => [command.name.trim().toLowerCase(), command]));
  const usedIds = new Set(library.map((command) => command.id));
  const usedNames = new Set(library.map((command) => command.name.trim().toLowerCase()));

  const errors: string[] = [];
  /** Bundle id (or array index when absent) → id in the resulting library. */
  const idMap = new Map<string, string>();
  const prepared: { raw: Record<string, unknown>; originalKey: string; finalId: string }[] = [];
  let skipped = 0;

  const allocateId = (preferred: string | undefined): string => {
    if (preferred && preferred.trim().length > 0 && !usedIds.has(preferred)) {
      usedIds.add(preferred);
      return preferred;
    }
    let id = makeId();
    while (usedIds.has(id)) id = makeId();
    usedIds.add(id);
    return id;
  };

  rawCommands.forEach((entry, index) => {
    const key = `#${index + 1}`;
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      errors.push(`${key}: not an object.`);
      return;
    }
    const raw = entry as Record<string, unknown>;
    const rawId = typeof raw["id"] === "string" ? raw["id"].trim() : "";
    const rawName = typeof raw["name"] === "string" ? raw["name"].trim() : "";
    if (rawName.length === 0) {
      skipped += 1;
      errors.push(`${key}: missing a name.`);
      return;
    }

    const existingMatch =
      options.mode === "merge"
        ? (rawId ? byId.get(rawId) : undefined) ??
          byName.get(rawName.toLowerCase())
        : undefined;

    let finalId: string;
    let finalName: string;
    if (options.mode === "merge" && existingMatch) {
      finalId = existingMatch.id;
      finalName = existingMatch.name;
    } else if (options.mode === "merge") {
      finalId = allocateId(rawId || undefined);
      finalName = rawName;
    } else {
      finalId = allocateId(undefined);
      finalName = uniqueCommandName(rawName, usedNames);
    }
    usedNames.add(finalName.toLowerCase());
    idMap.set(rawId || `#${index}`, finalId);
    prepared.push({ raw, originalKey: rawId || `#${index}`, finalId });
  });

  let added = 0;
  let updated = 0;

  // Commands first, workflows second: a workflow validates its steps against
  // the library, so its step commands must already be in it. (A workflow that
  // references another imported workflow is still rejected — nesting is not
  // allowed — but a plain chain imports in any order this way.)
  prepared.sort((a, b) => Number(a.raw["type"] === "workflow") - Number(b.raw["type"] === "workflow"));

  for (const item of prepared) {
    const target = byId.get(item.finalId);
    const rawSteps = item.raw["steps"];
    const remappedSteps = Array.isArray(rawSteps)
      ? rawSteps.map((step) => {
          if (typeof step !== "object" || step === null) return step;
          const record = step as Record<string, unknown>;
          const commandId = typeof record["commandId"] === "string" ? record["commandId"] : "";
          return { ...record, commandId: idMap.get(commandId) ?? commandId };
        })
      : rawSteps;

    const candidateRaw: Record<string, unknown> = {
      ...item.raw,
      id: item.finalId,
      name: target ? target.name : item.finalId === item.raw["id"] ? item.raw["name"] : undefined,
      steps: remappedSteps,
      createdAt: target?.createdAt ?? item.raw["createdAt"] ?? nowIso,
      updatedAt: item.raw["updatedAt"] ?? nowIso,
      // Server-owned fields never travel with the bundle.
      useCount: target?.useCount ?? 0,
      favorite: options.mode === "merge" ? (target?.favorite ?? item.raw["favorite"] ?? false) : (item.raw["favorite"] ?? false),
    };
    if (candidateRaw["name"] === undefined) candidateRaw["name"] = item.raw["name"];

    const parsed = commandSchema.safeParse(candidateRaw);
    if (!parsed.success) {
      skipped += 1;
      errors.push(`${String(item.raw["name"])}: ${parsed.error.issues[0]?.message ?? "invalid command"}.`);
      continue;
    }

    // Copy mode needs a fresh, unique display name; merge keeps the stored one.
    const name = options.mode === "copy"
      ? uniqueCommandName(String(item.raw["name"]), new Set(library.map((cmd) => cmd.name.trim().toLowerCase())))
      : parsed.data.name;
    const candidate: CommandDefinition = { ...parsed.data, name };

    const invalid = validateCommandForSave(candidate, library);
    if (invalid) {
      skipped += 1;
      errors.push(`${candidate.name}: ${invalid}`);
      continue;
    }

    const index = library.findIndex((command) => command.id === candidate.id);
    if (index >= 0) {
      library[index] = candidate;
      updated += 1;
    } else {
      library.push(candidate);
      added += 1;
    }
    byId.set(candidate.id, candidate);
    byName.set(candidate.name.trim().toLowerCase(), candidate);
  }

  library.sort((a, b) => a.name.localeCompare(b.name));
  return { library, added, updated, skipped, errors };
}

const importResultSchema = z.object({
  ok: z.boolean(),
  added: z.number().int().min(0),
  updated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  error: z.string().nullable(),
});

export type ImportResult = z.infer<typeof importResultSchema>;

export const exportCommands = defineRpc({
  name: "command-center.export",
  input: z.object({
    /** Selected command ids; omitted/empty exports the whole library. */
    ids: z.array(z.string()).optional(),
  }),
  output: z.object({
    json: z.string(),
    count: z.number().int().min(0),
  }),
});

export const importCommands = defineRpc({
  name: "command-center.import",
  input: z.object({
    json: z.string().min(1),
    mode: z.enum(["merge", "copy"]).default("merge"),
  }),
  output: importResultSchema,
});

/**
 * Fetches a shared bundle from an HTTP(S) URL and imports it. This is the
 * "install from a repository" half of the roadmap item: a raw JSON file in a
 * git repo (or a gist, or any static host) is a valid source; the plugin does
 * not run `git`, so a repository URL must point at the file itself.
 */
export const importCommandsFromUrl = defineRpc({
  name: "command-center.import-url",
  input: z.object({
    url: z.string().min(1),
    mode: z.enum(["merge", "copy"]).default("merge"),
  }),
  output: importResultSchema,
});
