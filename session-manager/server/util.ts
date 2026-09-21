import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Home directory of the daemon user, resolved per call so tests can override HOME. */
export function homeDir(): string {
  return os.homedir();
}

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured
    : path.join(homeDir(), ".paseo");
}

export function exists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

export function listDirectories(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export function listFiles(root: string, extension?: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => (extension ? name.endsWith(extension) : true))
      .map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

export function readJson(target: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(target, "utf-8"));
  } catch {
    return null;
  }
}

/** Best-effort recursive size, bounded so a huge tree cannot stall the handler. */
export function directorySize(target: string, maxEntries = 20_000): number {
  let total = 0;
  let visited = 0;
  const stack: string[] = [target];
  while (stack.length > 0 && visited < maxEntries) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Unreadable file: ignore for sizing.
        }
      }
    }
  }
  return total;
}

export function fileSize(target: string): number | null {
  try {
    return fs.statSync(target).size;
  } catch {
    return null;
  }
}

/** Size of a file or of a directory tree; null when the path does not exist at all. */
export function pathSize(target: string): number | null {
  if (isFile(target)) return fileSize(target);
  if (isDirectory(target)) return directorySize(target);
  return null;
}

/**
 * SQLite spreads a store over `<db>`, `<db>-wal` and `<db>-shm`, so the size of
 * a database-backed session store is the sum of the three. Returns null when the
 * whole group is missing, which is how an installed-but-never-used CLI looks.
 */
export function sqliteSize(dbPath: string): number | null {
  const parts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => fileSize(file) ?? 0);
  const total = parts.reduce((sum, value) => sum + value, 0);
  return total > 0 ? total : null;
}

export function modifiedAt(target: string): string | null {
  try {
    return fs.statSync(target).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Accepts epoch milliseconds, epoch seconds, ISO strings, and Date values. */
export function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** Reads at most `bytes` of a file; used to peek at NDJSON/JSONL session headers. */
export function readPrefix(target: string, bytes = 8192): string | null {
  let handle: number | null = null;
  try {
    handle = fs.openSync(target, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf-8");
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

export function firstLine(text: unknown, maxLength = 80): string | null {
  if (typeof text !== "string") return null;
  const line = text
    .replace(/<user_input[^>]*>/gi, "")
    .replace(/<\/user_input>/gi, "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function removePath(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Turns an arbitrary session id into a safe single-segment file name. */
export function safeFileSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "session";
}

/** Writes JSON through a temp file + rename so readers never observe a partial index. */
export function writeJsonAtomic(target: string, value: unknown, space = 2): void {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, space)}\n`, "utf-8");
  fs.renameSync(temp, target);
}
