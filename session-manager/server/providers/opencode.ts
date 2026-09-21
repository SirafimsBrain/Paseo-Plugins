import * as path from "node:path";
import { asString, firstLine, homeDir, sqliteSize, toIso } from "../util";
import { createCliProvider } from "./cli";
import type { ProviderSession } from "./types";

/**
 * OpenCode 1.18+ stores sessions in `opencode.db` (project data directory).
 * The plugin deliberately uses `opencode session list/delete` instead of
 * touching that database, so schema changes cannot corrupt agent state.
 *
 * Per-session byte sizes are not available: the transcript lives in SQLite
 * tables, and the only session-named file (`storage/session_diff/<id>.json`)
 * is a small slice of it. Reporting that slice as the session size would
 * understate a multi-megabyte session, so rows report `sizeBytes: null` and the
 * panel shows the whole store size instead (`storeBytes`).
 */
export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base =
    xdg && xdg.trim().length > 0 ? xdg : path.join(homeDir(), ".local", "share");
  return path.join(base, "opencode");
}

export function opencodeDatabasePath(): string {
  return path.join(opencodeDataDir(), "opencode.db");
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
    running: false,
  };
}

export const opencodeProvider = createCliProvider({
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",
  storePath: opencodeDatabasePath,
  storeBytes: () => sqliteSize(opencodeDatabasePath()),
  listArgs: (limit) => ["session", "list", "--format", "json", "--max-count", String(limit)],
  parseRow,
  deleteArgs: (id) => ["session", "delete", id],
  export: {
    kind: "stdout",
    extension: "json",
    args: (id) => ["export", id],
  },
});
