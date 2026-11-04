/**
 * Project import — the server half of stage L5 (`__doc.md` §6).
 *
 * `shared/import.ts` owns the plan: validation, the archived policy, the id
 * remap. This module owns what a shared module may not touch — the file and
 * the store. Three surfaces answer to it and must agree on what "imported"
 * means: the MCP tool `luck_tree_import`, the `luck-planner.tree-import` RPC
 * behind the settings screen, and the tests.
 *
 * **A dry run is a full run minus the write.** Reading, unpacking, validating
 * the hierarchy and the target project all happen either way; the only
 * difference is the final `importProject` call. That is the point of the flag:
 * a plan that would be refused must be refused *before* a single row lands, so
 * a caller can always ask first and pay nothing for the answer.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { parseExport, type ExportDocument } from "../shared/export";
import {
  describeImport,
  planImport,
  type ImportCounts,
  type ImportOptions,
  type ImportPlan,
  type ImportSource,
} from "../shared/import";
import type { ImportProjectResult, LuckPlannerStore } from "./store";

/** What an import needs from the caller. */
export interface ImportRequest {
  /** Absolute path of a `.json.zip` export — or an extracted `.json`. */
  readonly file: string;
  /** Target project; defaults to the project the file was exported from. */
  readonly projectKey?: string;
  /** Keep soft-deleted rows (default `true`). */
  readonly includeArchived?: boolean;
  /** Import the audit trail when the file carries one (default `true`). */
  readonly includeHistory?: boolean;
  /** Validate and answer, write nothing (default `false` at this layer). */
  readonly dryRun?: boolean;
  /** Actor for the audit rows the import appends. */
  readonly actor?: string;
  /** Test hook: deterministic ids in the plan. */
  readonly newId?: () => string;
}

/** The answer both surfaces render: what would happen, or what happened. */
export interface ImportReport {
  /** The file that was read. */
  readonly file: string;
  readonly dryRun: boolean;
  /** Project the rows were (or would be) written into. */
  readonly projectKey: string;
  /** Provenance of the file itself. */
  readonly source: ImportSource;
  readonly counts: ImportCounts;
  readonly warnings: readonly string[];
  /** One line for a message: `12 nodes, 3 bees, …`. */
  readonly summary: string;
  /** Rows the store actually wrote; every count is 0 on a dry run. */
  readonly written: ImportProjectResult;
}

const EMPTY_WRITE: ImportProjectResult = {
  nodes: 0,
  bees: 0,
  bugs: 0,
  goals: 0,
  growth: 0,
  history: 0,
};

/**
 * Reads an export from disk.
 *
 * Two accepted shapes, both produced by stage L2: the archive
 * (`…-<stamp>.json.zip`, which is what the dashboard downloads and the tool
 * writes) and a `.json` the user extracted by hand. The archive must hold
 * exactly one JSON entry — a second one means the wrong zip, and picking one
 * of them would be a guess about someone else's data.
 *
 * The file is only ever read: an import never consumes its source.
 */
export function readImportDocument(file: string): ExportDocument {
  if (!path.isAbsolute(file)) {
    throw new Error(`import path must be absolute: ${file}`);
  }
  if (!existsSync(file)) {
    throw new Error(`import file not found: ${file}`);
  }
  if (statSync(file).isDirectory()) {
    throw new Error(`import path is a directory: ${file}`);
  }

  if (file.toLowerCase().endsWith(".zip")) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(readFileSync(file)));
    } catch (cause) {
      throw new Error(
        `not a readable zip archive (${file}): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const json = Object.keys(entries).filter((name) =>
      name.toLowerCase().endsWith(".json"),
    );
    if (json.length !== 1) {
      throw new Error(
        `the archive must hold exactly one .json entry, it holds ${json.length}: ${file}`,
      );
    }
    return parseExport(strFromU8(entries[json[0] as string] as Uint8Array));
  }

  return parseExport(readFileSync(file, "utf8"));
}

/**
 * Plans an import without writing it — what a `dryRun` answers.
 *
 * The target check is part of the plan for a reason: "can this land here" is
 * exactly the question a dry run exists to answer, and a caller that only
 * found out after the write would have been better off not asking.
 */
export function planImportFile(
  store: LuckPlannerStore,
  request: ImportRequest,
): ImportPlan & { readonly file: string } {
  const document = readImportDocument(request.file);
  const options: ImportOptions = {
    ...(request.projectKey === undefined
      ? {}
      : { projectKey: request.projectKey }),
    ...(request.includeArchived === undefined
      ? {}
      : { includeArchived: request.includeArchived }),
    ...(request.includeHistory === undefined
      ? {}
      : { includeHistory: request.includeHistory }),
    ...(request.newId === undefined ? {} : { newId: request.newId }),
  };
  const plan = planImport(document, options);
  store.assertEmptyProject(plan.projectKey);
  return { ...plan, file: request.file };
}

/**
 * Reads, validates and (unless `dryRun`) writes one project.
 *
 * Errors are thrown, not swallowed: both callers turn them into their own
 * failure shape (`isError` for the tool, `{ ok: false, error }` for the RPC),
 * and the message is written to be shown to a person — it names the file, the
 * field or the node that disagreed.
 */
export function runImport(
  store: LuckPlannerStore,
  request: ImportRequest,
): ImportReport {
  const plan = planImportFile(store, request);
  const dryRun = request.dryRun === true;
  const written = dryRun
    ? EMPTY_WRITE
    : store.importProject({
        projectKey: plan.projectKey,
        actor: request.actor ?? "import",
        nodes: plan.nodes,
        bees: plan.bees,
        bugs: plan.bugs,
        bugAttachments: plan.bugAttachments,
        goals: plan.goals,
        growth: plan.growth,
        history: plan.history,
      });

  return {
    file: plan.file,
    dryRun,
    projectKey: plan.projectKey,
    source: plan.source,
    counts: plan.counts,
    warnings: plan.warnings,
    summary: describeImport(plan),
    written,
  };
}
