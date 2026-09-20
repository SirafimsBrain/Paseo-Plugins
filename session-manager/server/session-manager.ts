import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ACPX_SESSIONS_DIR = path.join(os.homedir(), ".acpx", "sessions");
const INDEX_FILE = path.join(ACPX_SESSIONS_DIR, "index.json");

interface AcpIndexEntry {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  closed: boolean;
  lastUsedAt: string;
}

interface AcpIndex {
  entries: AcpIndexEntry[];
}

function readIndex(): AcpIndex {
  try {
    const raw = fs.readFileSync(INDEX_FILE, "utf-8");
    return JSON.parse(raw) as AcpIndex;
  } catch {
    return { entries: [] };
  }
}

function writeIndex(index: AcpIndex): void {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

function readSessionMeta(filename: string): {
  createdAt: string;
  name: string | null;
} {
  try {
    const raw = fs.readFileSync(path.join(ACPX_SESSIONS_DIR, filename), "utf-8");
    const data = JSON.parse(raw);
    return {
      createdAt: data.created_at ?? "",
      name: data.name ?? null,
    };
  } catch {
    return { createdAt: "", name: null };
  }
}

export async function listAcpSessions() {
  const index = readIndex();
  const sessions = index.entries.map((entry) => {
    const meta = readSessionMeta(entry.file);
    const streamFile = entry.file.replace(/\.json$/, ".stream.ndjson");
    const streamExists = fs.existsSync(path.join(ACPX_SESSIONS_DIR, streamFile));

    return {
      id: entry.acpxRecordId,
      name: entry.name ?? meta.name,
      cwd: entry.cwd,
      agentCommand: entry.agentCommand,
      closed: entry.closed,
      createdAt: meta.createdAt,
      lastUsedAt: entry.lastUsedAt,
      streamExists,
    };
  });

  return { sessions };
}

export async function deleteAcpSession(input: { id: string }) {
  const index = readIndex();
  const entry = index.entries.find((e) => e.acpxRecordId === input.id);
  if (!entry) {
    return { deleted: false };
  }

  const jsonPath = path.join(ACPX_SESSIONS_DIR, entry.file);
  const streamFile = entry.file.replace(/\.json$/, ".stream.ndjson");
  const streamPath = path.join(ACPX_SESSIONS_DIR, streamFile);

  try {
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    if (fs.existsSync(streamPath)) fs.unlinkSync(streamPath);
  } catch {
    return { deleted: false };
  }

  index.entries = index.entries.filter((e) => e.acpxRecordId !== input.id);
  writeIndex(index);

  return { deleted: true };
}

export async function deleteAcpSessionsBatch(input: { ids: string[] }) {
  const index = readIndex();
  let deleted = 0;

  for (const id of input.ids) {
    const entry = index.entries.find((e) => e.acpxRecordId === id);
    if (!entry) continue;

    const jsonPath = path.join(ACPX_SESSIONS_DIR, entry.file);
    const streamFile = entry.file.replace(/\.json$/, ".stream.ndjson");
    const streamPath = path.join(ACPX_SESSIONS_DIR, streamFile);

    try {
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      if (fs.existsSync(streamPath)) fs.unlinkSync(streamPath);
      deleted++;
    } catch {
      // skip failed deletions
    }
  }

  index.entries = index.entries.filter((e) => !input.ids.includes(e.acpxRecordId));
  writeIndex(index);

  return { deleted };
}
