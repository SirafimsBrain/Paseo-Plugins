import * as path from "node:path";
import {
  asRecord,
  asString,
  directorySize,
  firstLine,
  homeDir,
  isDirectory,
  isProcessAlive,
  listDirectories,
  pathSize,
  readJson,
  toIso,
} from "../util";
import { createCliProvider } from "./cli";
import type { ProviderListResult, ProviderSession } from "./types";

/** Cline keeps per-session directories next to a SQLite history database. */
export function clineDataDir(): string {
  const override = process.env.CLINE_DATA_DIR;
  return override && override.trim().length > 0
    ? override
    : path.join(homeDir(), ".cline", "data");
}

export function clineSessionsDir(): string {
  return path.join(clineDataDir(), "sessions");
}

/** Store size covers the session directories and the history databases. */
export function clineStoreBytes(): number | null {
  return pathSize(clineDataDir());
}

function titleFromPrompt(prompt: unknown, metadata: Record<string, unknown> | null): string | null {
  const explicit = asString(metadata?.["title"]);
  if (explicit) return explicit;
  return firstLine(prompt, 90);
}

function sessionStatus(row: Record<string, unknown>): boolean {
  const status = asString(row["status"]);
  if (status === "running") return true;
  if (row["endedAt"]) return false;
  const pid = typeof row["pid"] === "number" ? row["pid"] : Number(row["pid"]);
  return Number.isFinite(pid) && isProcessAlive(pid);
}

function sizeOfSession(id: string): number | null {
  const dir = path.join(clineSessionsDir(), id);
  return isDirectory(dir) ? directorySize(dir) : null;
}

function parseHistoryRow(row: Record<string, unknown>): ProviderSession | null {
  const id = asString(row["sessionId"]) ?? asString(row["session_id"]);
  if (!id) return null;
  const metadata = asRecord(row["metadata"]);
  return {
    id,
    title: titleFromPrompt(row["prompt"], metadata),
    cwd: asString(row["cwd"]),
    createdAt: toIso(row["startedAt"] ?? row["started_at"]),
    updatedAt: toIso(row["endedAt"] ?? row["updatedAt"] ?? row["startedAt"] ?? row["started_at"]),
    sizeBytes: sizeOfSession(id),
    running: sessionStatus(row),
  };
}

/**
 * Fallback for machines where the Cline CLI is not on PATH: the per-session
 * directories are the source of truth on disk. Deletion stays unavailable in
 * that case because the history database would keep a dangling entry.
 */
async function listFromDisk(): Promise<ProviderListResult> {
  const root = clineSessionsDir();
  const sessions: ProviderSession[] = [];
  for (const dir of listDirectories(root)) {
    const id = path.basename(dir);
    const meta = asRecord(readJson(path.join(dir, `${id}.json`)));
    if (!meta) continue;
    sessions.push({
      id: asString(meta["session_id"]) ?? id,
      title: titleFromPrompt(meta["prompt"], meta),
      cwd: asString(meta["cwd"]),
      createdAt: toIso(meta["started_at"]),
      updatedAt: toIso(meta["ended_at"] ?? meta["started_at"]),
      sizeBytes: directorySize(dir),
      running: sessionStatus(meta),
    });
  }
  return {
    sessions,
    detected: isDirectory(root),
    detail: `${root} (CLI "cline" not found; deletion disabled)`,
    deletable: false,
    storeBytes: clineStoreBytes(),
    error: null,
  };
}

export const clineProvider = createCliProvider({
  id: "cline",
  label: "Cline",
  binary: "cline",
  storePath: clineSessionsDir,
  storeBytes: clineStoreBytes,
  fallbackList: listFromDisk,
  listArgs: () => ["history", "--json", "--limit", "500"],
  parseRow: parseHistoryRow,
  deleteArgs: (id) => ["history", "delete", "--session-id", id],
  // Cline writes the dump itself, as a standalone HTML transcript.
  export: {
    kind: "file",
    extension: "html",
    args: (id, outPath) => ["history", "export", id, "--output", outPath],
  },
});
