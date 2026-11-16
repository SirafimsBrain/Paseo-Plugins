import * as path from "node:path";
import { asRecord, asString, firstLine, homeDir, sqliteSize, toIso } from "../util";
import { createCliProvider } from "./cli";
import type { ProviderSession } from "./types";

/**
 * Kilo CLI is an OpenCode fork and keeps the same session commands with its
 * own `kilo.db` data directory.
 *
 * Like OpenCode, Kilo keeps the transcript in SQLite, so a row cannot report an
 * exact size; the panel shows the `kilo.db` store size instead.
 */
export function kiloDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base =
    xdg && xdg.trim().length > 0 ? xdg : path.join(homeDir(), ".local", "share");
  return path.join(base, "kilo");
}

export function kiloDatabasePath(): string {
  return path.join(kiloDataDir(), "kilo.db");
}

/**
 * Kilo prints a per-session `status` object (`{"type":"idle"}` on a finished
 * session). Anything other than `idle` means the session still has a live
 * runtime, so the delete guard must treat it as running; a missing `status`
 * keeps the old `false`, because guessing would block every delete.
 */
function runningFromStatus(row: Record<string, unknown>): boolean {
  const status = asRecord(row["status"]);
  const type = asString(status?.["type"]);
  return type !== null && type !== "idle";
}

function parseRow(row: Record<string, unknown>): ProviderSession | null {
  const id = asString(row["id"]);
  if (!id) return null;
  const title = asString(row["title"]);
  return {
    id,
    title: title && !/^new session/i.test(title) ? title : firstLine(title, 90),
    cwd: asString(row["directory"]),
    createdAt: toIso(row["created"]),
    updatedAt: toIso(row["updated"] ?? row["created"]),
    sizeBytes: null,
    running: runningFromStatus(row),
  };
}

export const kiloProvider = createCliProvider({
  id: "kilo",
  label: "Kilo",
  binary: "kilo",
  storePath: kiloDatabasePath,
  storeBytes: () => sqliteSize(kiloDatabasePath()),
  listArgs: (limit) => ["session", "list", "--format", "json", "--max-count", String(limit)],
  parseRow,
  deleteArgs: (id) => ["session", "delete", id],
  export: {
    kind: "stdout",
    extension: "json",
    args: (id) => ["export", id],
  },
  sqliteStores: () => [{ path: kiloDatabasePath(), label: "kilo.db" }],
});
