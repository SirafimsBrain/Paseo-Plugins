import * as path from "node:path";
import {
  asRecord,
  asString,
  exists,
  fileSize,
  homeDir,
  listFiles,
  readJson,
  removePath,
  toIso,
  writeJsonAtomic,
} from "../util";
import type {
  ProviderAdapter,
  ProviderDeleteResult,
  ProviderListResult,
  ProviderSession,
} from "./types";

const SESSION_INDEX_SCHEMA = "acpx.session-index.v1";

/**
 * `acpx` is a standalone ACP client (`npm i -g acpx`, openclaw/acpx) that keeps
 * its own record store under `~/.acpx/sessions`. This adapter manages that
 * store; Paseo itself does not use it, so it is kept for parity with real ACP
 * transcripts written by the acpx CLI.
 */
export function acpxSessionsDir(): string {
  const override = process.env.ACPX_HOME;
  const base = override && override.trim().length > 0 ? override : path.join(homeDir(), ".acpx");
  return path.join(base, "sessions");
}

function indexPath(): string {
  return path.join(acpxSessionsDir(), "index.json");
}

interface IndexEntry {
  file: string;
  acpxRecordId: string;
  acpSessionId?: string;
  agentCommand?: string;
  cwd?: string;
  name?: string | null;
  closed?: boolean;
  lastUsedAt?: string;
}

interface SessionIndex {
  schema: string;
  files: string[];
  entries: IndexEntry[];
}

function readIndex(): SessionIndex | null {
  const record = asRecord(readJson(indexPath()));
  if (!record) return null;
  const files = Array.isArray(record["files"])
    ? record["files"].filter((file): file is string => typeof file === "string")
    : null;
  const rawEntries = Array.isArray(record["entries"]) ? record["entries"] : null;
  if (!files || !rawEntries) return null;
  const entries: IndexEntry[] = [];
  for (const raw of rawEntries) {
    const entry = asRecord(raw);
    const file = asString(entry?.["file"]);
    const id = asString(entry?.["acpxRecordId"]);
    if (!file || !id) continue;
    entries.push({
      file,
      acpxRecordId: id,
      acpSessionId: asString(entry?.["acpSessionId"]) ?? undefined,
      agentCommand: asString(entry?.["agentCommand"]) ?? undefined,
      cwd: asString(entry?.["cwd"]) ?? undefined,
      name: asString(entry?.["name"]),
      closed: entry?.["closed"] === true,
      lastUsedAt: asString(entry?.["lastUsedAt"]) ?? undefined,
    });
  }
  return { schema: SESSION_INDEX_SCHEMA, files, entries };
}

/** Rebuilds the index from the record files on disk, the way acpx itself does. */
function scanRecords(): IndexEntry[] {
  const dir = acpxSessionsDir();
  const entries: IndexEntry[] = [];
  for (const file of listFiles(dir, ".json")) {
    if (path.basename(file) === "index.json") continue;
    const record = asRecord(readJson(file));
    const id = asString(record?.["acpx_record_id"]) ?? path.basename(file, ".json");
    entries.push({
      file: path.basename(file),
      acpxRecordId: id,
      acpSessionId: asString(record?.["acp_session_id"]) ?? undefined,
      agentCommand: asString(record?.["agent_command"]) ?? undefined,
      cwd: asString(record?.["cwd"]) ?? undefined,
      name: null,
      closed: record?.["closed"] === true,
      lastUsedAt: asString(record?.["last_used_at"]) ?? undefined,
    });
  }
  return entries;
}

function streamFileFor(file: string): string {
  return file.replace(/\.json$/, ".stream.ndjson");
}

function toSession(entry: IndexEntry): ProviderSession {
  const dir = acpxSessionsDir();
  const json = path.join(dir, entry.file);
  const stream = path.join(dir, streamFileFor(entry.file));
  const size =
    (fileSize(json) ?? 0) + (fileSize(stream) ?? 0) || null;
  return {
    id: entry.acpxRecordId,
    title: entry.name ?? null,
    cwd: entry.cwd ?? null,
    createdAt: null,
    updatedAt: toIso(entry.lastUsedAt),
    sizeBytes: size,
    // acpx closes a record when the agent disconnects; an open record means
    // the acpx queue owner may still be running it.
    running: entry.closed === false,
  };
}

async function list(): Promise<ProviderListResult> {
  const dir = acpxSessionsDir();
  if (!exists(dir)) {
    return { sessions: [], detected: false, detail: dir, deletable: true, error: null };
  }
  const index = readIndex();
  const entries = index ? index.entries : scanRecords();
  return {
    sessions: entries.map(toSession),
    detected: true,
    detail: indexPath(),
    deletable: true,
    error: null,
  };
}

function writeIndexAfterDelete(removed: string[]): void {
  const dir = acpxSessionsDir();
  const remainingEntries = (readIndex()?.entries ?? scanRecords()).filter(
    (entry) => !removed.includes(entry.acpxRecordId),
  );
  const files = listFiles(dir, ".json")
    .map((file) => path.basename(file))
    .filter((name) => name !== "index.json")
    .sort();
  const payload: SessionIndex = {
    schema: SESSION_INDEX_SCHEMA,
    files,
    entries: remainingEntries,
  };
  writeJsonAtomic(indexPath(), payload);
}

async function deleteMany(ids: string[]): Promise<ProviderDeleteResult> {
  const dir = acpxSessionsDir();
  const entries = readIndex()?.entries ?? scanRecords();
  const deleted: string[] = [];
  const failures: { id: string; error: string }[] = [];

  for (const id of ids) {
    const entry = entries.find((candidate) => candidate.acpxRecordId === id);
    if (!entry) {
      failures.push({ id, error: "session record not found" });
      continue;
    }
    const json = path.join(dir, entry.file);
    const stream = path.join(dir, streamFileFor(entry.file));
    const removedJson = exists(json) ? removePath(json) : true;
    const removedStream = exists(stream) ? removePath(stream) : true;
    if (removedJson && removedStream) {
      deleted.push(id);
    } else {
      failures.push({ id, error: "failed to remove session files" });
    }
  }

  if (deleted.length > 0) {
    try {
      writeIndexAfterDelete(deleted);
    } catch (error) {
      return {
        deleted,
        failures: [
          ...failures,
          ...deleted.map((id) => ({
            id,
            error: `files removed but index update failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })),
        ],
      };
    }
  }

  return { deleted, failures };
}

export const acpxProvider: ProviderAdapter = {
  id: "acpx",
  label: "acpx (ACP CLI)",
  list,
  delete: deleteMany,
};
