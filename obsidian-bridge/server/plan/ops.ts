import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { isPlanSystemPath, resolveInsideVault } from "../vault";
import { serializePlanDocument, stringField } from "./frontmatter";
import { appendJournal, journalPathFor } from "./journal";
import { ALLOWED_CHILD_KINDS, canHaveChild, isNodeKind, orderPlanKeys } from "./model";
import { resolvePlanPath, resolvePlanRoot, type PlanRoot } from "./paths";
import {
  findPlanNode,
  kindOf,
  loadPlanTree,
  loadPlanTreeFor,
  projectOf,
  resolveLink,
  suggestPlanNodes,
  summarize,
  type PlanNode,
  type PlanTree,
} from "./read";
import { renderPlanBody } from "./sections";
import {
  actorOf,
  appendChild,
  commitNodeChange,
  fail,
  isRecord,
  json,
  loadWritableNode,
  nowIso,
  readOnlyRefusal,
  readStored,
  takeSnapshot,
  wikilinkFor,
  writeStored,
} from "./write";

/**
 * The three multi-file operations: move, archive and goal approval.
 *
 * The filesystem has no transaction, so each operation is a resumable sequence
 * instead of pretending to be atomic:
 *
 * 1. `op:start <uuid>` in the project journal — the marker that says "this
 *    operation may be half-done";
 * 2. the filesystem steps (rename, new files);
 * 3. link and structural rewrites, each file through `commitNodeChange`, so
 *    every changed file is snapshotted before it is overwritten;
 * 4. `op:done <uuid>`.
 *
 * Repeating the call with the same `op_id` resumes instead of duplicating: an
 * already renamed folder or an already created branch is accepted when the
 * journal says the operation started but never finished, and `op:done` is only
 * written once every step landed. A `plan_validate` pass can therefore name a
 * half-finished operation from the journal alone.
 */

const JOURNAL_OP_START = "op:start";
const JOURNAL_OP_DONE = "op:done";

interface OpState {
  started: boolean;
  done: boolean;
}

export function parseOpId(input: Record<string, unknown>): { id: string } | { error: string } {
  const raw = stringField(input.op_id);
  if (raw === null) return { id: crypto.randomUUID() };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    return { error: "`op_id` must be 1–64 characters of letters, digits, `-` or `_`." };
  }
  return { id: raw };
}

export function opState(root: PlanRoot, project: string | null, id: string): OpState {
  const absolute = path.join(root.vaultRoot, journalPathFor(root, project));
  let text = "";
  try {
    text = fs.readFileSync(absolute, "utf-8");
  } catch {
    return { started: false, done: false };
  }
  return {
    started: text.includes(`${JOURNAL_OP_START} ${id}`),
    done: text.includes(`${JOURNAL_OP_DONE} ${id}`),
  };
}

export function markStart(
  root: PlanRoot,
  project: string | null,
  id: string,
  tool: string,
  target: string,
  actor: string,
  at: string,
): string | null {
  const journal = appendJournal(root, project, {
    at,
    op: `${JOURNAL_OP_START} ${id}`,
    target: wikilinkFor(target),
    result: `${tool} · pending`,
    actor,
  });
  return "error" in journal ? journal.error : null;
}

export function markDone(
  root: PlanRoot,
  project: string | null,
  id: string,
  tool: string,
  result: string,
  actor: string,
  at: string,
): string | null {
  const journal = appendJournal(root, project, {
    at,
    op: `${JOURNAL_OP_DONE} ${id}`,
    result: `${tool} · ${result}`,
    actor,
  });
  return "error" in journal ? journal.error : null;
}

/** `[[Workspaces/a/b|b]]` or `Workspaces/a/b.md` → `Workspaces/a/b`. */
function linkKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(trimmed);
  const raw = match ? match[1].split("#")[0] : trimmed;
  const key = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
  return key.length > 0 ? key : null;
}

function remap(value: unknown, mapping: Map<string, string>): { text: string } | null {
  const key = linkKey(value);
  if (key === null) return null;
  const target = mapping.get(key);
  return target === undefined ? null : { text: wikilinkFor(`${target}.md`) };
}

/**
 * Rewrites every link that points into the moved subtree. `full` also rewrites
 * `parent`/`children` (a file that moved carries its own address); `edges`
 * leaves the hierarchy alone, which is what a file outside the subtree needs.
 */
function rewriteLinks(
  frontmatter: Record<string, unknown>,
  mapping: Map<string, string>,
  mode: "full" | "edges",
): { next: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...frontmatter };
  let changed = false;

  const scalarFields = mode === "full" ? ["parent", "materialized"] : ["materialized"];
  for (const field of scalarFields) {
    const remapped = remap(next[field], mapping);
    if (remapped) {
      next[field] = remapped.text;
      changed = true;
    }
  }

  const listFields = mode === "full"
    ? ["children", "blocked_by", "blocks"]
    : ["blocked_by", "blocks"];
  for (const field of listFields) {
    const value = next[field];
    if (!Array.isArray(value)) continue;
    let fieldChanged = false;
    const list = value.map((entry) => {
      const remapped = remap(entry, mapping);
      if (!remapped) return entry;
      fieldChanged = true;
      return remapped.text;
    });
    if (fieldChanged) {
      next[field] = list;
      changed = true;
    }
  }

  if (Array.isArray(next.influences) && next.influences.length > 0) {
    let fieldChanged = false;
    next.influences = next.influences.map((entry) => {
      if (!isRecord(entry)) return entry;
      const remapped = remap(entry.target, mapping);
      if (!remapped) return entry;
      fieldChanged = true;
      return { ...entry, target: remapped.text };
    });
    if (fieldChanged) changed = true;
  }

  return { next, changed };
}

/** `<folder>/<folder>.md`: the node document that lives in a folder. */
function nodeFileFor(folderRel: string): string {
  return `${folderRel}/${path.posix.basename(folderRel)}.md`;
}

function absoluteFor(root: PlanRoot, vaultPath: string): string | null {
  return resolveInsideVault(root.vaultRoot, vaultPath);
}

function subtreeOf(tree: PlanTree, node: PlanNode): PlanNode[] {
  const folder = path.posix.dirname(node.vaultPath);
  const leaf = kindOf(node) === "leaf";
  return [...tree.nodes.values()].filter(
    (candidate) =>
      candidate.vaultPath === node.vaultPath ||
      (!leaf && candidate.vaultPath.startsWith(`${folder}/`)),
  );
}

function projectRefusal(project: string | null): ToolOutcome | null {
  if (project !== null) return null;
  return fail(
    "The node is not inside a project folder under the planning root, so there is no project " +
      "journal to record the operation in.",
  );
}

/** `<dir>/__history/<slug>.v*.r*.md` files that belong to one leaf. */
function leafHistoryMoves(
  root: PlanRoot,
  node: PlanNode,
  newVault: string,
): Array<{ from: string; to: string }> {
  const oldHistory = `${path.posix.dirname(node.vaultPath)}/__history`;
  const newHistory = `${path.posix.dirname(newVault)}/__history`;
  if (oldHistory === newHistory) return [];
  const slug = path.posix.basename(node.vaultPath, ".md");
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(root.vaultRoot, oldHistory));
  } catch {
    return [];
  }
  const moved: Array<{ from: string; to: string }> = [];
  for (const name of names) {
    if (!name.startsWith(`${slug}.v`) || !name.endsWith(".md")) continue;
    moved.push({
      from: path.join(root.vaultRoot, oldHistory, name),
      to: path.join(root.vaultRoot, newHistory, name),
    });
  }
  return moved;
}

interface RenamePlan {
  oldAbs: string;
  newAbs: string;
  leafHistory: Array<{ from: string; to: string }>;
}

/** Moves a node's folder (or a leaf's file) together with the leaf's snapshots. */
function applyRename(plan: RenamePlan, resume: boolean): { error: string } | null {
  try {
    fs.mkdirSync(path.dirname(plan.newAbs), { recursive: true });
    if (!(resume && !fs.existsSync(plan.oldAbs))) {
      fs.renameSync(plan.oldAbs, plan.newAbs);
    }
    for (const entry of plan.leafHistory) {
      if (!fs.existsSync(entry.from)) continue;
      fs.mkdirSync(path.dirname(entry.to), { recursive: true });
      if (!fs.existsSync(entry.to)) fs.renameSync(entry.from, entry.to);
    }
    return null;
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function planMoveNode(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const parsedOp = parseOpId(input);
  if ("error" in parsedOp) return fail(parsedOp.error);
  const opId = parsedOp.id;

  const rawPath = stringField(input.path);
  const toPath = stringField(input.to);
  if (!rawPath) return fail("`path` is required: the node to move.");
  if (!toPath) {
    return fail(
      "`to` is required: the destination path inside the planning root, e.g. " +
        "`centurion/frontend/auth` for a node or `centurion/frontend/session-store` for a leaf.",
    );
  }
  if (isPlanSystemPath(rawPath)) {
    return fail(
      `'${rawPath}' is history or the archive; only a live node moves. Restore it first with ` +
        "`plan_restore`.",
    );
  }

  const resolvedOld = resolvePlanPath(root, rawPath);
  if ("error" in resolvedOld) return fail(resolvedOld.error);
  const oldRel = resolvedOld.relPath.replace(/\.md$/i, "");

  const resolvedTo = resolvePlanPath(root, toPath);
  if ("error" in resolvedTo) return fail(resolvedTo.error);
  const toRel = resolvedTo.relPath.replace(/\.md$/i, "");
  const toVault = `${root.relPath}/${toRel}`;
  const oldVaultRel = `${root.relPath}/${oldRel}`;
  if (isPlanSystemPath(toRel)) {
    return fail("`to` cannot point into `__history` or `_archive`; use `plan_archive_node`.");
  }

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const guessProject = oldRel.split("/")[0];
  const project = guessProject.startsWith("_") ? null : guessProject;
  const state = opState(root, project, opId);
  if (state.done) {
    return json({
      ok: true,
      action: "already_done",
      op_id: opId,
      note: "This operation id is already marked done in the journal; nothing was changed.",
      path: oldRel,
    });
  }

  const found = findPlanNode(tree, rawPath);
  // A missing source is an ordinary refusal unless this exact operation already
  // started: only then may the destination hold the half-moved node. Without
  // this check an existing destination node looked like a resumed move, and the
  // call reported success for a path that never existed (live test N1).
  const sourceMissing = "error" in found;
  if (sourceMissing && !state.started) {
    return fail(found.error, { suggestions: found.suggestions });
  }
  // An interrupted move may already have renamed the folder and stopped before
  // the links were rewritten: the source is then gone and the destination is
  // the only way back in. Both addresses are known, so the operation continues.
  const atDestination =
    tree.nodes.get(`${toVault}.md`) ?? tree.nodes.get(nodeFileFor(toVault)) ?? null;
  const node = sourceMissing ? atDestination : found.node;
  if (!node) {
    return fail(
      `'${rawPath}' is gone and nothing sits at '${toRel}', so there is no half-done move to ` +
        `resume. The journal keeps \`op:start ${opId}\`; inspect it before retrying.`,
      { op_id: opId },
    );
  }

  const kind = kindOf(node);
  if (kind !== null && !isNodeKind(kind)) {
    return fail(
      `'${node.relPath}' is a ${kind}. Goals and incidents keep their own folders; create them at ` +
        "the path you want instead of moving them.",
    );
  }
  if (!isNodeKind(kind)) return fail(`'${node.relPath}' is not a tree node.`);
  if (kind === "root") {
    return fail(
      `'${node.relPath}' is the project root: moving it would move the whole project. Rename the ` +
        "project folder by hand, then run `obsidian_index`.",
    );
  }

  const oldVault = sourceMissing
    ? kind === "leaf" ? `${oldVaultRel}.md` : nodeFileFor(oldVaultRel)
    : node.vaultPath;
  const newVault = kind === "leaf" ? `${toVault}.md` : nodeFileFor(toVault);
  if (newVault === oldVault) {
    return fail("Nothing to move: `to` resolves to the node's current path.");
  }
  // A leaf is a file, so `to` must name the new file. Passing a branching
  // node's folder used to fall through to a parent-kind refusal that never said
  // what was wrong with the argument (live test N1, companion case).
  if (!sourceMissing && kind === "leaf" && tree.nodes.has(nodeFileFor(toVault))) {
    return fail(
      `\`to\` must be the leaf's new file path, not another node's folder: ` +
        `'${toRel}' already names '${nodeFileFor(toVault)}'. Pass e.g. ` +
        `'${toRel}/<leaf-name>'.`,
    );
  }
  const oldFolder = path.posix.dirname(oldVault);
  if (kind !== "leaf" && `${toVault}/`.startsWith(`${oldFolder}/`)) {
    return fail("A node cannot be moved inside itself.");
  }

  const parentFolder =
    kind === "leaf"
      ? path.posix.dirname(newVault)
      : path.posix.dirname(path.posix.dirname(newVault));
  const parentVault = nodeFileFor(parentFolder);
  const parent = tree.nodes.get(parentVault) ?? null;
  if (!parent) {
    return fail(
      `The destination has no parent node ('${parentVault}'). Create it first; a moved node is ` +
        "never an orphan.",
      { suggestions: suggestPlanNodes(tree, parentFolder) },
    );
  }
  const parentKind = kindOf(parent);
  if (!parentKind || !isNodeKind(parentKind)) {
    return fail(`'${parent.relPath}' is not a tree node, so it cannot receive a child.`);
  }
  if (!canHaveChild(parentKind, kind)) {
    return fail(
      `A ${parentKind} cannot have a ${kind} child. Allowed here: ` +
        `${ALLOWED_CHILD_KINDS[parentKind].join(", ")}.`,
    );
  }

  const projectError = projectRefusal(project);
  if (projectError) return projectError;

  if (!sourceMissing) {
    const primary = loadWritableNode(root, node, input);
    if ("error" in primary) return primary.error;
  }

  const oldAbs = absoluteFor(root, kind === "leaf" ? oldVault : oldFolder);
  const newAbs = absoluteFor(root, kind === "leaf" ? newVault : path.posix.dirname(newVault));
  if (!oldAbs || !newAbs) return fail("The move resolves outside the planning root.");

  const resume = state.started;
  const renamedAlready = sourceMissing || (resume && !fs.existsSync(oldAbs));
  const destinationTaken = tree.nodes.has(newVault) || fs.existsSync(newAbs);
  if (destinationTaken && !renamedAlready) {
    return fail(
      `'${newVault}' already exists; a move never overwrites a note.`,
      resume ? { op_id: opId } : {},
    );
  }

  const movedNodes = subtreeOf(tree, node);
  const mapping = new Map<string, string>();
  for (const moved of movedNodes) {
    if (sourceMissing) {
      const suffix = kind === "leaf" ? "" : moved.vaultPath.slice(toVault.length);
      mapping.set(`${oldVaultRel}${suffix}`, moved.vaultPath.replace(/\.md$/i, ""));
      continue;
    }
    const relative = moved.vaultPath.slice(oldFolder.length);
    const target = kind === "leaf" ? newVault : `${toVault}${relative}`;
    mapping.set(moved.vaultPath.replace(/\.md$/i, ""), target.replace(/\.md$/i, ""));
  }
  const movedRootVault = newVault;
  // After the rename the files sit at the new addresses, so "did this file move?"
  // is answered by the values, not the keys of the mapping.
  const newAddresses = new Set(mapping.values());
  const oldParent = typeof node.frontmatter.parent === "string"
    ? resolveLink(tree, node.frontmatter.parent)
    : null;

  const actor = actorOf(input);
  const now = nowIso();

  if (!state.started) {
    const markerError = markStart(root, project, opId, "plan_move_node", oldVault, actor, now);
    if (markerError) return fail(markerError);
  }

  if (!renamedAlready) {
    for (const moved of movedNodes) {
      const snapshot = takeSnapshot(root, moved, "move");
      if ("error" in snapshot) {
        return fail(snapshot.error, { op_id: opId, partial: false, stage: "snapshot" });
      }
    }

    const renameError = applyRename(
      {
        oldAbs,
        newAbs,
        leafHistory: kind === "leaf" ? leafHistoryMoves(root, node, newVault) : [],
      },
      false,
    );
    if (renameError) {
      return fail(
        `The move stopped while renaming: ${renameError.error}. The journal keeps ` +
          `\`op:start ${opId}\`; repeat the call with the same \`op_id\` to finish it.`,
        { op_id: opId, partial: true, stage: "rename" },
      );
    }
  }

  const after = loadPlanTree(root);
  const edits = new Map<string, Record<string, unknown>>();

  for (const candidate of after.nodes.values()) {
    const moved = newAddresses.has(candidate.vaultPath.replace(/\.md$/i, ""));
    const { next, changed } = rewriteLinks(candidate.frontmatter, mapping, moved ? "full" : "edges");
    if (changed) edits.set(candidate.vaultPath, next);
  }

  const frontmatterOf = (vaultPath: string): Record<string, unknown> | null =>
    edits.get(vaultPath) ?? after.nodes.get(vaultPath)?.frontmatter ?? null;

  // The moved root gets a new `parent`; that link points outside the subtree, so
  // the generic remap cannot produce it.
  const movedRootAfter = after.nodes.get(movedRootVault);
  const movedRootCurrent = movedRootAfter ? frontmatterOf(movedRootVault) : null;
  if (movedRootAfter && movedRootCurrent) {
    edits.set(movedRootVault, { ...movedRootCurrent, parent: wikilinkFor(parent.vaultPath) });
  }

  // Old parent: drop the child that left.
  const oldParentAfter = oldParent ? after.nodes.get(oldParent.vaultPath) : null;
  const oldParentCurrent = oldParentAfter ? frontmatterOf(oldParentAfter.vaultPath) : null;
  if (oldParentAfter && oldParentCurrent && Array.isArray(oldParentCurrent.children)) {
    const removed = linkKey(oldVault);
    const added = linkKey(movedRootVault);
    const children = oldParentCurrent.children.filter((entry) => {
      const key = linkKey(entry);
      return key !== removed && key !== added;
    });
    if (children.length !== oldParentCurrent.children.length) {
      edits.set(oldParentAfter.vaultPath, { ...oldParentCurrent, children });
    }
  }

  // New parent: add the child under its new address.
  const newParentAfter = after.nodes.get(parent.vaultPath);
  const newParentCurrent = newParentAfter ? frontmatterOf(newParentAfter.vaultPath) : null;
  if (newParentAfter && newParentCurrent) {
    const children = Array.isArray(newParentCurrent.children) ? [...newParentCurrent.children] : [];
    const added = linkKey(movedRootVault);
    const present = children.some((entry) => linkKey(entry) === added);
    if (!present) {
      edits.set(newParentAfter.vaultPath, {
        ...newParentCurrent,
        children: [...children, wikilinkFor(movedRootVault)],
      });
    }
  }

  let changedFiles = 0;
  for (const [vaultPath, next] of edits) {
    const target = after.nodes.get(vaultPath);
    if (!target) continue;
    const stored = readStored(root, vaultPath);
    if ("error" in stored) {
      return fail(
        `The move reached '${vaultPath}' and stopped: ${stored.error}. The journal keeps ` +
          `\`op:start ${opId}\`; repeat the call with the same \`op_id\` to finish it.`,
        { op_id: opId, partial: true, stage: "links", files_changed: changedFiles },
      );
    }
    const change = commitNodeChange(
      settings,
      root,
      target,
      stored,
      { next, bump: "revision", reason: "move" },
      actor,
    );
    if ("error" in change) {
      return fail(
        `The move reached '${vaultPath}' and stopped: ${change.error}. The journal keeps ` +
          `\`op:start ${opId}\`; repeat the call with the same \`op_id\` to finish it.`,
        { op_id: opId, partial: true, stage: "links", files_changed: changedFiles },
      );
    }
    changedFiles += 1;
  }

  const doneError = markDone(
    root,
    project,
    opId,
    "plan_move_node",
    `${wikilinkFor(oldVault)} → ${wikilinkFor(movedRootVault)} · ${changedFiles} files`,
    actor,
    now,
  );

  const newRel = movedRootVault.startsWith(`${root.relPath}/`)
    ? movedRootVault.slice(root.relPath.length + 1)
    : movedRootVault;

  return json({
    ok: true,
    action: resumedOr(resume, renamedAlready),
    op_id: opId,
    from: oldRel,
    to: newRel,
    vault_path: movedRootVault,
    project: projectOf({ ...node, vaultPath: movedRootVault, relPath: newRel }),
    files_changed: changedFiles,
    mapping: [...mapping.entries()].map(([from, to]) => ({ from, to })),
    parent: summarize(parent),
    journal_error: doneError,
  });
}

function resumedOr(resume: boolean, renamedAlready: boolean): "moved" | "resumed" {
  return resume || renamedAlready ? "resumed" : "moved";
}

export function planArchiveNode(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const parsedOp = parseOpId(input);
  if ("error" in parsedOp) return fail(parsedOp.error);
  const opId = parsedOp.id;

  const rawPath = stringField(input.path);
  if (!rawPath) return fail("`path` is required: the node to archive.");
  if (isPlanSystemPath(rawPath)) {
    return fail(`'${rawPath}' is already in history or the archive.`);
  }

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const found = findPlanNode(tree, rawPath);
  if ("error" in found) return fail(found.error, { suggestions: found.suggestions });
  const node = found.node;
  const kind = kindOf(node);
  if (!isNodeKind(kind)) {
    return fail(
      `'${node.relPath}' is a ${kind ?? "document"}, not a tree node. Only a subtree is archived.`,
    );
  }
  if (kind === "root") {
    return fail(
      `'${node.relPath}' is the project root: archiving it would archive the project. Archive its ` +
        "branches instead, or move the project folder by hand.",
    );
  }

  const project = projectOf(node);
  const projectError = projectRefusal(project);
  if (projectError) return projectError;

  const primary = loadWritableNode(root, node, input);
  if ("error" in primary) return primary.error;

  // The subtree is the node's own folder, never the folder it happens to sit
  // in. A file whose kind and location disagree (a leaf promoted to a
  // subbranch before 0.21.14) shares its folder with its former siblings;
  // renaming that folder would archive them too, so the layout is checked first.
  const slug = path.posix.basename(node.vaultPath, ".md");
  const oldFolder = path.posix.dirname(node.vaultPath);
  if (kind !== "leaf" && path.posix.basename(oldFolder) !== slug) {
    return fail(
      `'${node.relPath}' is a ${kind} but its file does not live in its own folder ` +
        `('${path.posix.basename(oldFolder)}/${slug}.md'). Its kind and path disagree, and ` +
        "archiving it would move a folder that also holds other nodes; nothing was changed. " +
        `Recreate the ${kind} at '<parent>/${slug}/${slug}.md' first, or change its kind back ` +
        "with `plan_update_node`, then archive it.",
      { op_id: opId, expected: `${path.posix.dirname(oldFolder)}/${slug}/${slug}.md` },
    );
  }
  const archiveRel = `${project}/_archive/${slug}`;
  const archiveFolder = `${root.relPath}/${archiveRel}`;
  const newVault = nodeFileFor(archiveFolder);
  // A leaf is one file: the archive gives it its own folder and file, so two
  // leaves of the same parent cannot collide on the parent's folder name.
  const newAbs = absoluteFor(root, kind === "leaf" ? newVault : archiveFolder);
  const oldAbs = absoluteFor(root, kind === "leaf" ? node.vaultPath : oldFolder);
  if (!newAbs || !oldAbs) return fail("The archive path resolves outside the planning root.");

  const state = opState(root, project, opId);
  if (state.done) {
    return json({
      ok: true,
      action: "already_done",
      op_id: opId,
      note: "This operation id is already marked done in the journal; nothing was changed.",
    });
  }
  const resume = state.started;
  const wasRenamed = resume && !fs.existsSync(oldAbs);
  if (!wasRenamed && (tree.nodes.has(newVault) || fs.existsSync(newAbs))) {
    return fail(
      `'${archiveRel}' already exists; an archive never overwrites. Give the node a different ` +
        "name, or restore the archived copy first with `plan_restore`.",
    );
  }

  const actor = actorOf(input);
  const now = nowIso();
  const movedNodes = subtreeOf(tree, node);

  if (!state.started) {
    const markerError = markStart(root, project, opId, "plan_archive_node", node.vaultPath, actor, now);
    if (markerError) return fail(markerError);
  }

  if (!resume) {
    for (const moved of movedNodes) {
      const snapshot = takeSnapshot(root, moved, "archive");
      if ("error" in snapshot) {
        return fail(snapshot.error, { op_id: opId, partial: false, stage: "snapshot" });
      }
    }
  }

  const renameError = applyRename({ oldAbs, newAbs, leafHistory: [] }, resume);
  if (renameError) {
    return fail(
      `The archive stopped while renaming: ${renameError.error}. The journal keeps ` +
        `\`op:start ${opId}\`; repeat the call with the same \`op_id\` to finish it.`,
      { op_id: opId, partial: true, stage: "rename" },
    );
  }

  // `_archive` is outside the tree walk, so the files are read directly. Every
  // link inside the archived subtree is rewritten to the archived address: a
  // subtree that kept `children`/`influences` on live paths showed broken links
  // in Obsidian and could not be re-attached without hand editing (live N5).
  const mapping = new Map<string, string>();
  for (const moved of movedNodes) {
    const target =
      kind === "leaf"
        ? newVault
        : `${archiveFolder}${moved.vaultPath.slice(oldFolder.length)}`;
    mapping.set(moved.vaultPath.replace(/\.md$/i, ""), target.replace(/\.md$/i, ""));
  }

  let rewritten = 0;
  for (const moved of movedNodes) {
    const archivedPath =
      kind === "leaf"
        ? newVault
        : `${archiveFolder}${moved.vaultPath.slice(oldFolder.length)}`;
    const archivedStored = readStored(root, archivedPath);
    if ("error" in archivedStored) {
      return fail(
        `The subtree moved to '${archiveFolder}', but '${archivedPath}' could not be read: ` +
          `${archivedStored.error}.`,
        { op_id: opId, partial: true, stage: "archive" },
      );
    }
    const remapped = rewriteLinks(archivedStored.document.frontmatter, mapping, "full");
    const isRoot = archivedPath === newVault;
    const next = isRoot ? { ...remapped.next, archived: now } : remapped.next;
    if (!remapped.changed && !isRoot) continue;
    const change = commitNodeChange(
      settings,
      root,
      {
        vaultPath: archivedPath,
        relPath: archivedPath,
        frontmatter: archivedStored.document.frontmatter,
        body: archivedStored.document.body,
      },
      archivedStored,
      { next, bump: "revision", reason: "archive" },
      actor,
    );
    if ("error" in change) {
      return fail(
        `The subtree moved to '${archiveFolder}', but '${archivedPath}' could not be marked ` +
          `archived: ${change.error}.`,
        { op_id: opId, partial: true, stage: "archive" },
      );
    }
    rewritten += 1;
  }

  // The live tree loses the node: its parent must stop listing it.
  let parentRevision: number | null = null;
  const parent = typeof node.frontmatter.parent === "string"
    ? resolveLink(tree, node.frontmatter.parent)
    : null;
  if (parent) {
    const parentAfter = loadPlanTree(root).nodes.get(parent.vaultPath);
    if (parentAfter) {
      const stored = readStored(root, parentAfter.vaultPath);
      if ("error" in stored) {
        return fail(
          `The subtree is archived, but its parent could not be read: ${stored.error}. The journal ` +
            `keeps \`op:start ${opId}\`; repeat the call with the same \`op_id\`.`,
          { op_id: opId, partial: true, stage: "parent" },
        );
      }
      const before = Array.isArray(stored.document.frontmatter.children)
        ? stored.document.frontmatter.children
        : [];
      const removed = linkKey(node.vaultPath);
      const children = before.filter((entry) => linkKey(entry) !== removed);
      if (children.length !== before.length) {
        const change = commitNodeChange(
          settings,
          root,
          parentAfter,
          stored,
          {
            next: { ...stored.document.frontmatter, children },
            bump: "revision",
            reason: "archive",
          },
          actor,
        );
        if ("error" in change) {
          return fail(
            `The subtree is archived, but '${parentAfter.relPath}' still lists it: ${change.error}.`,
            { op_id: opId, partial: true, stage: "parent" },
          );
        }
        parentRevision = change.revision;
      }
    }
  }

  const doneError = markDone(
    root,
    project,
    opId,
    "plan_archive_node",
    `${wikilinkFor(node.vaultPath)} → ${wikilinkFor(newVault)}`,
    actor,
    now,
  );

  return json({
    ok: true,
    action: resume ? "resumed" : "archived",
    op_id: opId,
    path: node.relPath,
    archive_path: archiveRel,
    vault_path: newVault,
    project,
    nodes: movedNodes.length,
    links_rewritten: rewritten,
    parent_revision: parentRevision,
    journal_error: doneError,
    note:
      "Archived files are excluded from indexing, search and the plan tree; their history and " +
      "journal lines are kept.",
  });
}

export function planApproveGoal(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const parsedOp = parseOpId(input);
  if ("error" in parsedOp) return fail(parsedOp.error);
  const opId = parsedOp.id;

  const rawPath = stringField(input.path);
  if (!rawPath) return fail("`path` is required: the goal to approve.");

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const found = findPlanNode(tree, rawPath);
  if ("error" in found) return fail(found.error, { suggestions: found.suggestions });
  const goal = found.node;
  if (kindOf(goal) !== "goal") {
    return fail(`'${goal.relPath}' is a ${kindOf(goal) ?? "document"}, not a goal.`);
  }
  const status = stringField(goal.frontmatter.status);
  const materialized = typeof goal.frontmatter.materialized === "string"
    ? goal.frontmatter.materialized
    : null;

  const actor = actorOf(input);
  const creator = stringField(goal.frontmatter.created_by);
  if (creator !== null && creator === actor && actor !== "user") {
    return fail(
      `'${goal.relPath}' was created by '${creator}', and the same agent cannot approve it. Offer ` +
        "the goal to the user (the panel approves a goal), or approve it as `user`.",
      { created_by: creator, status },
    );
  }

  const project = projectOf(goal);
  const projectError = projectRefusal(project);
  if (projectError) return projectError;

  const state = opState(root, project, opId);
  if (state.done) {
    return json({
      ok: true,
      action: "already_done",
      op_id: opId,
      note: "This operation id is already marked done in the journal; nothing was changed.",
    });
  }
  const resume = state.started;

  if (!resume) {
    if (status !== "proposed") {
      return fail(
        `'${goal.relPath}' is ${status ?? "without a status"}: only a proposed goal is approved. ` +
          'Use `plan_goal` with `action: "propose"` first.',
        { status },
      );
    }
    if (materialized !== null) {
      return fail(
        `'${goal.relPath}' is already materialised at '${materialized}'; approving it again would ` +
          "duplicate the branch.",
        { materialized },
      );
    }
  }

  const projectRoot = tree.nodes.get(`${root.relPath}/${project}/${project}.md`) ?? null;
  if (!projectRoot || kindOf(projectRoot) !== "root") {
    return fail(`Project '${project}' has no root node ('${project}/${project}.md').`);
  }

  const trunkSlug = path.posix.basename(goal.vaultPath, ".md");
  const trunkFolder = `${root.relPath}/${project}/${trunkSlug}`;
  const trunkVault = nodeFileFor(trunkFolder);
  const trunkAbs = absoluteFor(root, trunkVault);
  if (!trunkAbs) return fail("The trunk path resolves outside the planning root.");

  const steps = Array.isArray(goal.frontmatter.plan)
    ? goal.frontmatter.plan.filter(isRecord)
    : [];
  if (steps.length === 0) {
    return fail(
      `'${goal.relPath}' has no steps in \`plan:\`; a goal is materialised from its steps. Add them ` +
        "with `plan_goal` before asking for approval.",
    );
  }

  const usedSlugs = new Set<string>();
  const planned = steps.map((step, index) => {
    const title = stringField(step.title) ?? `Step ${index + 1}`;
    const base = slugify(title, `step-${index + 1}`);
    let slug = base;
    let counter = 2;
    while (usedSlugs.has(slug)) {
      slug = `${base}-${counter}`;
      counter += 1;
    }
    usedSlugs.add(slug);
    return {
      title,
      description: stringField(step.description) ?? "",
      slug,
    };
  });

  // A tree is root → trunk → branch → leaf: a trunk may only hold branches, so
  // the steps live in one branch below the trunk, never directly in the trunk.
  let branchSlug = "steps";
  let branchSuffix = 2;
  while (usedSlugs.has(branchSlug)) {
    branchSlug = `steps-${branchSuffix}`;
    branchSuffix += 1;
  }
  const branchFolder = `${trunkFolder}/${branchSlug}`;
  const branchVault = nodeFileFor(branchFolder);
  const branchAbs = absoluteFor(root, branchVault);
  if (!branchAbs) return fail("The branch path resolves outside the planning root.");
  if (!resume) {
    const taken = (vaultPath: string, absolute: string): boolean =>
      tree.nodes.has(vaultPath) || fs.existsSync(absolute);
    if (taken(trunkVault, trunkAbs)) {
      return fail(
        `'${trunkSlug}' already exists under '${project}'. Approving '${goal.relPath}' would ` +
          "create a trunk there; rename the existing node or the goal file first.",
      );
    }
    if (taken(branchVault, branchAbs)) {
      return fail(
        `'${trunkSlug}/${branchSlug}' already exists under '${project}'. Approving ` +
          `'${goal.relPath}' would create a branch there; rename the existing node first.`,
      );
    }
  }
  const leaves = planned.map((leaf) => ({
    ...leaf,
    vaultPath: `${branchFolder}/${leaf.slug}.md`,
  }));

  const now = nowIso();
  if (!state.started) {
    const markerError = markStart(root, project, opId, "plan_approve_goal", goal.vaultPath, actor, now);
    if (markerError) return fail(markerError);
  }

  const created: string[] = [];
  if (!fs.existsSync(trunkAbs)) {
    const trunkText = planDocument({
      id: crypto.randomUUID(),
      schema: 1,
      kind: "trunk",
      name: stringField(goal.frontmatter.name) ?? trunkSlug,
      description: stringField(goal.frontmatter.formal_text) ?? "",
      status: "ready",
      version: 1,
      revision: 1,
      parent: wikilinkFor(projectRoot.vaultPath),
      children: [wikilinkFor(branchVault)],
      influences: [],
      blocked_by: [],
      created: now,
      updated: now,
      created_by: actor,
      updated_by: actor,
      tags: ["plan/trunk", "plan/status/ready"],
      archived: null,
    });
    const written = writeStored(root, trunkVault, trunkText, { create: true });
    if ("error" in written) {
      return fail(
        `The approval stopped while creating '${trunkFolder}': ${written.error}. The journal keeps ` +
          `\`op:start ${opId}\`; repeat the call with the same \`op_id\`.`,
        { op_id: opId, partial: true, stage: "trunk" },
      );
    }
    created.push(trunkVault);
  }

  if (!fs.existsSync(branchAbs)) {
    const branchText = planDocument({
      id: crypto.randomUUID(),
      schema: 1,
      kind: "branch",
      name: "Steps",
      description: "The steps of the approved goal.",
      status: "ready",
      version: 1,
      revision: 1,
      parent: wikilinkFor(trunkVault),
      children: leaves.map((leaf) => wikilinkFor(leaf.vaultPath)),
      influences: [],
      blocked_by: [],
      created: now,
      updated: now,
      created_by: actor,
      updated_by: actor,
      tags: ["plan/branch", "plan/status/ready"],
      archived: null,
    });
    const written = writeStored(root, branchVault, branchText, { create: true });
    if ("error" in written) {
      return fail(
        `The approval created '${trunkFolder}' and stopped while creating '${branchFolder}': ` +
          `${written.error}. The journal keeps \`op:start ${opId}\`; repeat the call with the ` +
          "same `op_id`.",
        { op_id: opId, partial: true, stage: "branch", created },
      );
    }
    created.push(branchVault);
  }

  for (const leaf of leaves) {
    if (fs.existsSync(absoluteFor(root, leaf.vaultPath) ?? "")) continue;
    const text = planDocument({
      id: crypto.randomUUID(),
      schema: 1,
      kind: "leaf",
      name: leaf.title,
      description: leaf.description,
      status: "draft",
      version: 1,
      revision: 1,
      parent: wikilinkFor(branchVault),
      children: [],
      influences: [],
      blocked_by: [],
      goal: wikilinkFor(goal.vaultPath),
      created: now,
      updated: now,
      created_by: actor,
      updated_by: actor,
      tags: ["plan/leaf", "plan/status/draft", "plan/goal"],
      archived: null,
    });
    const written = writeStored(root, leaf.vaultPath, text, { create: true });
    if ("error" in written) {
      return fail(
        `The approval created '${branchFolder}' and stopped at '${leaf.vaultPath}': ${written.error}. ` +
          `The journal keeps \`op:start ${opId}\`; repeat the call with the same \`op_id\`.`,
        { op_id: opId, partial: true, stage: "leaves", created },
      );
    }
    created.push(leaf.vaultPath);
  }

  const rootAfter = loadPlanTree(root).nodes.get(projectRoot.vaultPath);
  if (rootAfter) {
    const listed = Array.isArray(rootAfter.frontmatter.children)
      ? rootAfter.frontmatter.children.some((entry) => linkKey(entry) === linkKey(trunkVault))
      : false;
    if (!listed) {
      const attached = appendChild(root, rootAfter, trunkVault, actor);
      if ("error" in attached) {
        return fail(
          `The branch and its leaves exist, but the project root could not list the branch: ` +
            `${attached.error}. The journal keeps \`op:start ${opId}\`.`,
          { op_id: opId, partial: true, stage: "root" },
        );
      }
    }
  }

  const goalStored = readStored(root, goal.vaultPath);
  if ("error" in goalStored) {
    return fail(
      `The approval created the branch, but the goal could not be read back: ${goalStored.error}.`,
      { op_id: opId, partial: true, stage: "goal" },
    );
  }
  const goalChange = commitNodeChange(
    settings,
    root,
    goal,
    goalStored,
    {
      next: {
        ...goalStored.document.frontmatter,
        status: "approved",
        status_by: actor,
        materialized: wikilinkFor(trunkVault),
      },
      bump: "revision",
      reason: "status_change",
    },
    actor,
  );
  if ("error" in goalChange) {
    return fail(
      `The trunk, branch and leaves exist, but '${goal.relPath}' could not be marked approved: ` +
        `${goalChange.error}. The journal keeps \`op:start ${opId}\`.`,
      { op_id: opId, partial: true, stage: "goal", created },
    );
  }

  const doneError = markDone(
    root,
    project,
    opId,
    "plan_approve_goal",
    `${wikilinkFor(goal.vaultPath)} → ${wikilinkFor(trunkVault)} · ${leaves.length} leaves`,
    actor,
    now,
  );

  const relative = (vaultPath: string) =>
    vaultPath.startsWith(`${root.relPath}/`) ? vaultPath.slice(root.relPath.length + 1) : vaultPath;

  return json({
    ok: true,
    action: resume ? "resumed" : "approved",
    op_id: opId,
    path: goal.relPath,
    status: "approved",
    materialized: relative(trunkVault),
    trunk: {
      path: relative(trunkVault),
      kind: "trunk",
      parent: projectRoot.relPath,
    },
    branch: {
      path: relative(branchVault),
      kind: "branch",
      parent: relative(trunkVault),
    },
    leaves: leaves.map((leaf) => ({ path: relative(leaf.vaultPath), name: leaf.title })),
    created: created.map(relative),
    version: goalChange.version,
    revision: goalChange.revision,
    snapshot: goalChange.snapshot,
    journal_error: doneError,
  });
}

/** `durable-sessions`; a non-latin title falls back to the step id. */
export function slugify(value: string, fallback: string): string {
  const latin = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return latin.length > 0 ? latin : fallback;
}

/** Serializes a generated plan document with its body sections. */
export function planDocument(frontmatter: Record<string, unknown>): string {
  const ordered = orderPlanKeys(frontmatter);
  return serializePlanDocument({ frontmatter: ordered, body: renderPlanBody(ordered, "") });
}
