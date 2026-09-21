import * as path from "node:path";
import { asString, firstLine, homeDir, toIso } from "../util";
import { createCliProvider } from "./cli";
import type { ProviderSession } from "./types";

/**
 * OpenCode 1.18+ stores sessions in `opencode.db` (project data directory).
 * The plugin deliberately uses `opencode session list/delete` instead of
 * touching that database, so schema changes cannot corrupt agent state.
 */
export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base =
    xdg && xdg.trim().length > 0 ? xdg : path.join(homeDir(), ".local", "share");
  return path.join(base, "opencode");
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
  storePath: () => path.join(opencodeDataDir(), "opencode.db"),
  listArgs: (limit) => ["session", "list", "--format", "json", "--max-count", String(limit)],
  parseRow,
  deleteArgs: (id) => ["session", "delete", id],
});
