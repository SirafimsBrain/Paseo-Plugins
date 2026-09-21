import * as fs from "node:fs";
import * as path from "node:path";
import { fileSize, pathSize } from "../util";
import { parseJsonLoose, resolveBinary, runCli } from "../exec";
import type {
  ProviderAdapter,
  ProviderDeleteResult,
  ProviderExportResult,
  ProviderListResult,
  ProviderSession,
} from "./types";

/**
 * How an agent CLI dumps a session. `file` is for CLIs that write the export
 * themselves (`cline history export --output`), `stdout` for the ones that
 * print it (`opencode export`).
 */
export type CliExportConfig =
  | { kind: "file"; extension: string; args: (id: string, outPath: string) => string[] }
  | { kind: "stdout"; extension: string; args: (id: string) => string[] };

export interface CliProviderConfig {
  id: string;
  label: string;
  /** Executable name, e.g. "cline" or "opencode". */
  binary: string;
  /** Directory or database that holds the sessions, for status reporting. */
  storePath: () => string;
  /** Total on-disk size of the store; defaults to the size of `storePath()`. */
  storeBytes?: () => number | null;
  /** Skip CLI discovery entirely and read the store directly. */
  fallbackList?: () => Promise<ProviderListResult>;
  listArgs: (limit: number) => string[];
  /** Maps one CLI row to a session; return null to skip unknown rows. */
  parseRow: (row: Record<string, unknown>) => ProviderSession | null;
  deleteArgs: (id: string) => string[];
  /** Optional post-processing, e.g. computing the on-disk size of a session. */
  enrich?: (session: ProviderSession) => Promise<ProviderSession> | ProviderSession;
  /** Optional transcript dump used by the "export before delete" flow. */
  export?: CliExportConfig;
  listLimit?: number;
  timeoutMs?: number;
}

/**
 * Sessions of agents that ship their own session commands (cline, opencode,
 * kilo). Listing and deleting through the vendor CLI keeps the plugin
 * independent of private database schemas, and lets the agent clean up its
 * own indexes, snapshots, and message rows.
 */
export function createCliProvider(config: CliProviderConfig): ProviderAdapter {
  const limit = config.listLimit ?? 500;
  const timeoutMs = config.timeoutMs ?? 45_000;
  const storeBytes = config.storeBytes ?? (() => pathSize(config.storePath()));

  async function list(): Promise<ProviderListResult> {
    const binary = resolveBinary(config.binary);
    if (!binary) {
      if (config.fallbackList) {
        const fallback = await config.fallbackList();
        // The disk fallback knows the store size even though deletion is off.
        return { ...fallback, storeBytes: fallback.storeBytes ?? storeBytes() };
      }
      return {
        sessions: [],
        detected: false,
        detail: `${config.storePath()} (CLI "${config.binary}" not found)`,
        deletable: false,
        storeBytes: storeBytes(),
        error: null,
      };
    }

    const result = await runCli(binary, config.listArgs(limit), { timeoutMs });
    if (!result.ok) {
      if (config.fallbackList) {
        const fallback = await config.fallbackList();
        return { ...fallback, storeBytes: fallback.storeBytes ?? storeBytes() };
      }
      return {
        sessions: [],
        detected: true,
        detail: binary,
        deletable: false,
        storeBytes: storeBytes(),
        error: `${config.binary} failed: ${result.error ?? "unknown error"}`,
      };
    }

    const parsed = parseJsonLoose(result.stdout);
    if (!Array.isArray(parsed)) {
      return {
        sessions: [],
        detected: true,
        detail: binary,
        deletable: true,
        storeBytes: storeBytes(),
        error: `${config.binary} returned unexpected output`,
      };
    }

    const sessions: ProviderSession[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const session = config.parseRow(entry as Record<string, unknown>);
      if (!session) continue;
      sessions.push(config.enrich ? await config.enrich(session) : session);
    }

    return {
      sessions,
      detected: true,
      detail: binary,
      deletable: true,
      storeBytes: storeBytes(),
      error: null,
    };
  }

  async function deleteMany(ids: string[]): Promise<ProviderDeleteResult> {
    const binary = resolveBinary(config.binary);
    if (!binary) {
      return {
        deleted: [],
        failures: ids.map((id) => ({
          id,
          error: `CLI "${config.binary}" not found; refusing to edit the store directly`,
        })),
      };
    }

    const deleted: string[] = [];
    const failures: { id: string; error: string }[] = [];
    for (const id of ids) {
      const result = await runCli(binary, config.deleteArgs(id), { timeoutMs });
      if (result.ok) {
        deleted.push(id);
      } else {
        failures.push({ id, error: result.error ?? "delete failed" });
      }
    }
    return { deleted, failures };
  }

  async function exportSession(input: {
    id: string;
    outPath: string;
  }): Promise<ProviderExportResult> {
    const exportConfig = config.export;
    if (!exportConfig) return { ok: false, error: `${config.binary} cannot export sessions` };

    const binary = resolveBinary(config.binary);
    if (!binary) {
      return { ok: false, error: `CLI "${config.binary}" not found; cannot export` };
    }

    if (exportConfig.kind === "file") {
      const result = await runCli(binary, exportConfig.args(input.id, input.outPath), { timeoutMs });
      if (!result.ok) return { ok: false, error: result.error ?? "export failed" };
      const bytes = fileSize(input.outPath);
      if (bytes === null) {
        return { ok: false, error: `${config.binary} did not write the export file` };
      }
      return { ok: true, bytes };
    }

    const result = await runCli(binary, exportConfig.args(input.id), { timeoutMs });
    if (!result.ok) return { ok: false, error: result.error ?? "export failed" };
    if (result.stdout.trim().length === 0) {
      return { ok: false, error: `${config.binary} returned an empty export` };
    }
    try {
      fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
      fs.writeFileSync(input.outPath, result.stdout, "utf-8");
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, bytes: fileSize(input.outPath) ?? 0 };
  }

  const adapter: ProviderAdapter = { id: config.id, label: config.label, list, delete: deleteMany };
  if (config.export) {
    adapter.exportSession = exportSession;
    adapter.exportExtension = config.export.extension;
  }
  return adapter;
}
