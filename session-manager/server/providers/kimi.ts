import * as fs from "node:fs";
import * as path from "node:path";
import {
  asRecord,
  asString,
  directorySize,
  fileSize,
  homeDir,
  isDirectory,
  listDirectories,
  modifiedAt,
  pathSize,
  readJson,
  removePath,
  toIso,
} from "../util";
import { resolveBinary, runCli } from "../exec";
import type {
  ProviderAdapter,
  ProviderDeleteResult,
  ProviderExportResult,
  ProviderListResult,
  ProviderSession,
} from "./types";

/**
 * Kimi Code CLI keeps everything under $KIMI_CODE_HOME (default ~/.kimi-code).
 * Sessions live at $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/ with a
 * state.json metadata file, and the master index is
 * $KIMI_CODE_HOME/session_index.jsonl (one JSON object per line).
 *
 * Kimi exposes no `session list` / `session delete` CLI, so listing and
 * deletion read the store directly from disk. Only export goes through the
 * vendor CLI (`kimi export <id> -o <path>`, produces a ZIP).
 */

export function kimiHome(): string {
  const override = process.env.KIMI_CODE_HOME;
  return override && override.trim().length > 0
    ? override
    : path.join(homeDir(), ".kimi-code");
}

export function kimiSessionsDir(): string {
  return path.join(kimiHome(), "sessions");
}

export function kimiIndexPath(): string {
  return path.join(kimiHome(), "session_index.jsonl");
}

export function kimiLocksDir(): string {
  return path.join(kimiHome(), "locks", "sessions");
}

/** Total on-disk size of the Kimi data root this adapter reads and deletes from. */
export function kimiStoreBytes(): number | null {
  return pathSize(kimiHome());
}

/** One session discovered on disk, before it is mapped to ProviderSession. */
interface KimiSession {
  id: string;
  dir: string;
  state: Record<string, unknown> | null;
  index: Record<string, unknown> | null;
}

/** Session id candidates used by the Kimi index and state files. */
const ID_KEYS = ["id", "sessionId", "session_id"];

/** Timestamp candidates used by Kimi's state and index records. */
const CREATED_KEYS = ["createdAt", "created_at", "startedAt", "started_at"];
const UPDATED_KEYS = [
  "lastActivity",
  "last_activity",
  "updatedAt",
  "updated_at",
  "lastUpdate",
];

function firstOf(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function sessionIdOf(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  for (const key of ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Read every session record from the NDJSON index, tolerating blank / bad lines. */
function readIndex(): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  let text: string;
  try {
    text = fs.readFileSync(kimiIndexPath(), "utf-8");
  } catch {
    return records;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value = JSON.parse(trimmed);
      if (asRecord(value)) records.push(value);
    } catch {
      // Malformed line: skip it, keep the rest of the index.
    }
  }
  return records;
}

/** Session ids whose owning client still holds an occupancy lock. */
function lockedSessionIds(): Set<string> {
  const running = new Set<string>();
  for (const entry of listDirectories(kimiLocksDir())) {
    const id = path.basename(entry);
    if (id.length > 0) running.add(id);
  }
  return running;
}

/** Discover every session directory under sessions/<workDirKey>/<sessionId>/. */
function discoverSessions(): KimiSession[] {
  const found: KimiSession[] = [];
  const sessionsDir = kimiSessionsDir();
  if (!isDirectory(sessionsDir)) return found;
  const indexById = new Map<string, Record<string, unknown>>();
  for (const record of readIndex()) {
    const id = sessionIdOf(record);
    if (id) indexById.set(id, record);
  }
  for (const workDir of listDirectories(sessionsDir)) {
    for (const sessionDir of listDirectories(workDir)) {
      const id = path.basename(sessionDir);
      if (id.length === 0) continue;
      const state = asRecord(readJson(path.join(sessionDir, "state.json")));
      found.push({
        id,
        dir: sessionDir,
        state,
        index: indexById.get(id) ?? null,
      });
    }
  }
  return found;
}

function mapSession(session: KimiSession, running: Set<string>): ProviderSession {
  const { state, index } = session;
  const title =
    asString(firstOf(state, ["title"])) ??
    asString(firstOf(index, ["title"])) ??
    null;
  const cwd = asString(firstOf(index, ["cwd", "workDir", "directory"]));
  const createdAt = toIso(
    firstOf(state, CREATED_KEYS) ?? firstOf(index, CREATED_KEYS),
  );
  const updatedAt =
    toIso(firstOf(state, UPDATED_KEYS) ?? firstOf(index, UPDATED_KEYS)) ??
    modifiedAt(session.dir);
  return {
    id: session.id,
    title,
    cwd,
    createdAt,
    updatedAt,
    sizeBytes: directorySize(session.dir),
    running: running.has(session.id),
  };
}

async function list(): Promise<ProviderListResult> {
  const sessionsDir = kimiSessionsDir();
  const running = lockedSessionIds();
  const sessions = discoverSessions().map((session) => mapSession(session, running));
  return {
    sessions,
    detected: isDirectory(sessionsDir),
    detail: sessionsDir,
    deletable: true,
    storeBytes: kimiStoreBytes(),
    error: null,
  };
}

/** Deletes the session directory and its index entry. */
async function deleteMany(ids: string[]): Promise<ProviderDeleteResult> {
  const deleted: string[] = [];
  const failures: { id: string; error: string }[] = [];
  const sessionsDir = kimiSessionsDir();

  // Locate each session's directory by scanning sessions/*/<id>/.
  const byId = new Map<string, string>();
  if (isDirectory(sessionsDir)) {
    for (const workDir of listDirectories(sessionsDir)) {
      for (const sessionDir of listDirectories(workDir)) {
        const id = path.basename(sessionDir);
        if (id.length > 0 && !byId.has(id)) byId.set(id, sessionDir);
      }
    }
  }

  for (const id of ids) {
    const dir = byId.get(id);
    if (!dir || !isDirectory(dir)) {
      failures.push({ id, error: "session directory not found" });
      continue;
    }
    try {
      removePath(dir);
      deleted.push(id);
    } catch (error) {
      failures.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Drop the deleted sessions from the NDJSON index so the store stays tidy.
  try {
    await pruneIndex(ids);
  } catch {
    // Index pruning is best effort: the directory removal already decided.
  }

  return { deleted, failures };
}

/** Rewrites session_index.jsonl without the given ids (best effort). */
async function pruneIndex(ids: string[]): Promise<void> {
  const targets = new Set(ids);
  const kept: string[] = [];
  let text: string;
  try {
    text = fs.readFileSync(kimiIndexPath(), "utf-8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      kept.push(line);
      continue;
    }
    let drop = false;
    try {
      const value = JSON.parse(trimmed);
      const id = sessionIdOf(asRecord(value));
      if (id && targets.has(id)) drop = true;
    } catch {
      // Keep unparseable lines untouched.
    }
    if (!drop) kept.push(trimmed);
  }
  fs.writeFileSync(
    kimiIndexPath(),
    kept.join("\n") + (kept.length > 0 ? "\n" : ""),
    "utf-8",
  );
}

/** Kimi exports a session as a ZIP through its own CLI. */
async function exportSession(input: {
  id: string;
  outPath: string;
}): Promise<ProviderExportResult> {
  const binary = resolveBinary("kimi");
  if (!binary) {
    return { ok: false, error: "CLI \"kimi\" not found; cannot export" };
  }
  const result = await runCli(binary, ["export", input.id, "-o", input.outPath], {
    timeoutMs: 120_000,
  });
  if (!result.ok) return { ok: false, error: result.error ?? "export failed" };
  const bytes = fileSize(input.outPath);
  return bytes === null
    ? { ok: false, error: "kimi did not write the export file" }
    : { ok: true, bytes };
}

export const kimiProvider: ProviderAdapter = {
  id: "kimi",
  label: "Kimi Code",
  list,
  delete: deleteMany,
  exportSession,
  exportExtension: "zip",
};
