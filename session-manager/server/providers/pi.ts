import * as fs from "node:fs";
import * as path from "node:path";
import {
  asRecord,
  asString,
  fileSize,
  firstLine,
  homeDir,
  isDirectory,
  isFile,
  listDirectories,
  listFiles,
  modifiedAt,
  pathSize,
  readPrefix,
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
 * Pi (`@earendil-works/pi-coding-agent`) keeps everything under its agent
 * directory — `$PI_CODING_AGENT_DIR`, default `~/.pi/agent` — and stores each
 * session as one NDJSON transcript:
 *
 *   <agent dir>/sessions/<--sanitized-cwd-->/<timestamp>_<sessionId>.jsonl
 *
 * The directory name is the session's working directory with the leading slash
 * removed and `/` and `:` replaced by `-` (`/home/ana` → `--home-ana--`). A
 * custom `--session-dir` / `$PI_CODING_AGENT_SESSION_DIR` drops the transcript
 * straight into that directory instead of a per-cwd subdirectory, so both
 * layouts are scanned.
 *
 * The first line of the file is the session header:
 *   `{"type":"session","version":3,"id":"<uuid>","timestamp":"<iso>","cwd":"…"}`
 * followed by entries (`message`, `session_info`, `model_change`, `compaction`,
 * …). The session id lives in that header, not in the file name.
 *
 * Pi has no `session list` / `session delete` command, so listing and deletion
 * read the store directly. Only export goes through the vendor CLI
 * (`pi --export <file> <output>`, which renders the transcript as HTML).
 */

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/** The header is the first entry, so a small prefix is enough to read it. */
const HEADER_SCAN_BYTES = 16_384;
/** `session_info` entries are appended, so the session name is at the end. */
const TAIL_SCAN_BYTES = 65_536;

export function piAgentDir(): string {
  const override = (process.env[AGENT_DIR_ENV] ?? "").trim();
  return override.length > 0 ? override : path.join(homeDir(), ".pi", "agent");
}

export function piSessionsDir(): string {
  const override = (process.env[SESSION_DIR_ENV] ?? "").trim();
  return override.length > 0 ? override : path.join(piAgentDir(), "sessions");
}

/** Size of the session store only; the agent dir also holds binaries and skills. */
export function piStoreBytes(): number | null {
  return pathSize(piSessionsDir());
}

function parseEntry(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    // Pi tolerates unparseable lines the same way: skip and keep reading.
    return null;
  }
}

/** Reads the last `bytes` of a file, for entries Pi appends as the session grows. */
function readSuffix(target: string, bytes: number): string | null {
  let handle: number | null = null;
  try {
    handle = fs.openSync(target, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // ignore
      }
    }
  }
}

interface PiHeader {
  id: string | null;
  cwd: string | null;
  createdAt: string | null;
}

/** Finds the `session` header entry in the leading part of the transcript. */
function readHeader(file: string): PiHeader {
  const prefix = readPrefix(file, HEADER_SCAN_BYTES);
  if (prefix) {
    for (const line of prefix.split("\n")) {
      const entry = parseEntry(line);
      if (!entry) continue;
      if (entry["type"] !== "session") continue;
      return {
        id: asString(entry["id"]),
        cwd: asString(entry["cwd"]),
        createdAt: toIso(entry["timestamp"]),
      };
    }
  }
  return { id: null, cwd: null, createdAt: null };
}

/** Text of a Pi message: a plain string, or the `text` blocks of a content array. */
function messageText(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message["content"];
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const text = asString(asRecord(block)?.["text"]);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Session name: Pi's own `--name` / `/name` writes a `session_info` entry, so
 * the last one wins. Without a name the first user message is the best title,
 * which is what Pi's own session picker shows.
 */
function readTitle(file: string): string | null {
  const tail = readSuffix(file, TAIL_SCAN_BYTES);
  if (tail) {
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseEntry(lines[index] as string);
      if (!entry || entry["type"] !== "session_info") continue;
      const name = asString(entry["name"])?.trim();
      if (name) return firstLine(name, 90);
    }
  }

  const prefix = readPrefix(file, HEADER_SCAN_BYTES);
  if (!prefix) return null;
  for (const line of prefix.split("\n")) {
    const entry = parseEntry(line);
    if (!entry || entry["type"] !== "message") continue;
    const message = asRecord(entry["message"]);
    if (message?.["role"] !== "user") continue;
    const title = firstLine(messageText(message), 90);
    if (title) return title;
  }
  return null;
}

/** Every transcript file of the store, in both supported layouts. */
function transcriptFiles(): string[] {
  const root = piSessionsDir();
  const files = listFiles(root, ".jsonl");
  for (const dir of listDirectories(root)) {
    files.push(...listFiles(dir, ".jsonl"));
  }
  return files;
}

interface PiTranscript {
  file: string;
  id: string;
  cwd: string | null;
  createdAt: string | null;
}

/**
 * Maps every transcript to its header. Files without a `session` header are
 * skipped, exactly like Pi's own session discovery, because Pi cannot open them
 * either.
 */
function discoverTranscripts(): PiTranscript[] {
  const found: PiTranscript[] = [];
  for (const file of transcriptFiles()) {
    const header = readHeader(file);
    if (!header.id) continue;
    found.push({ file, id: header.id, cwd: header.cwd, createdAt: header.createdAt });
  }
  return found;
}

async function list(): Promise<ProviderListResult> {
  const root = piSessionsDir();
  const sessions: ProviderSession[] = discoverTranscripts().map((transcript) => ({
    id: transcript.id,
    title: readTitle(transcript.file),
    cwd: transcript.cwd,
    createdAt: transcript.createdAt,
    updatedAt: modifiedAt(transcript.file),
    sizeBytes: fileSize(transcript.file),
    // Pi takes no per-session occupancy marker, so a session cannot be proven
    // running from disk; the Paseo agent reference is the only live guard.
    running: false,
  }));

  return {
    sessions,
    detected: isDirectory(root),
    detail: root,
    deletable: true,
    storeBytes: piStoreBytes(),
    error: null,
  };
}

/** Deletes the transcript file; that file is the session as far as Pi is concerned. */
async function deleteMany(ids: string[]): Promise<ProviderDeleteResult> {
  const deleted: string[] = [];
  const failures: { id: string; error: string }[] = [];
  const byId = new Map<string, string>();
  for (const transcript of discoverTranscripts()) {
    if (!byId.has(transcript.id)) byId.set(transcript.id, transcript.file);
  }

  for (const id of ids) {
    const file = byId.get(id);
    if (!file || !isFile(file)) {
      failures.push({ id, error: "session transcript not found" });
      continue;
    }
    if (removePath(file) && !isFile(file)) {
      deleted.push(id);
    } else {
      failures.push({ id, error: "failed to remove the session transcript" });
    }
  }

  return { deleted, failures };
}

/** Renders the session as a standalone HTML file through Pi's own `--export`. */
async function exportSession(input: {
  id: string;
  outPath: string;
}): Promise<ProviderExportResult> {
  const transcript = discoverTranscripts().find((entry) => entry.id === input.id);
  if (!transcript) return { ok: false, error: "session transcript not found" };

  const binary = resolveBinary("pi");
  if (!binary) {
    return { ok: false, error: 'CLI "pi" not found; cannot export' };
  }

  const result = await runCli(binary, ["--export", transcript.file, input.outPath], {
    timeoutMs: 120_000,
  });
  if (!result.ok) return { ok: false, error: result.error ?? "export failed" };
  const bytes = fileSize(input.outPath);
  return bytes === null
    ? { ok: false, error: "pi did not write the export file" }
    : { ok: true, bytes };
}

export const piProvider: ProviderAdapter = {
  id: "pi",
  label: "Pi",
  list,
  delete: deleteMany,
  exportSession,
  exportExtension: "html",
};
