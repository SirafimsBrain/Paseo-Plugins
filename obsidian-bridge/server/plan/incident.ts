import * as crypto from "node:crypto";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { serializePlanDocument, stringField } from "./frontmatter";
import { appendJournal } from "./journal";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  orderPlanKeys,
  type IncidentSeverity,
  type IncidentStatus,
} from "./model";
import { resolvePlanPath, resolvePlanRoot, type PlanRoot } from "./paths";
import {
  findPlanNode,
  kindOf,
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
  commitNodeChange,
  fail,
  json,
  loadWritableNode,
  nowIso,
  readOnlyRefusal,
  writeStored,
  wikilinkFor,
} from "./write";

/**
 * `plan_incident`: a defect that blocks one or more leaves.
 *
 * The relation is stored on **both** ends — `blocks:` on the incident,
 * `blocked_by:` on each leaf — and this tool is the only writer of the pair, so
 * a reader in Obsidian sees the link from either side. Only `open` and
 * `investigating` incidents block; `plan_read` computes that from the status, so
 * resolving an incident unblocks its leaves without rewriting them.
 */

const INCIDENT_FOLDER = "_incidents";

type SeverityResult = { severity: IncidentSeverity } | { error: string };

function severityOf(value: unknown, fallback: string | null): SeverityResult {
  const raw = stringField(value);
  if (raw === null) {
    const inherited = fallback ?? "medium";
    return (INCIDENT_SEVERITIES as readonly string[]).includes(inherited)
      ? { severity: inherited as IncidentSeverity }
      : { error: `The stored severity '${inherited}' is not one of ${INCIDENT_SEVERITIES.join(", ")}.` };
  }
  if (!(INCIDENT_SEVERITIES as readonly string[]).includes(raw)) {
    return { error: `'${raw}' is not a severity. Use one of ${INCIDENT_SEVERITIES.join(", ")}.` };
  }
  return { severity: raw as IncidentSeverity };
}

/** A project root for `input.project` (a link, a folder name or a root path). */
function resolveProject(tree: PlanTree, value: string | null): PlanNode | null {
  if (!value) return null;
  const direct = resolveLink(tree, value);
  if (direct && kindOf(direct) === "root") return direct;
  const clean = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const slug = clean.split("/").pop() ?? clean;
  const byFolder = tree.nodes.get(`${tree.root.relPath}/${clean}/${slug}.md`);
  return byFolder && kindOf(byFolder) === "root" ? byFolder : null;
}

/** The leaf a `blocks`/`unblock` entry names, validated against the project. */
function leafForIncident(
  tree: PlanTree,
  value: unknown,
  project: string | null,
): { node: PlanNode } | { error: string } {
  const raw = stringField(value);
  if (!raw) return { error: "Every entry of `blocks`/`unblock` must be a leaf path." };
  const found = findPlanNode(tree, raw);
  if ("error" in found) {
    const hints = found.suggestions.map((row) => `'${row.path}'`).join(", ");
    return {
      error: `'${raw}' is not a plan node${hints.length > 0 ? `; did you mean ${hints}?` : "."}`,
    };
  }
  if (kindOf(found.node) !== "leaf") {
    return { error: `'${found.node.relPath}' is not a leaf; only leaves can be blocked.` };
  }
  if (project !== null && projectOf(found.node) !== project) {
    return {
      error:
        `'${found.node.relPath}' belongs to another project ('${projectOf(found.node) ?? "none"}'); ` +
        `this incident is in '${project}'.`,
    };
  }
  return { node: found.node };
}

interface BlockerChange {
  changed: boolean;
  revision: number | null;
  snapshot: string | null;
}

/**
 * Adds or removes one incident link in a leaf's `blocked_by`, snapshotting the
 * leaf first. An already-correct list is left untouched, so re-running an
 * operation is safe and does not inflate revisions.
 */
function setBlocker(
  settings: RuntimeSettings,
  root: PlanRoot,
  tree: PlanTree,
  leaf: PlanNode,
  incidentPath: string,
  wanted: boolean,
  actor: string,
  acceptExternal: boolean,
): BlockerChange | { error: string } {
  const prepared = loadWritableNode(root, leaf, { accept_external: acceptExternal });
  if ("error" in prepared) return { error: prepared.error.text };
  const stored = prepared.stored;
  const frontmatter = stored.document.frontmatter;
  const current = Array.isArray(frontmatter.blocked_by) ? [...frontmatter.blocked_by] : [];
  const matching = (entry: unknown) =>
    resolveLink(tree, entry)?.vaultPath === incidentPath;

  const present = current.some(matching);
  if (present === wanted) return { changed: false, revision: null, snapshot: null };

  const nextList = wanted
    ? [...current, wikilinkFor(incidentPath)]
    : current.filter((entry) => !matching(entry));

  const change = commitNodeChange(
    settings,
    root,
    leaf,
    stored,
    { next: { ...frontmatter, blocked_by: nextList }, bump: "revision", reason: "link_update" },
    actor,
  );
  if ("error" in change) return { error: change.error };
  return { changed: true, revision: change.revision, snapshot: change.snapshot };
}

export function planIncident(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const rawPath = stringField(input.path);
  if (!rawPath) {
    return fail(
      "`path` is required: the incident path `<project>/_incidents/<slug>`, e.g. " +
        "`centurion/_incidents/inc-7-session-loss`.",
    );
  }
  const resolvedPath = resolvePlanPath(root, rawPath);
  if ("error" in resolvedPath) return fail(resolvedPath.error);

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const found = findPlanNode(tree, rawPath);
  const existing = "error" in found ? null : found.node;
  if (existing && kindOf(existing) !== "incident") {
    return fail(
      `'${existing.relPath}' is a ${kindOf(existing) ?? "document"}, not an incident. An incident ` +
        "is its own file with `kind: incident`.",
    );
  }
  const vaultTarget = resolvedPath.vaultPath.endsWith(".md")
    ? resolvedPath.vaultPath
    : `${resolvedPath.vaultPath}.md`;
  const noteRelPath = resolvedPath.relPath.endsWith(".md")
    ? resolvedPath.relPath
    : `${resolvedPath.relPath}.md`;
  const collision = tree.nodes.get(vaultTarget);
  if (!existing && collision) {
    return fail(`'${collision.relPath}' already exists; an incident never overwrites a node.`);
  }

  const blocksInput = Array.isArray(input.blocks) ? input.blocks : [];
  const unblockInput = Array.isArray(input.unblock) ? input.unblock : [];
  const actor = actorOf(input);
  const acceptExternal = input.accept_external === true;
  const now = nowIso();

  const folder = path.posix.dirname(resolvedPath.relPath);
  const projectFromPath = folder.split("/")[0];
  const declaredProject = stringField(input.project);

  if (!existing) {
    if (folder.split("/").pop() !== INCIDENT_FOLDER) {
      return fail(
        `An incident lives in '<project>/${INCIDENT_FOLDER}/<slug>' — got '${folder}'. Pass e.g. ` +
          `\`${projectFromPath}/${INCIDENT_FOLDER}/inc-8-token-leak\`.`,
      );
    }
    const name = stringField(input.name);
    if (!name) return fail("`name` is required when the incident file does not exist yet.");

    const status = (stringField(input.status) ?? "open") as IncidentStatus;
    if (!(INCIDENT_STATUSES as readonly string[]).includes(status)) {
      return fail(
        `'${status}' is not an incident status. Use one of ${INCIDENT_STATUSES.join(", ")}.`,
      );
    }
    const severity = severityOf(input.severity, null);
    if ("error" in severity) return fail(severity.error);

    const project = declaredProject ?? (projectFromPath.startsWith("_") ? null : projectFromPath);
    const projectNode = resolveProject(tree, project);
    if (project === null) {
      return fail(
        "The incident path does not name a project. Pass `project` (a project folder or root " +
          "link) so the incident knows which plan it belongs to.",
      );
    }
    if (declaredProject && !projectNode) {
      return fail(`Project '${declaredProject}' is not a plan root in this tree.`, {
        suggestions: suggestPlanNodes(tree, declaredProject),
      });
    }

    const leaves: PlanNode[] = [];
    for (const entry of blocksInput) {
      const leaf = leafForIncident(tree, entry, project);
      if ("error" in leaf) return fail(leaf.error);
      if (!leaves.some((candidate) => candidate.vaultPath === leaf.node.vaultPath)) {
        leaves.push(leaf.node);
      }
    }

    const frontmatter: Record<string, unknown> = {
      id: crypto.randomUUID(),
      schema: 1,
      kind: "incident",
      name,
      description: typeof input.description === "string" ? input.description.trim() : "",
      severity: severity.severity,
      status,
      version: 1,
      revision: 1,
      project: projectNode ? wikilinkFor(projectNode.vaultPath) : null,
      blocks: leaves.map((leaf) => wikilinkFor(leaf.vaultPath)),
      created: now,
      updated: now,
      created_by: actor,
      updated_by: actor,
      tags: ["plan/incident", `plan/severity/${severity.severity}`],
    };
    const ordered = orderPlanKeys(frontmatter);
    const notes = typeof input.notes === "string" ? input.notes : "";
    const body = renderPlanBody(ordered, notes.length > 0 ? `## Заметки\n\n${notes}` : "");
    const text = serializePlanDocument({ frontmatter: ordered, body });

    const written = writeStored(root, vaultTarget, text, { create: true });
    if ("error" in written) return fail(written.error);

    const attached: Array<Record<string, unknown>> = [];
    const failures: Array<Record<string, unknown>> = [];
    for (const leaf of leaves) {
      const synced = setBlocker(
        settings,
        root,
        tree,
        leaf,
        vaultTarget,
        true,
        actor,
        acceptExternal,
      );
      if ("error" in synced) failures.push({ path: leaf.relPath, error: synced.error });
      else if (synced.changed) attached.push({ path: leaf.relPath, revision: synced.revision });
    }

    const journal = appendJournal(root, project, {
      at: now,
      op: "plan_incident",
      target: wikilinkFor(vaultTarget),
      result:
        `created · ${status} · ${severity.severity}` +
        (attached.length > 0 ? ` · blocks ${attached.length}` : ""),
      actor,
    });

    return json({
      ok: failures.length === 0,
      action: "created",
      path: noteRelPath,
      vault_path: vaultTarget,
      kind: "incident",
      name,
      status,
      severity: severity.severity,
      project,
      blocks: leaves.map(summarize),
      attached,
      leaf_errors: failures,
      version: 1,
      revision: 1,
      journal: "path" in journal ? journal.path : null,
      journal_error: "error" in journal ? journal.error : null,
    });
  }

  // ---- update ------------------------------------------------------------
  const incident = existing;
  const prepared = loadWritableNode(root, incident, input);
  if ("error" in prepared) return prepared.error;
  const stored = prepared.stored;
  const frontmatter = stored.document.frontmatter;

  const requestedStatus = stringField(input.status);
  if (requestedStatus !== null && requestedStatus !== stringField(frontmatter.status)) {
    return fail(
      "`plan_incident` does not change the status: use `plan_set_status`, which enforces the " +
        "incident lifecycle and records the reason.",
      { path: incident.relPath, status: stringField(frontmatter.status) },
    );
  }

  const project = projectOf(incident);
  const next: Record<string, unknown> = { ...frontmatter };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(input, "name")) {
    const name = stringField(input.name);
    if (!name) return fail("`name` cannot be empty.");
    next.name = name;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(input, "description")) {
    next.description = typeof input.description === "string" ? input.description.trim() : "";
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(input, "severity")) {
    const severity = severityOf(input.severity, stringField(frontmatter.severity));
    if ("error" in severity) return fail(severity.error);
    next.severity = severity.severity;
    const tags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.filter(
          (tag): tag is string => typeof tag === "string" && !tag.startsWith("plan/severity/"),
        )
      : [];
    next.tags = [...tags, `plan/severity/${severity.severity}`];
    changed = true;
  }

  const currentBlocks = Array.isArray(frontmatter.blocks) ? [...frontmatter.blocks] : [];
  const blockedNow = currentBlocks
    .map((entry) => resolveLink(tree, entry))
    .filter((node): node is PlanNode => node !== null)
    .map((node) => node.vaultPath);
  let working = [...currentBlocks];

  const detached: Array<Record<string, unknown>> = [];
  const attached: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];

  for (const entry of unblockInput) {
    const leaf = leafForIncident(tree, entry, project);
    if ("error" in leaf) return fail(leaf.error);
    const before = working.length;
    working = working.filter(
      (candidate) => resolveLink(tree, candidate)?.vaultPath !== leaf.node.vaultPath,
    );
    if (working.length === before) continue;
    changed = true;
    const synced = setBlocker(
      settings,
      root,
      tree,
      leaf.node,
      incident.vaultPath,
      false,
      actor,
      acceptExternal,
    );
    if ("error" in synced) failures.push({ path: leaf.node.relPath, error: synced.error });
    else if (synced.changed) detached.push({ path: leaf.node.relPath, revision: synced.revision });
  }

  for (const entry of blocksInput) {
    const leaf = leafForIncident(tree, entry, project);
    if ("error" in leaf) return fail(leaf.error);
    changed = true;
    if (blockedNow.includes(leaf.node.vaultPath)) continue;
    if (!working.some((candidate) => resolveLink(tree, candidate)?.vaultPath === leaf.node.vaultPath)) {
      working.push(wikilinkFor(leaf.node.vaultPath));
    }
    const synced = setBlocker(
      settings,
      root,
      tree,
      leaf.node,
      incident.vaultPath,
      true,
      actor,
      acceptExternal,
    );
    if ("error" in synced) failures.push({ path: leaf.node.relPath, error: synced.error });
    else if (synced.changed) attached.push({ path: leaf.node.relPath, revision: synced.revision });
  }

  if (blocksInput.length > 0 || unblockInput.length > 0) next.blocks = working;

  if (!changed) {
    return fail(
      "Nothing to update: pass `name`, `description`, `severity`, `blocks` or `unblock`.",
      { path: incident.relPath, blocks: currentBlocks },
    );
  }

  const change = commitNodeChange(
    settings,
    root,
    incident,
    stored,
    {
      next,
      bump: "revision",
      reason: "content_update",
      ...(Object.prototype.hasOwnProperty.call(input, "notes")
        ? { notes: typeof input.notes === "string" ? input.notes : "" }
        : {}),
    },
    actor,
  );
  if ("error" in change) return fail(change.error);

  const journal = appendJournal(root, project, {
    at: now,
    op: "plan_incident",
    target: wikilinkFor(incident.vaultPath),
    result:
      `updated · v${change.version} r${change.revision}` +
      (attached.length > 0 ? ` · attached ${attached.length}` : "") +
      (detached.length > 0 ? ` · detached ${detached.length}` : ""),
    actor,
  });

  return json({
    ok: failures.length === 0,
    action: "updated",
    path: incident.relPath,
    vault_path: incident.vaultPath,
    kind: "incident",
    status: stringField(frontmatter.status),
    severity: stringField(next.severity),
    blocks: working
      .map((entry) => resolveLink(tree, entry))
      .filter((node): node is PlanNode => node !== null)
      .map(summarize),
    attached,
    detached,
    leaf_errors: failures,
    version: change.version,
    revision: change.revision,
    snapshot: change.snapshot,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
  });
}
