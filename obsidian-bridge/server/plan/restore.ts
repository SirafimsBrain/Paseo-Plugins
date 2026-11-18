import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { isPlanSystemPath } from "../vault";
import { parsePlanDocument, positiveInt, stringField } from "./frontmatter";
import { appendJournal } from "./journal";
import { resolvePlanRoot } from "./paths";
import { findPlanNode, kindOf, loadPlanTreeFor, projectOf } from "./read";
import { extractNotes, sectionBody } from "./sections";
import { isSnapshotFrontmatter, snapshotPathFor } from "./snapshot";
import {
  actorOf,
  commitNodeChange,
  fail,
  json,
  loadWritableNode,
  readOnlyRefusal,
  wikilinkFor,
} from "./write";

/**
 * `plan_restore`: a snapshot becomes a new revision of the live line.
 *
 * A restore is not a rollback. The current state is snapshotted first, the
 * counters move forward (`revision + 1`, the version never goes back), and
 * `restored_from` records which snapshot was read. Relations are **kept from the
 * live file**: a snapshot deliberately drops `parent`, `children`, `influences`,
 * `blocked_by`, `blocks`, `goal` and `materialized`, because they point at live
 * documents, and restoring an old copy of the graph would silently resurrect
 * links that no longer exist.
 */

/** Fields a restore takes from the snapshot; everything else stays live. */
const RESTORED_FIELDS = [
  "name",
  "description",
  "brief",
  "payload",
  "plan",
  "growth",
  "severity",
  "formal_text",
  "status",
] as const;

export function planRestore(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const rawPath = stringField(input.path);
  if (!rawPath) return fail("`path` is required: the live node to restore into.");
  if (isPlanSystemPath(rawPath)) {
    return fail(
      `'${rawPath}' is a snapshot or an archived file. Pass the live node path; the snapshot is ` +
        "chosen with `version` and `revision`.",
    );
  }

  const version =
    typeof input.version === "number" && Number.isFinite(input.version)
      ? Math.trunc(input.version)
      : null;
  const revision =
    typeof input.revision === "number" && Number.isFinite(input.revision)
      ? Math.trunc(input.revision)
      : null;
  if (version === null || revision === null || version < 1 || revision < 1) {
    return fail(
      "`version` and `revision` are required: the snapshot to restore, as listed by `plan_history`.",
    );
  }

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const found = findPlanNode(tree, rawPath);
  if ("error" in found) return fail(found.error, { suggestions: found.suggestions });
  const node = found.node;

  const prepared = loadWritableNode(root, node, input);
  if ("error" in prepared) return prepared.error;
  const stored = prepared.stored;
  const live = stored.document.frontmatter;

  const snapshotRel = snapshotPathFor(node.vaultPath, version, revision);
  const snapshotAbs = path.join(root.vaultRoot, snapshotRel);
  let snapshotText = "";
  try {
    snapshotText = fs.readFileSync(snapshotAbs, "utf-8");
  } catch {
    return fail(
      `There is no snapshot v${version} r${revision} for '${node.vaultPath}' ` +
        `(expected '${snapshotRel}'). Call \`plan_history\` to see the stored revisions.`,
    );
  }
  const parsed = parsePlanDocument(snapshotText);
  if ("error" in parsed) return fail(`${snapshotRel}: ${parsed.error}`);
  const snapshot = parsed.document.frontmatter;
  if (!isSnapshotFrontmatter(snapshot)) {
    return fail(`'${snapshotRel}' is not a snapshot: it has no \`is_snapshot: true\`.`);
  }
  const snapshotOf = stringField(snapshot.snapshot_of);
  if (snapshotOf !== null && snapshotOf.replace(/\\/g, "/") !== node.vaultPath) {
    return fail(
      `'${snapshotRel}' belongs to '${snapshotOf}', not to '${node.vaultPath}'.`,
    );
  }
  const liveKind = kindOf(node);
  const snapshotKind = stringField(snapshot.kind);
  if (liveKind !== null && snapshotKind !== null && liveKind !== snapshotKind) {
    return fail(
      `The snapshot is a ${snapshotKind} and the live file is a ${liveKind}. A kind change is not ` +
        "a revision, so it is not restored here: create the file again with the kind you want.",
    );
  }

  const next: Record<string, unknown> = { ...live };
  let changed = false;
  for (const field of RESTORED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
      next[field] = snapshot[field];
      changed = true;
    } else if (Object.prototype.hasOwnProperty.call(next, field)) {
      delete next[field];
      changed = true;
    }
  }
  if (!changed) {
    return fail(
      `The snapshot v${version} r${revision} describes exactly the live state; there is nothing ` +
        "to restore.",
    );
  }

  const liveVersion = positiveInt(live.version) ?? 1;
  const liveRevision = positiveInt(live.revision) ?? 1;
  next.restored_from = `v${version} r${revision}`;
  if (snapshot.status !== undefined) next.status_by = actorOf(input);

  const notesPresent = sectionBody(parsed.document.body, "Заметки") !== null;
  const actor = actorOf(input);
  const at = new Date().toISOString();

  const change = commitNodeChange(
    settings,
    root,
    node,
    stored,
    {
      next,
      bump: "revision",
      reason: "restore",
      ...(notesPresent ? { notes: extractNotes(parsed.document.body) } : {}),
    },
    actor,
  );
  if ("error" in change) return fail(change.error);

  const journal = appendJournal(root, projectOf(node), {
    at,
    op: "plan_restore",
    target: wikilinkFor(node.vaultPath),
    result: `restored v${version} r${revision} → v${change.version} r${change.revision}`,
    actor,
  });

  return json({
    ok: true,
    action: "restored",
    path: node.relPath,
    vault_path: node.vaultPath,
    kind: liveKind,
    restored_from: `v${version} r${revision}`,
    previous: { version: liveVersion, revision: liveRevision },
    version: change.version,
    revision: change.revision,
    snapshot: change.snapshot,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
    note:
      "Relations stay as the live file had them; the snapshot only carries content, counters and " +
      "status.",
  });
}
