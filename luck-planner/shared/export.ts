/**
 * Portable project export (PLAN.md stage L2, `__doc.md` §6).
 *
 * One project leaves the plugin as a single JSON document inside a zip: the
 * tree, its influence bees, incidents with their leaf attachments, goals,
 * growth records and — optionally — the audit trail. Client/server neutral
 * like every `shared/` module (no Node, no React, no DOM), so the same
 * serializer builds the file on the server, the HTTP endpoint streams it, and
 * tests can round-trip it without a filesystem.
 *
 * **The document is not a database backup.** Row ids travel with it, but a
 * restore cannot keep them: the store mints a fresh `randomUUID()` per node,
 * so import (stage L5) rebuilds the graph through a remap table. Carrying the
 * ids anyway is deliberate — it is what lets the import verify the graph's
 * internal references (parent, bee ends, bug attachments, goal leaves, growth
 * subject) before it writes anything.
 *
 * Why a zip rather than a bare `.json`: descriptions and plan/fact payloads
 * are prose, and a project with a few thousand leaves compresses by an order
 * of magnitude. `.zip` is the archive every desktop opens by double-click,
 * which is the difference between "a backup I can inspect" and "a blob".
 */

import { z } from "zod";
import { goalSchema } from "./goals";
import { growthSchema } from "./growth";
import { beeSchema, bugNodeSchema, bugSchema } from "./links";
import {
  historyEntrySchema,
  nodeSchema,
  projectKeySchema,
  timestampSchema,
  type Node,
} from "./tree";

/** Marker that tells an export apart from any other JSON file. */
export const EXPORT_FORMAT = "luck-planner-export";
/** Envelope version; an importer refuses anything it does not know. */
export const EXPORT_SCHEMA_VERSION = 1;
/** File suffix: the JSON is the payload, the zip is the container. */
export const EXPORT_FILE_EXTENSION = ".json.zip";
/** MIME type of the download (`GET /api/export`). */
export const EXPORT_CONTENT_TYPE = "application/zip";

/**
 * One project, in full. `nodes` includes **archived** rows with their
 * `archivedAt`: an export that silently dropped them could not reproduce the
 * tree it claims to describe, and the import is where "skip archived" belongs.
 *
 * `history` is optional because the audit trail can dwarf the graph and a
 * retention setting (`historyRetentionDays`) already bounds it. `exportedAt`
 * and `pluginVersion` are provenance: an import can warn about a file written
 * by a newer plugin instead of guessing.
 */
export const exportDocumentSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  /** Version of the plugin that produced the file. */
  pluginVersion: z.string().min(1),
  /** Epoch milliseconds of the export. */
  exportedAt: timestampSchema,
  projectKey: projectKeySchema,
  nodes: z.array(nodeSchema),
  bees: z.array(beeSchema),
  bugs: z.array(bugSchema),
  bugAttachments: z.array(bugNodeSchema),
  goals: z.array(goalSchema),
  growth: z.array(growthSchema),
  history: z.array(historyEntrySchema).optional(),
});

export type ExportDocument = z.infer<typeof exportDocumentSchema>;

/** Counts of an export, for a tool reply or a log line. */
export interface ExportCounts {
  readonly nodes: number;
  readonly archivedNodes: number;
  readonly bees: number;
  readonly bugs: number;
  readonly goals: number;
  readonly growth: number;
  /** `null` when the export carries no audit trail. */
  readonly history: number | null;
}

/** Counts of an export without walking it twice in the caller. */
export function exportCounts(doc: ExportDocument): ExportCounts {
  return {
    nodes: doc.nodes.length,
    archivedNodes: countArchived(doc.nodes),
    bees: doc.bees.length,
    bugs: doc.bugs.length,
    goals: doc.goals.length,
    growth: doc.growth.length,
    history: doc.history === undefined ? null : doc.history.length,
  };
}

/** How many of `nodes` are soft-deleted (still exported, flagged). */
export function countArchived(nodes: readonly Node[]): number {
  return nodes.reduce(
    (total, node) => (node.archivedAt === null ? total : total + 1),
    0,
  );
}

/**
 * The export as file-ready text: two-space JSON and a trailing newline, so
 * `git diff`, `jq` and every editor treat it as a text file.
 */
export function serializeExport(doc: ExportDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Parses an export, with the reason a file was rejected spelled out.
 *
 * The message names the failing field (`nodes.3.parentId`) instead of "invalid
 * input": the reader of a bad export is a human deciding whether to overwrite
 * a database, and "this is not a luck-planner export" is the answer they need
 * before they lose anything.
 */
export function parseExport(text: string): ExportDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `not a JSON document: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = exportDocumentSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`not a luck-planner export: ${issues}`);
}

/**
 * Local wall-clock stamp of an export, `YYYYMMDD-HHmmss`.
 *
 * Local rather than UTC on purpose: the file lands in a folder the user opens
 * by hand, next to files named by their own clock.
 */
export function exportStamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Filesystem-safe short name of a project: its last path segment, lowercased,
 * everything outside `[a-z0-9]` folded to a single dash, capped at 40 chars.
 * A project key is an absolute path (`/home/me/dev/Paseo Plugins`), which is
 * not a file name; this is the closest readable form that is one.
 */
export function projectSlug(projectKey: string): string {
  const segments = projectKey.split(/[\\/]+/).filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? "";
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "project";
}

/** `luck-planner-<slug>-<stamp>.json.zip`. */
export function exportFileName(projectKey: string, exportedAt: number): string {
  return `luck-planner-${projectSlug(projectKey)}-${exportStamp(exportedAt)}${EXPORT_FILE_EXTENSION}`;
}

/**
 * Name of the JSON entry inside the archive: the file name without `.zip`,
 * so a user who extracts it gets `…-20261104-132055.json` and not `data.json`
 * (three downloads from three projects must not collide on extraction).
 */
export function exportEntryName(fileName: string): string {
  return fileName.endsWith(".zip") ? fileName.slice(0, -".zip".length) : fileName;
}
