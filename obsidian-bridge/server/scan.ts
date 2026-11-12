import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseNote } from "./parse";
import type { BridgeStore } from "./store";
import type { RuntimeSettings } from "../shared/settings";
import { MAX_NOTE_BYTES, walkMarkdown } from "./vault";

/**
 * One reconciliation pass over the vault.
 *
 * Used by the plugin's indexer (initial scan, periodic reconcile, watch
 * batches) and by the `obsidian_index` tool, so both paths produce exactly the
 * same index. `force` re-parses every file; otherwise a file is skipped when
 * its mtime and size still match the stored row.
 */

export interface ScanOutcome {
  notes: number;
  chunks: number;
  scanned: number;
  removed: number;
  tookMs: number;
  capped: boolean;
}

export function scanVault(input: {
  root: string;
  store: BridgeStore;
  settings: RuntimeSettings;
  force?: boolean;
  log?: (message: string) => void;
}): ScanOutcome {
  const startedAt = Date.now();
  const { root, store, settings } = input;
  const walk = walkMarkdown(root, {
    includeFolders: settings.includeFolders,
    excludeGlobs: settings.excludeGlobs,
  });
  const seen = new Set<string>();
  let scanned = 0;

  for (const relPath of walk.files) {
    const absolute = path.join(root, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) continue;
    seen.add(relPath);

    if (!input.force) {
      const existing = store.noteFile(relPath);
      if (existing && existing.mtime_ms === stat.mtimeMs && existing.size === stat.size) {
        continue;
      }
    }

    let text: string;
    try {
      text = fs.readFileSync(absolute, "utf-8");
    } catch (cause) {
      input.log?.(
        `unreadable note ${relPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      continue;
    }

    const parsed = parseNote(text, relPath);
    store.upsertNote({
      relPath,
      parsed,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: crypto.createHash("sha1").update(text).digest("hex"),
    });
    scanned += 1;
  }

  let removed = 0;
  for (const row of store.listNoteFiles()) {
    if (seen.has(row.path)) continue;
    store.deleteNote(row.path);
    removed += 1;
  }

  store.resolveLinks();
  store.setMeta("last_scan_ms", String(Date.now()));
  const counts = store.counts();
  return {
    notes: counts.notes,
    chunks: counts.chunks,
    scanned,
    removed,
    tookMs: Date.now() - startedAt,
    capped: walk.capped,
  };
}
