import { parseJsonLoose, resolveBinary, runCli } from "../exec";
import type { ProviderAdapter, ProviderDeleteResult, ProviderListResult, ProviderSession } from "./types";

export interface CliProviderConfig {
  id: string;
  label: string;
  /** Executable name, e.g. "cline" or "opencode". */
  binary: string;
  /** Directory or database that holds the sessions, for status reporting. */
  storePath: () => string;
  /** Skip CLI discovery entirely and read the store directly. */
  fallbackList?: () => Promise<ProviderListResult>;
  listArgs: (limit: number) => string[];
  /** Maps one CLI row to a session; return null to skip unknown rows. */
  parseRow: (row: Record<string, unknown>) => ProviderSession | null;
  deleteArgs: (id: string) => string[];
  /** Optional post-processing, e.g. computing the on-disk size of a session. */
  enrich?: (session: ProviderSession) => Promise<ProviderSession> | ProviderSession;
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

  async function list(): Promise<ProviderListResult> {
    const binary = resolveBinary(config.binary);
    if (!binary) {
      if (config.fallbackList) {
        return await config.fallbackList();
      }
      return {
        sessions: [],
        detected: false,
        detail: `${config.storePath()} (CLI "${config.binary}" not found)`,
        deletable: false,
        error: null,
      };
    }

    const result = await runCli(binary, config.listArgs(limit), { timeoutMs });
    if (!result.ok) {
      if (config.fallbackList) {
        return await config.fallbackList();
      }
      return {
        sessions: [],
        detected: true,
        detail: binary,
        deletable: false,
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

    return { sessions, detected: true, detail: binary, deletable: true, error: null };
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

  return { id: config.id, label: config.label, list, delete: deleteMany };
}
