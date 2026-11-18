import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { MAX_NOTE_BYTES, isPlanSystemPath, resolveInsideVault } from "../vault";
import { writeRefusal } from "../write-gate";
import {
  parsePlanDocument,
  positiveInt,
  serializePlanDocument,
  stringField,
  type PlanDocument,
} from "./frontmatter";
import { appendJournal } from "./journal";
import {
  ALLOWED_CHILD_KINDS,
  canHaveChild,
  canTransitionStatus,
  GOAL_TRANSITIONS,
  INCIDENT_TRANSITIONS,
  isNodeKind,
  LEAF_STATUSES,
  LEAF_TRANSITIONS,
  orderPlanKeys,
  statusesOfKind,
  type NodeKind,
  type PlanKind,
  type SnapshotReason,
} from "./model";
import { normalizePlanPath, resolvePlanPath, resolvePlanRoot, type PlanRoot } from "./paths";
import {
  findPlanNode,
  kindOf,
  loadPlanTreeFor,
  projectOf,
  resolveLink,
  suggestPlanNodes,
  statusOf,
  summarize,
  type PlanNode,
  type PlanTree,
} from "./read";
import { renderPlanBody } from "./sections";
import { buildSnapshot, isSnapshotFrontmatter } from "./snapshot";

/**
 * `plan_create_node`, `plan_update_node`, `plan_set_status` and `plan_history`.
 *
 * Every write follows the same order, because the file on disk is the only copy:
 *
 * 1. resolve the planning root and the target by path (no absolute paths, no
 *    escape through `..`, no symlink out of the root);
 * 2. read the file and refuse on a stale revision, an unreadable frontmatter or
 *    a concurrent hand edit (the `updated` timestamp versus the file's mtime);
 * 3. **snapshot the previous state** into `__history/`, so a crash leaves the
 *    old document recoverable;
 * 4. write the new content through a temp file and `rename`, re-checking size
 *    and mtime right before the rename;
 * 5. append one line to the project journal.
 *
 * A failed step returns a refusal and writes nothing further; the journal line
 * is written only after the file landed, so it never claims a change that did
 * not happen.
 */

const DEFAULT_ACTOR = "agent";

export function json(value: unknown): ToolOutcome {
  return { text: JSON.stringify(value, null, 2), structuredContent: value };
}

export function fail(message: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return {
    text: message,
    isError: true,
    structuredContent: { ok: false, error: message, ...extra },
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function actorOf(input: Record<string, unknown>): string {
  return stringField(input.actor) ?? DEFAULT_ACTOR;
}

/** `[[Workspaces/x/y|y]]`: vault-relative, no extension, with an alias. */
export function wikilinkFor(vaultPath: string): string {
  const target = vaultPath.replace(/\\/g, "/").replace(/\.md$/i, "");
  const label = target.split("/").pop() ?? target;
  return `[[${target}|${label}]]`;
}

export interface StoredFile {
  text: string;
  document: PlanDocument;
  stat: fs.Stats;
}

export function readStored(root: PlanRoot, vaultPath: string): StoredFile | { error: string } {
  const absolute = resolveInsideVault(root.vaultRoot, vaultPath);
  if (!absolute) return { error: `'${vaultPath}' resolves outside the configured vault.` };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { error: `'${vaultPath}' does not exist.` };
  }
  if (!stat.isFile()) return { error: `'${vaultPath}' is not a file.` };
  if (stat.size > MAX_NOTE_BYTES) {
    return {
      error: `'${vaultPath}' is larger than the 4 MiB note limit; it is not a plan document.`,
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf-8");
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
  const parsed = parsePlanDocument(text);
  if ("error" in parsed) return { error: `'${vaultPath}': ${parsed.error}` };
  if (isSnapshotFrontmatter(parsed.document.frontmatter)) {
    return {
      error:
        `'${vaultPath}' is a stored snapshot: snapshots are immutable and are read by ` +
        "`plan_history`, never edited.",
    };
  }
  return { text, document: parsed.document, stat };
}

/**
 * Atomic write: temp file in the same directory, size check, mtime re-check,
 * then `rename`. The re-check is what turns a concurrent Obsidian save into a
 * refusal instead of a silent overwrite.
 */
export function writeStored(
  root: PlanRoot,
  vaultPath: string,
  text: string,
  options: { create?: boolean; expected?: fs.Stats } = {},
): { ok: true } | { error: string } {
  const absolute = resolveInsideVault(root.vaultRoot, vaultPath);
  if (!absolute) return { error: `'${vaultPath}' resolves outside the configured vault.` };
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > MAX_NOTE_BYTES) {
    return {
      error: `The document would be ${bytes} bytes; the note limit is ${MAX_NOTE_BYTES}. Split it.`,
    };
  }
  if (options.create && fs.existsSync(absolute)) {
    return {
      error:
        `'${vaultPath}' already exists; a create never overwrites a file. Read it with ` +
        "`plan_read` and update it instead.",
    };
  }

  const temp = `${absolute}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(temp, text, { encoding: "utf-8", flag: "wx" });

    if (options.expected) {
      const current = fs.statSync(absolute);
      if (
        current.size !== options.expected.size ||
        current.mtimeMs !== options.expected.mtimeMs
      ) {
        fs.rmSync(temp, { force: true });
        return {
          error:
            `'${vaultPath}' changed on disk while it was being edited (another agent, or ` +
            "Obsidian saving). Re-read the node and repeat the change; nothing was overwritten.",
        };
      }
    }
    fs.renameSync(temp, absolute);
    return { ok: true };
  } catch (cause) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The temp file may not exist; the original error is the useful one.
    }
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Captures the current state into `__history`; an existing snapshot is left alone. */
function takeSnapshot(
  root: PlanRoot,
  node: PlanNode,
  reason: SnapshotReason,
): { path: string } | { error: string } {
  const version = positiveInt(node.frontmatter.version);
  const revision = positiveInt(node.frontmatter.revision);
  if (version === null || revision === null) {
    return {
      error:
        `'${node.vaultPath}' has no positive integer \`version\`/\`revision\`; fix the ` +
        "frontmatter by hand before changing the node (a snapshot without counters cannot be named).",
    };
  }
  const built = buildSnapshot(node.frontmatter, {
    of: node.vaultPath,
    reason,
    version,
    revision,
  });
  if ("error" in built) return { error: built.error };

  const absolute = resolveInsideVault(root.vaultRoot, built.path);
  if (!absolute) return { error: `Snapshot path '${built.path}' resolves outside the vault.` };
  if (fs.existsSync(absolute)) return { path: built.path };

  const name =
    stringField(node.frontmatter.name) ?? path.posix.basename(node.vaultPath, ".md");
  const text = serializePlanDocument({ frontmatter: built.frontmatter, body: `# ${name}` });
  const written = writeStored(root, built.path, text, { create: true });
  if ("error" in written) return written;
  return { path: built.path };
}

export interface NodeChange {
  /** Frontmatter after the change; counters and bookkeeping are set here. */
  next: Record<string, unknown>;
  /** `revision` for a refinement, `version` when the file starts describing something else. */
  bump: "revision" | "version";
  reason: SnapshotReason;
  /** Replacement `## Заметки` text; omitted keeps the current sections. */
  notes?: string;
}

export type NodeChangeResult =
  | { version: number; revision: number; snapshot: string }
  | { error: string };

/**
 * Applies one frontmatter change to an already-read node: snapshot first, then
 * temp + rename, then the counters. Every stage-5 tool goes through this, so a
 * link, an incident attachment and a goal proposal all take a snapshot and bump
 * the revision the same way.
 */
export function commitNodeChange(
  settings: RuntimeSettings,
  root: PlanRoot,
  node: PlanNode,
  stored: StoredFile,
  change: NodeChange,
  actor: string,
): NodeChangeResult {
  const version = positiveInt(stored.document.frontmatter.version) ?? 1;
  const revision = positiveInt(stored.document.frontmatter.revision) ?? 1;
  const next: Record<string, unknown> = { ...change.next };
  if (change.bump === "version") {
    next.version = version + 1;
    next.revision = 1;
  } else {
    next.version = version;
    next.revision = revision + 1;
  }
  next.updated = nowIso();
  next.updated_by = actor;

  const body = renderPlanBody(
    next,
    change.notes === undefined ? stored.document.body : `## Заметки\n\n${change.notes}`,
  );
  const text = serializePlanDocument({ frontmatter: next, body });

  const gate = refusalFor(settings, text.length);
  if (gate) return { error: gate.text };

  const snapshot = takeSnapshot(
    root,
    { ...node, frontmatter: stored.document.frontmatter, body: stored.document.body },
    change.reason,
  );
  if ("error" in snapshot) return snapshot;

  const written = writeStored(root, node.vaultPath, text, { expected: stored.stat });
  if ("error" in written) return written;
  return {
    version: next.version as number,
    revision: next.revision as number,
    snapshot: snapshot.path,
  };
}

/**
 * Reads a live node and applies the standard refusals before any change: a
 * stale `expected_revision`, a hand edit newer than `updated`, an unreadable
 * frontmatter or a snapshot. Stage-5 tools never write a file they have not
 * passed through this gate.
 */
export function loadWritableNode(
  root: PlanRoot,
  node: PlanNode,
  input: Record<string, unknown>,
): { stored: StoredFile } | { error: ToolOutcome } {
  const stored = readStored(root, node.vaultPath);
  if ("error" in stored) return { error: fail(stored.error) };

  const expected =
    typeof input.expected_revision === "number" && Number.isFinite(input.expected_revision)
      ? Math.trunc(input.expected_revision)
      : null;
  const stale = revisionRefusal(node.vaultPath, stored.document.frontmatter, expected);
  if (stale) {
    return {
      error: fail(stale, {
        version: positiveInt(stored.document.frontmatter.version),
        revision: positiveInt(stored.document.frontmatter.revision),
      }),
    };
  }
  const external = externalEditRefusal(
    node.vaultPath,
    stored.document.frontmatter,
    stored.stat,
    input.accept_external === true,
  );
  if (external) return { error: fail(external) };
  return { stored };
}

/**
 * A hand edit in Obsidian is allowed; the tools treat it as external. The
 * frontmatter `updated` timestamp is the contract, so a file whose mtime is
 * newer than that needs an explicit `accept_external` before a write.
 */
export function externalEditRefusal(
  vaultPath: string,
  frontmatter: Record<string, unknown>,
  stat: fs.Stats,
  acceptExternal: boolean,
): string | null {
  if (acceptExternal) return null;
  const recorded = Date.parse(String(frontmatter.updated ?? ""));
  if (Number.isNaN(recorded)) return null;
  // Filesystem timestamp granularity and clock skew: two seconds of slack.
  if (stat.mtimeMs <= recorded + 2_000) return null;
  return (
    `'${vaultPath}' changed on disk after its last recorded write ` +
    `(updated ${String(frontmatter.updated)}, file ${new Date(stat.mtimeMs).toISOString()}). ` +
    "Re-read the node; pass `accept_external: true` to write over the external change anyway."
  );
}

export function revisionRefusal(
  vaultPath: string,
  frontmatter: Record<string, unknown>,
  expected: number | null,
): string | null {
  if (expected === null) return null;
  const revision = positiveInt(frontmatter.revision);
  const version = positiveInt(frontmatter.version);
  if (revision === expected) return null;
  return (
    `'${vaultPath}' is at v${String(version)} r${String(revision)}, not r${expected}. ` +
    "Re-read the node and repeat the change against the current revision."
  );
}

function allowedTargets(kind: PlanKind, from: string): readonly string[] {
  if (kind === "incident") {
    return (INCIDENT_TRANSITIONS as Record<string, readonly string[]>)[from] ?? [];
  }
  if (kind === "goal") return (GOAL_TRANSITIONS as Record<string, readonly string[]>)[from] ?? [];
  return (LEAF_TRANSITIONS as Record<string, readonly string[]>)[from] ?? [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function refusalFor(settings: RuntimeSettings, chars: number): ToolOutcome | null {
  const refusal = writeRefusal(settings, chars);
  return refusal ? fail(refusal) : null;
}

/**
 * `readOnly` is checked before anything else is inspected: a disabled write must
 * not depend on the file's state, its mtime or its size to be refused.
 */
export function readOnlyRefusal(settings: RuntimeSettings): ToolOutcome | null {
  return settings.readOnly ? fail(writeRefusal(settings, 0) as string) : null;
}

// ---------------------------------------------------------------------------
// plan_create_node
// ---------------------------------------------------------------------------

interface CreateTarget {
  relPath: string;
  vaultPath: string;
  slug: string;
  project: string | null;
}

function targetForCreate(
  root: PlanRoot,
  rawPath: string,
  kind: NodeKind,
): CreateTarget | { error: string } {
  const normalized = normalizePlanPath(rawPath);
  if (normalized === null) {
    return {
      error:
        `'${rawPath}' is not a path inside the planning directory: pass a path relative to ` +
        "`planRoot`, without `..`, an absolute path or `.obsidian`.",
    };
  }
  const clean = normalized.replace(/\.md$/i, "");
  const slug = path.posix.basename(clean);
  if (slug.length === 0) return { error: "The path must end with a node name." };

  const folder = kind === "leaf" ? path.posix.dirname(clean) : clean;
  if (folder === "." || folder.length === 0) {
    return {
      error:
        "A leaf lives in its parent's folder: pass e.g. `centurion/backend/auth/session-store`, " +
        "not a name at the planning root.",
    };
  }
  const vaultPath = path.posix.join(root.relPath, folder, `${slug}.md`);
  const project = folder.split("/")[0];
  return {
    relPath: path.posix.join(folder, `${slug}.md`),
    vaultPath,
    slug,
    project: project.startsWith("_") ? null : project,
  };
}

function inferParent(tree: PlanTree, kind: NodeKind, folder: string): PlanNode | null {
  if (kind === "root") return null;
  const parentFolder =
    kind === "leaf" ? folder : path.posix.dirname(folder);
  if (parentFolder === "." || parentFolder.length === 0) return null;
  const candidate = path.posix.join(
    tree.root.relPath,
    parentFolder,
    `${path.posix.basename(parentFolder)}.md`,
  );
  return tree.nodes.get(candidate) ?? null;
}

/** Adds a child link to the parent and bumps its revision, snapshot first. */
function appendChild(
  root: PlanRoot,
  parent: PlanNode,
  childVaultPath: string,
  actor: string,
): { revision: number | null } | { error: string } {
  const stored = readStored(root, parent.vaultPath);
  if ("error" in stored) return stored;
  const link = wikilinkFor(childVaultPath);
  const children = Array.isArray(stored.document.frontmatter.children)
    ? [...stored.document.frontmatter.children]
    : [];
  if (children.some((entry) => entry === link)) return { revision: null };
  children.push(link);

  const version = positiveInt(stored.document.frontmatter.version) ?? 1;
  const revision = positiveInt(stored.document.frontmatter.revision) ?? 1;
  const snapshot = takeSnapshot(
    root,
    { ...parent, frontmatter: stored.document.frontmatter, body: stored.document.body },
    "content_update",
  );
  if ("error" in snapshot) return snapshot;

  const next: Record<string, unknown> = {
    ...stored.document.frontmatter,
    children,
    version,
    revision: revision + 1,
    updated: nowIso(),
    updated_by: actor,
  };
  const body = renderPlanBody(next, stored.document.body);
  const written = writeStored(
    root,
    parent.vaultPath,
    serializePlanDocument({ frontmatter: next, body }),
    { expected: stored.stat },
  );
  if ("error" in written) return written;
  return { revision: revision + 1 };
}

export function planCreateNode(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const kindValue = stringField(input.kind);
  if (!kindValue || !isNodeKind(kindValue)) {
    return fail(
      "`kind` must be one of root, trunk, branch, subbranch, leaf. Incidents and goals have " +
        "their own tools (`plan_incident`, `plan_goal`).",
    );
  }
  const kind: NodeKind = kindValue;

  const name = stringField(input.name);
  if (!name) return fail("`name` is required: it is what a reader sees.");
  const description = typeof input.description === "string" ? input.description.trim() : "";

  const rawPath = stringField(input.path);
  if (!rawPath) {
    return fail(
      "`path` is required: the node path relative to the planning root, e.g. " +
        "`centurion/backend/auth` for a branch or `centurion/backend/auth/session-store` for a leaf.",
    );
  }

  const target = targetForCreate(root, rawPath, kind);
  if ("error" in target) return fail(target.error);

  const status = stringField(input.status) ?? "draft";
  if (!(LEAF_STATUSES as readonly string[]).includes(status)) {
    return fail(
      `'${status}' is not a node status. Use one of ${LEAF_STATUSES.join(", ")}.`,
    );
  }

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  let parent: PlanNode | null = null;
  if (kind !== "root") {
    if (typeof input.parent === "string" && input.parent.trim().length > 0) {
      parent = resolveLink(tree, input.parent);
      if (!parent) {
        return fail(`Parent '${input.parent}' is not a plan node in this tree.`, {
          suggestions: suggestPlanNodes(tree, input.parent),
        });
      }
    } else {
      parent = inferParent(
        tree,
        kind,
        path.posix.dirname(target.relPath) === "." ? "" : path.posix.dirname(target.relPath),
      );
    }
    if (!parent) {
      return fail(
        `'${target.relPath}' would have no parent. Create the parent node first, or pass ` +
          "`parent` explicitly; a tree node is never an orphan.",
      );
    }
    if (parent) {
      const parentKind = kindOf(parent);
      if (!parentKind || !isNodeKind(parentKind)) {
        return fail(`'${parent.relPath}' is not a tree node, so it cannot have children.`);
      }
      if (!canHaveChild(parentKind, kind)) {
        return fail(
          `A ${parentKind} cannot have a ${kind} child. Allowed here: ` +
            `${ALLOWED_CHILD_KINDS[parentKind].join(", ")}.`,
        );
      }
    }
  }

  const actor = actorOf(input);
  const now = nowIso();
  const frontmatter: Record<string, unknown> = {
    id: stringField(input.id) ?? crypto.randomUUID(),
    schema: 1,
    kind,
    name,
    description,
    status,
    version: 1,
    revision: 1,
    parent: parent ? wikilinkFor(parent.vaultPath) : null,
    children: [],
    influences: [],
    blocked_by: [],
    ...(kind === "root" && stringField(input.project_key)
      ? { project_key: stringField(input.project_key) }
      : {}),
    ...(isRecord(input.brief) ? { brief: input.brief } : {}),
    ...(isRecord(input.payload) ? { payload: input.payload } : {}),
    ...(Array.isArray(input.stack) ? { stack: input.stack } : {}),
    ...(Array.isArray(input.aliases) ? { aliases: input.aliases } : {}),
    journal: [],
    created: now,
    updated: now,
    created_by: actor,
    updated_by: actor,
    tags: [`plan/${kind}`, `plan/status/${status}`],
    archived: null,
  };
  const ordered = orderPlanKeys(frontmatter);
  const notes = typeof input.notes === "string" ? input.notes : "";
  const body = renderPlanBody(ordered, notes.length > 0 ? `## Заметки\n\n${notes}` : "");
  const text = serializePlanDocument({ frontmatter: ordered, body });

  const gate = refusalFor(settings, text.length);
  if (gate) return gate;

  const written = writeStored(root, target.vaultPath, text, { create: true });
  if ("error" in written) return fail(written.error);

  let parentRevision: number | null = null;
  if (parent) {
    const attached = appendChild(root, parent, target.vaultPath, actor);
    if ("error" in attached) {
      return fail(
        `The node file was created, but its parent '${parent.relPath}' could not be updated: ` +
          `${attached.error}. Run \`plan_validate\` once it exists; no data was lost.`,
        { path: target.relPath, vault_path: target.vaultPath, partial: true },
      );
    }
    parentRevision = attached.revision;
  }

  const journal = appendJournal(root, target.project, {
    at: now,
    op: "plan_create_node",
    target: wikilinkFor(target.vaultPath),
    result: `v1 r1${parent ? ` · parent ${wikilinkFor(parent.vaultPath)} r${parentRevision ?? "?"}` : ""}`,
    actor,
  });

  return json({
    ok: true,
    path: target.relPath,
    vault_path: target.vaultPath,
    id: ordered.id,
    kind,
    name,
    status,
    version: 1,
    revision: 1,
    parent: parent ? summarize(parent) : null,
    parent_revision: parentRevision,
    snapshot: null,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
  });
}

// ---------------------------------------------------------------------------
// plan_update_node
// ---------------------------------------------------------------------------

export function planUpdateNode(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const rawPath = stringField(input.path);
  if (!rawPath) return fail("`path` is required.");
  if (isPlanSystemPath(rawPath)) {
    return fail(
      `'${rawPath}' is history or the archive: snapshots are immutable, archived subtrees are ` +
        "restored by `plan_restore`, not edited.",
    );
  }

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;
  const found = findPlanNode(tree, rawPath);
  if ("error" in found) return fail(found.error, { suggestions: found.suggestions });
  const node = found.node;

  const stored = readStored(root, node.vaultPath);
  if ("error" in stored) return fail(stored.error);

  const expected =
    typeof input.expected_revision === "number" && Number.isFinite(input.expected_revision)
      ? Math.trunc(input.expected_revision)
      : null;
  const stale = revisionRefusal(node.vaultPath, stored.document.frontmatter, expected);
  if (stale) {
    return fail(stale, {
      version: positiveInt(stored.document.frontmatter.version),
      revision: positiveInt(stored.document.frontmatter.revision),
    });
  }
  const external = externalEditRefusal(
    node.vaultPath,
    stored.document.frontmatter,
    stored.stat,
    input.accept_external === true,
  );
  if (external) return fail(external);

  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const next: Record<string, unknown> = { ...stored.document.frontmatter };
  let changed = false;

  if (has("name")) {
    const name = stringField(input.name);
    if (!name) return fail("`name` cannot be empty.");
    next.name = name;
    changed = true;
  }
  if (has("description")) {
    next.description = typeof input.description === "string" ? input.description.trim() : "";
    changed = true;
  }
  if (has("brief")) {
    if (input.brief === null) delete next.brief;
    else if (isRecord(input.brief)) next.brief = input.brief;
    else return fail("`brief` must be an object or null.");
    changed = true;
  }
  if (has("payload")) {
    if (input.payload === null) delete next.payload;
    else if (isRecord(input.payload)) next.payload = input.payload;
    else return fail("`payload` must be an object or null.");
    changed = true;
  }

  const kindValue = stringField(input.kind);
  let kindChanged = false;
  if (kindValue !== null) {
    const currentKind = kindOf(node);
    if (!isNodeKind(kindValue)) {
      return fail("`kind` must be one of root, trunk, branch, subbranch, leaf.");
    }
    if (kindValue !== currentKind) {
      const parent = typeof node.frontmatter.parent === "string"
        ? resolveLink(tree, node.frontmatter.parent)
        : null;
      const parentKind = parent ? kindOf(parent) : null;
      if (parent && parentKind && isNodeKind(parentKind) && !canHaveChild(parentKind, kindValue)) {
        return fail(
          `A ${parentKind} cannot have a ${kindValue} child. Allowed here: ` +
            `${ALLOWED_CHILD_KINDS[parentKind].join(", ")}.`,
        );
      }
      const children = Array.isArray(next.children) ? next.children : [];
      for (const entry of children) {
        const child = resolveLink(tree, entry);
        const childKind = child ? kindOf(child) : null;
        if (childKind && isNodeKind(childKind) && !ALLOWED_CHILD_KINDS[kindValue].includes(childKind)) {
          return fail(
            `Changing the kind to ${kindValue} would orphan a ${childKind} child ` +
              `('${child?.relPath}'). Move the children first.`,
          );
        }
      }
      next.kind = kindValue;
      kindChanged = true;
      changed = true;
    }
  }

  if (!changed) {
    return fail(
      "Nothing to update: pass at least one of `description`, `name`, `brief`, `payload`, `kind`.",
    );
  }

  const version = positiveInt(stored.document.frontmatter.version) ?? 1;
  const revision = positiveInt(stored.document.frontmatter.revision) ?? 1;
  const actor = actorOf(input);
  const now = nowIso();

  if (kindChanged) {
    next.version = version + 1;
    next.revision = 1;
  } else {
    next.version = version;
    next.revision = revision + 1;
  }
  next.updated = now;
  next.updated_by = actor;

  const hasNotes = has("notes");
  const body = renderPlanBody(
    next,
    hasNotes ? `## Заметки\n\n${typeof input.notes === "string" ? input.notes : ""}` : stored.document.body,
  );
  const text = serializePlanDocument({ frontmatter: next, body });

  const gate = refusalFor(settings, text.length);
  if (gate) return gate;

  const snapshot = takeSnapshot(
    root,
    { ...node, frontmatter: stored.document.frontmatter, body: stored.document.body },
    kindChanged ? "version_bump" : "content_update",
  );
  if ("error" in snapshot) return fail(snapshot.error);

  const written = writeStored(root, node.vaultPath, text, { expected: stored.stat });
  if ("error" in written) return fail(written.error);

  const journal = appendJournal(root, projectOf(node), {
    at: now,
    op: "plan_update_node",
    target: wikilinkFor(node.vaultPath),
    result: `v${version} r${revision} → ${kindChanged ? `v${version + 1} r1` : `r${revision + 1}`}`,
    actor,
  });

  return json({
    ok: true,
    path: node.relPath,
    vault_path: node.vaultPath,
    kind: kindOf({ ...node, frontmatter: next }),
    version: next.version,
    revision: next.revision,
    snapshot: snapshot.path,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
  });
}

// ---------------------------------------------------------------------------
// plan_set_status
// ---------------------------------------------------------------------------

export function planSetStatus(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const rawPath = stringField(input.path);
  if (!rawPath) return fail("`path` is required.");
  if (isPlanSystemPath(rawPath)) {
    return fail(`'${rawPath}' is history or the archive, not a live node.`);
  }

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;
  const found = findPlanNode(tree, rawPath);
  if ("error" in found) return fail(found.error, { suggestions: found.suggestions });
  const node = found.node;

  const stored = readStored(root, node.vaultPath);
  if ("error" in stored) return fail(stored.error);
  const frontmatter = stored.document.frontmatter;

  const kind = kindOf(node);
  const from = statusOf(node);
  if (!kind || from === null) {
    return fail(`'${node.relPath}' has no \`kind\` or no \`status\` in its frontmatter.`);
  }
  const to = stringField(input.status);
  if (!to) return fail("`status` is required.");

  if (!statusesOfKind(kind).includes(to)) {
    return fail(
      `'${to}' is not a status of a ${kind}. Use one of ${statusesOfKind(kind).join(", ")}.`,
    );
  }
  if (!canTransitionStatus(kind, from, to)) {
    const allowed = allowedTargets(kind, from);
    return fail(
      `'${node.relPath}' cannot go ${from} → ${to}. Allowed from ${from}: ` +
        `${allowed.join(", ") || "none"} (nothing was written).`,
      { status: from, allowed },
    );
  }

  const expected =
    typeof input.expected_revision === "number" && Number.isFinite(input.expected_revision)
      ? Math.trunc(input.expected_revision)
      : null;
  const stale = revisionRefusal(node.vaultPath, frontmatter, expected);
  if (stale) {
    return fail(stale, {
      version: positiveInt(frontmatter.version),
      revision: positiveInt(frontmatter.revision),
    });
  }
  const external = externalEditRefusal(
    node.vaultPath,
    frontmatter,
    stored.stat,
    input.accept_external === true,
  );
  if (external) return fail(external);

  const actor = actorOf(input);
  const reason = stringField(input.reason);
  // A status a person set is the owner's decision; an agent changing it owes a
  // reason, and that reason is kept in the journal.
  const setter = stringField(frontmatter.status_by) ?? stringField(frontmatter.updated_by);
  if (setter === "user" && actor !== "user" && reason === null) {
    return fail(
      `The current status was set by the user. Pass \`reason\` to override it; the reason is ` +
        "recorded in the journal.",
      { status: from, set_by: setter },
    );
  }

  const version = positiveInt(frontmatter.version) ?? 1;
  const revision = positiveInt(frontmatter.revision) ?? 1;
  const now = nowIso();
  const next: Record<string, unknown> = {
    ...frontmatter,
    status: to,
    status_by: actor,
    ...(reason ? { status_reason: reason } : {}),
    version,
    revision: revision + 1,
    updated: now,
    updated_by: actor,
  };
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter(
        (tag): tag is string => typeof tag === "string" && !tag.startsWith("plan/status/"),
      )
    : [];
  if (kind !== "incident" && kind !== "goal") {
    next.tags = [...tags, `plan/status/${to}`];
  }

  const body = renderPlanBody(next, stored.document.body);
  const text = serializePlanDocument({ frontmatter: next, body });

  const gate = refusalFor(settings, text.length);
  if (gate) return gate;

  const snapshot = takeSnapshot(
    root,
    { ...node, frontmatter, body: stored.document.body },
    "status_change",
  );
  if ("error" in snapshot) return fail(snapshot.error);

  const written = writeStored(root, node.vaultPath, text, { expected: stored.stat });
  if ("error" in written) return fail(written.error);

  const journal = appendJournal(root, projectOf(node), {
    at: now,
    op: "plan_set_status",
    target: wikilinkFor(node.vaultPath),
    result: `v${version} r${revision} → r${revision + 1}`,
    actor,
    status: `${from} → ${to}`,
    reason: reason ?? undefined,
  });

  return json({
    ok: true,
    path: node.relPath,
    vault_path: node.vaultPath,
    kind,
    status: to,
    previous_status: from,
    version,
    revision: revision + 1,
    snapshot: snapshot.path,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
  });
}

// ---------------------------------------------------------------------------
// plan_history
// ---------------------------------------------------------------------------

export function planHistory(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const rawPath = stringField(input.path);
  if (!rawPath) return fail("`path` is required: the live node whose history you want.");
  if (isPlanSystemPath(rawPath)) {
    return fail(
      `'${rawPath}' is already a snapshot or an archived file. Pass the live node path; snapshots ` +
        "are selected with `version` and `revision`.",
    );
  }

  const resolvedPath = resolvePlanPath(root, rawPath);
  if ("error" in resolvedPath) return fail(resolvedPath.error);
  const vaultPath = resolvedPath.vaultPath.endsWith(".md")
    ? resolvedPath.vaultPath
    : `${resolvedPath.vaultPath}.md`;
  const slug = path.posix.basename(vaultPath, ".md");
  const historyDir = path.posix.join(path.posix.dirname(vaultPath), "__history");
  const absoluteDir = path.join(root.vaultRoot, historyDir);

  let names: string[] = [];
  try {
    names = fs.readdirSync(absoluteDir);
  } catch {
    names = [];
  }

  const snapshots: Array<{
    version: number;
    revision: number;
    path: string;
    reason: string | null;
    at: string | null;
    actor: string | null;
    bytes: number;
  }> = [];

  for (const name of names) {
    const match = /^(.+)\.v(\d+)\.r(\d+)\.md$/i.exec(name);
    if (!match || match[1] !== slug) continue;
    const snapshotRel = path.posix.join(historyDir, name);
    let frontmatter: Record<string, unknown> = {};
    let bytes = 0;
    try {
      const absolute = path.join(root.vaultRoot, snapshotRel);
      const stat = fs.statSync(absolute);
      bytes = stat.size;
      const parsed = parsePlanDocument(fs.readFileSync(absolute, "utf-8"));
      if (!("error" in parsed)) frontmatter = parsed.document.frontmatter;
    } catch {
      continue;
    }
    snapshots.push({
      version: Number.parseInt(match[2], 10),
      revision: Number.parseInt(match[3], 10),
      path: snapshotRel,
      reason: stringField(frontmatter.snapshot_reason),
      at: stringField(frontmatter.updated),
      actor: stringField(frontmatter.updated_by),
      bytes,
    });
  }
  snapshots.sort((left, right) => left.version - right.version || left.revision - right.revision);

  const wantVersion =
    typeof input.version === "number" && Number.isFinite(input.version)
      ? Math.trunc(input.version)
      : null;
  const wantRevision =
    typeof input.revision === "number" && Number.isFinite(input.revision)
      ? Math.trunc(input.revision)
      : null;

  if (wantVersion !== null || wantRevision !== null) {
    const match = snapshots.find(
      (entry) =>
        (wantVersion === null || entry.version === wantVersion) &&
        (wantRevision === null || entry.revision === wantRevision),
    );
    if (!match) {
      return fail(
        `No snapshot ${wantVersion !== null ? `v${wantVersion}` : ""}` +
          `${wantRevision !== null ? ` r${wantRevision}` : ""} for '${vaultPath}'.`,
        { snapshots: snapshots.slice(-10) },
      );
    }
    let text = "";
    try {
      text = fs.readFileSync(path.join(root.vaultRoot, match.path), "utf-8");
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : String(cause));
    }
    const parsed = parsePlanDocument(text);
    if ("error" in parsed) return fail(`${match.path}: ${parsed.error}`);
    return json({
      ok: true,
      path: vaultPath,
      snapshot: { ...match, frontmatter: parsed.document.frontmatter },
      body: parsed.document.body,
    });
  }

  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(200, Math.trunc(input.limit)))
      : 50;
  const window = snapshots.slice(-limit);

  return json({
    ok: true,
    path: vaultPath,
    count: snapshots.length,
    snapshots: window,
    note:
      snapshots.length === 0
        ? "No snapshots yet: they appear after the first change to this node."
        : null,
  });
}
