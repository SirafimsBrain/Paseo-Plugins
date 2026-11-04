/**
 * Project export — the server half of stage L2 (`__doc.md` §6).
 *
 * `shared/export.ts` owns the document: its envelope, its serializer and the
 * names. This module owns the things a shared module may not touch — the
 * store read, the zip container and the filesystem. Kept apart on purpose:
 * the dashboard already imports `shared/`, and a `node:fs` import there would
 * either break the browser build or drag Node types into it.
 *
 * Two surfaces consume it, and they must agree on the bytes:
 * - the MCP tool `luck_tree_export` (agents, writes a file, answers counts);
 * - `GET /api/export` (the dashboard's download link, streams the same zip).
 * Both call {@link buildExportDocument} and {@link exportZipBytes}, so a file
 * an agent writes and a file the tab downloads are the same document.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  EXPORT_FILE_EXTENSION,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  exportEntryName,
  exportFileName,
  serializeExport,
  type ExportDocument,
} from "../shared/export";
import type { LuckPlannerStore } from "./store";

/** What an export needs from the caller; the rest is provenance. */
export interface ExportRequest {
  /** Canonical project key (ADR-2). */
  readonly projectKey: string;
  /** Plugin version stamped into the envelope. */
  readonly pluginVersion: string;
  /** Epoch milliseconds; defaults to now. Tests pin it for determinism. */
  readonly exportedAt?: number;
  /** Include the project's audit trail (default `true`). */
  readonly includeHistory?: boolean;
}

/** A request that also says where the file goes. */
export interface ExportFileRequest extends ExportRequest {
  /** Directory for the generated name; defaults to `backups/` next to the DB. */
  readonly dir?: string;
  /** Full path, absolute; wins over `dir` and the generated name. */
  readonly file?: string;
}

/** Result of writing an export to disk. */
export interface ExportFileResult {
  /** Absolute path of the written archive. */
  readonly file: string;
  /** Size of the archive on disk. */
  readonly bytes: number;
  readonly document: ExportDocument;
}

/**
 * Reads one project into the portable document.
 *
 * Archived nodes travel with their `archivedAt` instead of being dropped: an
 * export is a description of the tree, and the importer is the layer that
 * decides what to do with soft-deleted rows. `generatedAt` is deliberately not
 * part of the envelope — `exportedAt` already is, and two timestamps for one
 * act invite disagreement.
 */
export function buildExportDocument(
  store: LuckPlannerStore,
  request: ExportRequest,
): ExportDocument {
  const includeHistory = request.includeHistory ?? true;
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    pluginVersion: request.pluginVersion,
    exportedAt: request.exportedAt ?? Date.now(),
    projectKey: request.projectKey,
    nodes: store.listNodes(request.projectKey, { includeArchived: true }),
    bees: store.listBees(request.projectKey),
    bugs: store.listBugs(request.projectKey),
    bugAttachments: store.listBugAttachments(request.projectKey),
    goals: store.listGoals(request.projectKey),
    growth: store.listGrowth(request.projectKey),
    ...(includeHistory
      ? { history: store.listProjectHistory(request.projectKey) }
      : {}),
  };
}

/**
 * Refuses an export of a project with no rows.
 *
 * An empty archive is a valid document and a useless one: in practice it
 * means the `projectKey` is a typo (an agent passing a display name, or a
 * workspace path that never got a tree). Both surfaces — the tool and the
 * download — say so instead of writing a file nobody can use.
 */
export function assertExportable(document: ExportDocument): void {
  if (document.nodes.length === 0) {
    throw new Error(
      `project ${document.projectKey} has no nodes to export — check the projectKey`,
    );
  }
}

/**
 * The archive bytes: one JSON entry named after the archive.
 *
 * `mtime` is pinned to the DOS epoch so the same document compresses to the
 * same bytes — the repo's determinism rule (a committed or compared artifact
 * must not change because a clock moved). Compression is maximum: prose
 * payloads are exactly what deflate is for.
 */
export function exportZipBytes(document: ExportDocument): Uint8Array {
  const name = exportEntryName(
    exportFileName(document.projectKey, document.exportedAt),
  );
  const bytes = strToU8(serializeExport(document));
  return zipSync({ [name]: [bytes, { mtime: new Date(1980, 0, 1) }] }, {
    level: 9,
  });
}

/**
 * Default output directory: `backups/` beside the database, inside the
 * plugin's own `$PASEO_HOME/plugins/luck-planner/` directory (ADR-2). It sits
 * next to the data it snapshots, survives plugin updates (the daemon keeps
 * that directory), and needs no new setting.
 */
export function defaultBackupDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), "backups");
}

/**
 * Writes the archive and answers where it landed.
 *
 * Refuses a relative `file` (the caller's working directory is not the user's
 * and a stray `export.zip` in a checkout is a surprise, not a feature) and
 * refuses to overwrite an existing path. A generated name that collides —
 * two exports within the same second — gets `-2`, `-3`, … rather than an
 * error: the user asked for one more backup, not for a naming argument.
 */
export function writeExportFile(
  store: LuckPlannerStore,
  request: ExportFileRequest,
): ExportFileResult {
  const document = buildExportDocument(store, request);
  assertExportable(document);
  const bytes = exportZipBytes(document);

  let file: string;
  if (request.file !== undefined) {
    if (!path.isAbsolute(request.file)) {
      throw new Error(`export path must be absolute: ${request.file}`);
    }
    if (existsSync(request.file)) {
      throw new Error(`refusing to overwrite an existing file: ${request.file}`);
    }
    file = request.file;
  } else {
    const dir = request.dir ?? defaultBackupDir(store.dbPath);
    mkdirSync(dir, { recursive: true });
    file = freeName(
      dir,
      exportFileName(request.projectKey, document.exportedAt),
      EXPORT_FILE_EXTENSION,
    );
  }

  const parent = path.dirname(file);
  mkdirSync(parent, { recursive: true });
  if (existsSync(file) && statSync(file).isDirectory()) {
    throw new Error(`export path is a directory: ${file}`);
  }
  writeFileSync(file, bytes);
  return { file, bytes: bytes.byteLength, document };
}

/** `dir/name-2.json.zip`, `dir/name-3.json.zip`, … — first free name.
 *
 * The suffix goes before the **whole** extension: an archive is
 * `<stamp>.json.zip`, and `path.extname` would produce the misleading
 * `<stamp>.json-2.zip` — a file that still opens, under a name that reads as
 * if the *JSON* were the second one. `compoundExtension` is what makes a
 * two-part suffix (`…-2.db.zip` for stage L3) resolve the same way.
 */
export function freeName(
  dir: string,
  name: string,
  compoundExtension: string,
): string {
  const candidate = path.join(dir, name);
  if (!existsSync(candidate)) return candidate;
  const extension = name.endsWith(compoundExtension)
    ? compoundExtension
    : path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 2; index < 1000; index += 1) {
    const next = path.join(dir, `${stem}-${index}${extension}`);
    if (!existsSync(next)) return next;
  }
  throw new Error(`no free file name for ${candidate}`);
}
