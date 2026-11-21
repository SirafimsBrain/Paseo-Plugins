import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { positiveInt, stringField } from "./frontmatter";
import { appendJournal } from "./journal";
import {
  BEE_STATUSES,
  BEE_TRANSITIONS,
  canTransitionBee,
  type BeeStatus,
} from "./model";
import { resolvePlanRoot } from "./paths";
import {
  findPlanNode,
  kindOf,
  loadPlanTreeFor,
  projectOf,
  resolveLink,
  summarize,
  type PlanNode,
  type PlanTree,
} from "./read";
import {
  actorOf,
  commitNodeChange,
  fail,
  isRecord,
  json,
  loadWritableNode,
  nowIso,
  readOnlyRefusal,
  wikilinkFor,
} from "./write";

/**
 * `plan_link`: a bee — one directed influence between two leaves.
 *
 * Only the source stores the edge (`influences:`); Obsidian derives the reverse
 * direction as a backlink, so the two halves of a relation cannot disagree.
 * Both ends must be leaves of the same project: an influence orders two pieces
 * of work inside one plan, and a cross-project edge would claim a dependency the
 * plan cannot express as a tree.
 */

function leafFor(
  tree: PlanTree,
  value: unknown,
  role: "source" | "target",
): { node: PlanNode } | { error: ToolOutcome } {
  const raw = stringField(value);
  if (!raw) {
    return { error: fail(`\`${role}\` is required: the path of the ${role} leaf.`) };
  }
  const found = findPlanNode(tree, raw);
  if ("error" in found) {
    return { error: fail(found.error, { suggestions: found.suggestions }) };
  }
  if (kindOf(found.node) !== "leaf") {
    return {
      error: fail(
        `'${found.node.relPath}' is a ${kindOf(found.node) ?? "non-plan document"}, not a leaf. ` +
          "An influence joins two leaves; branches order their children, not their peers.",
      ),
    };
  }
  return { node: found.node };
}

/** Index of the influence entry that points at `target`, or -1. */
function entryIndexFor(
  tree: PlanTree,
  entries: unknown[],
  target: PlanNode,
): number {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    if (resolveLink(tree, entry.target)?.vaultPath === target.vaultPath) return index;
  }
  return -1;
}

/** The influence row written for a new edge, addressed the way the tools read it. */
function influenceRow(
  target: PlanNode,
  status: BeeStatus,
  impact: string | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    target: wikilinkFor(target.vaultPath),
    status,
  };
  if (impact) row.impact = impact;
  // No counters in the edge: `version`/`revision` belong to the target and are
  // read from it live, so a cached copy cannot go stale (live test R5).
  return row;
}

export function planLink(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const sourceFound = leafFor(tree, input.source, "source");
  if ("error" in sourceFound) return sourceFound.error;
  const targetFound = leafFor(tree, input.target, "target");
  if ("error" in targetFound) return targetFound.error;
  const source = sourceFound.node;
  const target = targetFound.node;

  if (source.vaultPath === target.vaultPath) {
    return fail(
      `'${source.relPath}' cannot influence itself: an edge needs two different leaves.`,
    );
  }

  const sourceProject = projectOf(source);
  const targetProject = projectOf(target);
  if (sourceProject === null || targetProject === null) {
    return fail(
      "Both leaves must belong to a project folder under the planning root; one of them is " +
        "directly under the root or in a `_`-prefixed folder.",
    );
  }
  if (sourceProject !== targetProject) {
    return fail(
      `'${source.relPath}' and '${target.relPath}' belong to different projects ` +
        `('${sourceProject}' and '${targetProject}'). An influence only joins leaves of one project.`,
    );
  }

  const requested = stringField(input.status);
  if (requested !== null && !(BEE_STATUSES as readonly string[]).includes(requested)) {
    return fail(
      `'${requested}' is not an influence status. Use one of ${BEE_STATUSES.join(", ")}.`,
    );
  }

  const prepared = loadWritableNode(root, source, input);
  if ("error" in prepared) return prepared.error;
  const stored = prepared.stored;
  const frontmatter = stored.document.frontmatter;
  const entries = Array.isArray(frontmatter.influences)
    ? [...frontmatter.influences]
    : [];
  const index = entryIndexFor(tree, entries, target);
  const actor = actorOf(input);
  const now = nowIso();
  const removing = input.remove === true;

  if (removing) {
    if (index === -1) {
      return json({
        ok: true,
        action: "unchanged",
        removed: false,
        source: summarize(source),
        target: summarize(target),
        note: `'${source.relPath}' has no influence edge to '${target.relPath}'.`,
        written: false,
      });
    }
    entries.splice(index, 1);
    const change = commitNodeChange(
      settings,
      root,
      source,
      stored,
      { next: { ...frontmatter, influences: entries }, bump: "revision", reason: "link_update" },
      actor,
    );
    if ("error" in change) return fail(change.error);

    const journal = appendJournal(root, sourceProject, {
      at: now,
      op: "plan_link",
      target: wikilinkFor(source.vaultPath),
      result: `removed → ${wikilinkFor(target.vaultPath)}`,
      actor,
    });
    return json({
      ok: true,
      action: "removed",
      removed: true,
      source: summarize({ ...source, frontmatter: { ...frontmatter, influences: entries } }),
      target: summarize(target),
      version: change.version,
      revision: change.revision,
      snapshot: change.snapshot,
      journal: "path" in journal ? journal.path : null,
      journal_error: "error" in journal ? journal.error : null,
    });
  }

  const impact = stringField(input.impact);
  let status: BeeStatus;
  let action: "created" | "updated";

  if (index === -1) {
    status = (requested as BeeStatus | null) ?? "active";
    entries.push(influenceRow(target, status, impact));
    action = "created";
  } else {
    const entry = entries[index] as Record<string, unknown>;
    const current = (stringField(entry.status) ?? "active") as BeeStatus;
    status = (requested as BeeStatus | null) ?? current;
    if (status !== current && !canTransitionBee(current, status)) {
      const allowed = ((BEE_TRANSITIONS[current] ?? []) as readonly string[]).join(", ");
      return fail(
        `The influence '${source.relPath}' → '${target.relPath}' cannot go ${current} → ${status}. ` +
          `Allowed from ${current}: ${allowed || "none"} (nothing was written).`,
        { status: current, allowed },
      );
    }
    const currentImpact = stringField(entry.impact) ?? "";
    const nextImpact = impact ?? currentImpact;
    if (status === current && nextImpact === currentImpact) {
      // The edge already says exactly what was asked for. Refusing this with an
      // error read as "the link failed" and invited a retry of the same call
      // (live test U3); the answer is a no-op success, symmetric with removing
      // an edge that is not there.
      return json({
        ok: true,
        action: "unchanged",
        removed: false,
        written: false,
        source: summarize(source),
        target: summarize(target),
        status,
        impact: nextImpact.length > 0 ? nextImpact : null,
        version: positiveInt(frontmatter.version),
        revision: positiveInt(frontmatter.revision),
        note:
          `The influence '${source.relPath}' → '${target.relPath}' already has status \`${status}\`` +
          `${nextImpact.length > 0 ? " and that impact" : ""}: nothing was written, because the edge ` +
          "already says what you asked for. Do not repeat this call — pass a different `status` or " +
          "`impact`, or `remove: true` to drop the edge.",
      });
    }
    const updated: Record<string, unknown> = {
      ...entry,
      target:
        typeof entry.target === "string" && entry.target.trim().length > 0
          ? entry.target
          : wikilinkFor(target.vaultPath),
      status,
    };
    // Clean the counters an older version cached on the edge; `plan_read` now
    // takes them from the target.
    delete updated.version;
    delete updated.revision;
    if (nextImpact) updated.impact = nextImpact;
    else delete updated.impact;
    entries[index] = updated;
    action = "updated";
  }

  const change = commitNodeChange(
    settings,
    root,
    source,
    stored,
    {
      next: { ...frontmatter, influences: entries },
      bump: "revision",
      reason: "link_update",
    },
    actor,
  );
  if ("error" in change) return fail(change.error);

  const journal = appendJournal(root, sourceProject, {
    at: now,
    op: "plan_link",
    target: wikilinkFor(source.vaultPath),
    result: `${action} → ${wikilinkFor(target.vaultPath)} · ${status}`,
    actor,
  });

  return json({
    ok: true,
    action,
    removed: false,
    source: summarize({ ...source, frontmatter: { ...frontmatter, influences: entries } }),
    target: summarize(target),
    status,
    impact: impact ?? null,
    version: change.version,
    revision: change.revision,
    snapshot: change.snapshot,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
  });
}
