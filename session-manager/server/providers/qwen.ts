import * as fs from "node:fs";
import * as path from "node:path";
import {
  asRecord,
  asString,
  directorySize,
  fileSize,
  firstLine,
  homeDir,
  isDirectory,
  isFile,
  isProcessAlive,
  listDirectories,
  listFiles,
  modifiedAt,
  pathSize,
  readJson,
  readPrefix,
  toIso,
} from "../util";
import type {
  ProviderAdapter,
  ProviderDeleteResult,
  ProviderExportResult,
  ProviderListResult,
  ProviderSession,
} from "./types";

/**
 * Qwen Code has `qwen sessions list` but no delete command, so transcripts are
 * deleted from `~/.qwen/projects/<project>/chats/<sessionId>.jsonl`. That file
 * is exactly what `--resume`/`--continue` reads, so removing it removes the
 * session from Qwen's own history.
 */
export function qwenHome(): string {
  const override = process.env.QWEN_HOME;
  return override && override.trim().length > 0 ? override : path.join(homeDir(), ".qwen");
}

export function qwenProjectsDir(): string {
  return path.join(qwenHome(), "projects");
}

/**
 * Files and directories Qwen names after the session id and that belong to that
 * session only:
 *
 * - `plans/<id>.md` — the plan the agent wrote for the session.
 * - `todos/<id>.json` — the todo list of the session.
 * - `file-history/<id>/` — per-file snapshots used by the "restore file" flow.
 *   The directory name is the session id (verified against `chats/<id>.jsonl`
 *   on a live store), and Qwen itself cleans the tree up with
 *   `~/.qwen/.file-history-cleanup`. This plugin leaves it alone only if the
 *   directory is missing.
 * - `sessions/<pid>.json` is a runtime registry entry, not session state, so it
 *   is never deleted here.
 */
export function qwenSidecarPaths(id: string): string[] {
  const home = qwenHome();
  return [
    path.join(home, "plans", `${id}.md`),
    path.join(home, "todos", `${id}.json`),
    path.join(home, "file-history", id),
  ];
}

/** Transcript plus every sidecar, so the row size matches what delete frees. */
function sizeOfSession(id: string, transcript: string): number {
  let total = fileSize(transcript) ?? 0;
  for (const sidecar of qwenSidecarPaths(id)) {
    if (isDirectory(sidecar)) {
      total += directorySize(sidecar);
    } else {
      total += fileSize(sidecar) ?? 0;
    }
  }
  return total;
}

/** Total size of `~/.qwen`, the store this adapter reads and writes. */
export function qwenStoreBytes(): number | null {
  return pathSize(qwenHome());
}

/** Session ids whose owning process is still alive, from `~/.qwen/sessions`. */
function runningSessionIds(): Set<string> {
  const running = new Set<string>();
  const dir = path.join(qwenHome(), "sessions");
  for (const file of listFiles(dir, ".json")) {
    const record = asRecord(readJson(file));
    if (!record) continue;
    const sessionId = asString(record["sessionId"]);
    const pid = typeof record["pid"] === "number" ? record["pid"] : Number(record["pid"]);
    if (sessionId && Number.isFinite(pid) && isProcessAlive(pid)) {
      running.add(sessionId);
    }
  }
  return running;
}

function firstRecord(file: string): Record<string, unknown> | null {
  const prefix = readPrefix(file, 16_384);
  if (!prefix) return null;
  const firstLineText = prefix.split("\n")[0];
  if (!firstLineText) return null;
  try {
    return asRecord(JSON.parse(firstLineText));
  } catch {
    return null;
  }
}

function titleFromRecord(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  const message = asRecord(record["message"]);
  const parts = message?.["parts"];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const text = asString(asRecord(part)?.["text"]);
      const line = firstLine(text, 90);
      if (line) return line;
    }
  }
  return firstLine(record["prompt"], 90);
}

async function list(): Promise<ProviderListResult> {
  const root = qwenProjectsDir();
  const running = runningSessionIds();
  const sessions: ProviderSession[] = [];

  for (const projectDir of listDirectories(root)) {
    const chatsDir = path.join(projectDir, "chats");
    for (const file of listFiles(chatsDir, ".jsonl")) {
      const id = path.basename(file, ".jsonl");
      const record = firstRecord(file);
      sessions.push({
        id,
        title: titleFromRecord(record),
        cwd: asString(record?.["cwd"]),
        createdAt: toIso(record?.["timestamp"] ?? record?.["startTime"]),
        updatedAt: modifiedAt(file),
        sizeBytes: sizeOfSession(id, file),
        running: running.has(id),
      });
    }
  }

  return {
    sessions,
    detected: isDirectory(root),
    detail: root,
    deletable: true,
    storeBytes: qwenStoreBytes(),
    error: null,
  };
}

/** Deletes the transcript first: without it the session is gone for Qwen. */
async function deleteMany(ids: string[]): Promise<ProviderDeleteResult> {
  const deleted: string[] = [];
  const failures: { id: string; error: string }[] = [];
  const root = qwenProjectsDir();

  for (const id of ids) {
    // The registry entry of a live session would resurrect the transcript on the
    // next write, so deleting it belongs to the guards, not to this adapter.
    const target = findTranscript(root, id);
    if (!target) {
      failures.push({ id, error: "transcript file not found" });
      continue;
    }
    try {
      fs.rmSync(target, { force: true });
      for (const sidecar of qwenSidecarPaths(id)) {
        try {
          fs.rmSync(sidecar, { recursive: true, force: true });
        } catch {
          // Sidecars are best effort: the transcript already decided the outcome.
        }
      }
      deleted.push(id);
    } catch (error) {
      failures.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { deleted, failures };
}

/** Qwen has no export command, so the raw transcript is copied out as-is. */
async function exportSession(input: {
  id: string;
  outPath: string;
}): Promise<ProviderExportResult> {
  const target = findTranscript(qwenProjectsDir(), input.id);
  if (!target) return { ok: false, error: "transcript file not found" };
  try {
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
    fs.copyFileSync(target, input.outPath);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const bytes = fileSize(input.outPath);
  return bytes === null ? { ok: false, error: "export file not written" } : { ok: true, bytes };
}

function findTranscript(root: string, id: string): string | null {
  for (const projectDir of listDirectories(root)) {
    const candidate = path.join(projectDir, "chats", `${id}.jsonl`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export const qwenProvider: ProviderAdapter = {
  id: "qwen-code",
  label: "Qwen Code",
  list,
  delete: deleteMany,
  exportSession,
  exportExtension: "jsonl",
};
