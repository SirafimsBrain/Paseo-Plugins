import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import { makeContinuation, withTruncation } from "../continuation";
import type { ToolOutcome } from "../mcp-tools";
import { positiveInt, stringField } from "./frontmatter";
import { isJournalPath, journalPathFor } from "./journal";
import {
  canHaveChild,
  isNodeKind,
  statusesOfKind,
} from "./model";
import { resolvePlanRoot } from "./paths";
import {
  findBeeCycle,
  kindOf,
  loadPlanTreeFor,
  projectOf,
  resolveLink,
  type PlanNode,
  type PlanTree,
} from "./read";
import { bodyMatchesFrontmatter } from "./sections";
import { fail, isRecord } from "./write";

/**
 * `plan_validate`: the integrity report the file model needs in place of a
 * foreign key.
 *
 * A plan is a directory of Markdown files, so every invariant that a database
 * would enforce is a *check* here: a link that resolves to nothing, a body that
 * no longer matches its frontmatter, a node without a parent, two roots in one
 * project, a cycle in the influence graph, a half-finished operation in the
 * journal, a file inside the planning root that is not a plan at all.
 *
 * Reads only. Every issue carries a `kind`, the file it is about and a sentence
 * an agent (or the user) can act on.
 */

export interface PlanIssue {
  kind: string;
  message: string;
  path?: string;
  project?: string | null;
  data?: Record<string, unknown>;
}

interface LinkField {
  field: string;
  value: string;
}

/** Every link a plan file carries, in a stable order. */
function linkFields(node: PlanNode): LinkField[] {
  const frontmatter = node.frontmatter;
  const links: LinkField[] = [];
  if (typeof frontmatter.parent === "string") {
    links.push({ field: "parent", value: frontmatter.parent });
  }
  if (typeof frontmatter.materialized === "string") {
    links.push({ field: "materialized", value: frontmatter.materialized });
  }
  if (typeof frontmatter.goal === "string") {
    links.push({ field: "goal", value: frontmatter.goal });
  }
  if (typeof frontmatter.project === "string") {
    links.push({ field: "project", value: frontmatter.project });
  }
  for (const field of ["children", "blocked_by", "blocks"] as const) {
    const value = frontmatter[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string") links.push({ field, value: entry });
    }
  }
  const influences = Array.isArray(frontmatter.influences) ? frontmatter.influences : [];
  for (const entry of influences) {
    if (!isRecord(entry) || typeof entry.target !== "string") continue;
    links.push({ field: "influences", value: entry.target });
  }
  return links;
}

/** Op ids that have an `op:start` line and no `op:done` line. */
export function unfinishedOperations(root: PlanTree["root"], project: string | null): Array<{
  id: string;
  line: string;
}> {
  const absolute = path.join(root.vaultRoot, journalPathFor(root, project));
  let text = "";
  try {
    text = fs.readFileSync(absolute, "utf-8");
  } catch {
    return [];
  }
  const started = new Map<string, string>();
  const done = new Set<string>();
  for (const line of text.split("\n")) {
    const start = /·\s*op:start\s+([A-Za-z0-9_-]+)/.exec(line);
    if (start) {
      started.set(start[1], line.trim());
      continue;
    }
    const finished = /·\s*op:done\s+([A-Za-z0-9_-]+)/.exec(line);
    if (finished) done.add(finished[1]);
  }
  return [...started.entries()]
    .filter(([id]) => !done.has(id))
    .map(([id, line]) => ({ id, line }));
}

function projectNames(tree: PlanTree): string[] {
  const names = new Set<string>();
  for (const node of tree.nodes.values()) {
    const project = projectOf(node);
    if (project) names.add(project);
  }
  return [...names].sort();
}

function canonicalCycle(cycle: string[]): string {
  return [...new Set(cycle)].sort().join("|");
}

export function planValidate(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const projectFilter = stringField(input.project);
  if (projectFilter !== null && !projectNames(tree).includes(projectFilter)) {
    return fail(`Project '${projectFilter}' has no plan documents under '${tree.root.relPath}'.`, {
      projects: projectNames(tree),
    });
  }
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(500, Math.trunc(input.limit)))
      : 200;
  const offset =
    typeof input.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.trunc(input.offset))
      : 0;

  const issues: PlanIssue[] = [];
  const push = (issue: PlanIssue) => {
    if (projectFilter !== null && issue.project !== undefined && issue.project !== projectFilter) {
      return;
    }
    issues.push(issue);
  };

  // Files inside the root that are not plan documents: an unparsable
  // frontmatter, an oversized note, a snapshot or a plain note.
  for (const skipped of tree.skipped) {
    if (isJournalPath(skipped)) continue;
    // The project is the first folder under `planRoot`, not the vault's first
    // segment: attributing every issue to `Projects` made the project filter
    // hide real problems (live test R1).
    const relative = skipped.startsWith(`${tree.root.relPath}/`)
      ? skipped.slice(tree.root.relPath.length + 1)
      : skipped;
    push({
      kind: "not_a_plan",
      path: skipped,
      project: relative.includes("/") ? relative.split("/")[0] : null,
      message:
        `'${skipped}' is inside the planning root but is not a plan document: its frontmatter ` +
        "does not parse, it has no plan `kind`, it is a stored snapshot or it is too large. " +
        "Fix the YAML or move the note out of the planning root.",
    });
  }

  const ids = new Map<string, PlanNode[]>();
  const seenCycles = new Set<string>();

  for (const node of tree.nodes.values()) {
    const project = projectOf(node);
    const frontmatter = node.frontmatter;
    const kind = kindOf(node);

    if (!kind) {
      push({
        kind: "missing_kind",
        path: node.vaultPath,
        project,
        message: `'${node.relPath}' has no \`kind\` in its frontmatter.`,
      });
      continue;
    }
    const status = stringField(frontmatter.status);
    if (status === null || !statusesOfKind(kind).includes(status)) {
      push({
        kind: "invalid_status",
        path: node.vaultPath,
        project,
        message:
          `'${node.relPath}' has ${status === null ? "no `status`" : `status '${status}'`}; ` +
          `a ${kind} uses ${statusesOfKind(kind).join(", ")}.`,
        data: { status },
      });
    }
    if (
      positiveInt(frontmatter.version) === null ||
      positiveInt(frontmatter.revision) === null
    ) {
      push({
        kind: "missing_counters",
        path: node.vaultPath,
        project,
        message:
          `'${node.relPath}' has no positive integer \`version\`/\`revision\`; a snapshot of it ` +
          "cannot be named, so the write tools refuse every change until it is fixed.",
      });
    }
    if (typeof frontmatter.id === "string" && frontmatter.id.trim().length > 0) {
      const list = ids.get(frontmatter.id) ?? [];
      list.push(node);
      ids.set(frontmatter.id, list);
    } else {
      push({
        kind: "missing_id",
        path: node.vaultPath,
        project,
        message: `'${node.relPath}' has no \`id\`; a rename would break its links.`,
      });
    }

    // The layout is part of the contract: a branching node lives in its own
    // folder, a leaf is one file in its parent's folder. A file that disagrees
    // with its kind is what makes an archive rename the wrong folder.
    if (isNodeKind(kind)) {
      const slug = path.posix.basename(node.vaultPath, ".md");
      const folderName = path.posix.basename(path.posix.dirname(node.vaultPath));
      const inOwnFolder = kind !== "leaf" ? folderName === slug : folderName !== slug;
      if (!inOwnFolder) {
        push({
          kind: "layout_mismatch",
          path: node.vaultPath,
          project,
          message:
            `'${node.relPath}' is a ${kind} but its file does not follow the layout ` +
            `(${kind === "leaf"
              ? "`<parent>/<name>.md` for a leaf"
              : "`<parent>/<name>/<name>.md` for a branching node"}). ` +
            "Recreate it at the expected path; an archive refuses a node whose kind and path disagree.",
          data: { kind, expected_folder: slug },
        });
      }
      const kindTags = ["root", "trunk", "branch", "subbranch", "leaf"].map((k) => `plan/${k}`);
      const tags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      if (tags.some((tag) => kindTags.includes(tag)) && !tags.includes(`plan/${kind}`)) {
        push({
          kind: "kind_tag_mismatch",
          path: node.vaultPath,
          project,
          message:
            `'${node.relPath}' is a ${kind} but its \`tags\` do not include \`plan/${kind}\` ` +
            `(found ${tags.filter((tag) => kindTags.includes(tag)).join(", ") || "none"}).`,
          data: { kind, tags },
        });
      }
    }

    // Unresolved links: every address the file claims must exist.
    for (const link of linkFields(node)) {
      if (resolveLink(tree, link.value) !== null) continue;
      push({
        kind: "unresolved_link",
        path: node.vaultPath,
        project,
        message:
          `'${node.relPath}' links to '${link.value}' in \`${link.field}\`, and nothing in the ` +
          "plan resolves to it (a link into `_archive` is expected to land here).",
        data: { field: link.field, target: link.value },
      });
    }

    // Body must be exactly what the frontmatter renders.
    if (!bodyMatchesFrontmatter({ frontmatter, body: node.body })) {
      push({
        kind: "body_divergence",
        path: node.vaultPath,
        project,
        message:
          `'${node.relPath}' has a hand-edited generated section: the body is not what the ` +
          "frontmatter renders. Rewrite the frontmatter from the tools, or edit `## Заметки` only.",
      });
    }

    const parentLink = typeof frontmatter.parent === "string" ? frontmatter.parent : null;
    const parent = parentLink === null ? null : resolveLink(tree, parentLink);

    if (kind === "incident" || kind === "goal") {
      if (typeof frontmatter.project !== "string") {
        push({
          kind: "orphan",
          path: node.vaultPath,
          project,
          message: `'${node.relPath}' is a ${kind} without a \`project\`; it belongs to one root.`,
        });
      }
    } else if (kind === "root") {
      if (parent !== null) {
        push({
          kind: "root_with_parent",
          path: node.vaultPath,
          project,
          message: `'${node.relPath}' is a root but carries a \`parent\`.`,
        });
      }
    } else if (parentLink === null) {
      push({
        kind: "orphan",
        path: node.vaultPath,
        project,
        message: `'${node.relPath}' is a ${kind} without a \`parent\`; only a root has none.`,
      });
    } else if (parent === null) {
      push({
        kind: "orphan",
        path: node.vaultPath,
        project,
        message:
          `'${node.relPath}' points at parent '${parentLink}', which does not exist in the plan.`,
      });
    } else {
      const parentKind = kindOf(parent);
      if (!parentKind || !isNodeKind(parentKind) || !isNodeKind(kind) || !canHaveChild(parentKind, kind)) {
        push({
          kind: "invalid_parent_kind",
          path: node.vaultPath,
          project,
          message:
            `'${node.relPath}' is a ${kind} under '${parent.relPath}' (${parentKind ?? "unknown"}); ` +
            "the parent does not allow that child kind.",
        });
      }
    }

    if (kind === "leaf" && Array.isArray(frontmatter.children) && frontmatter.children.length > 0) {
      push({
        kind: "leaf_with_children",
        path: node.vaultPath,
        project,
        message: `'${node.relPath}' is a leaf but lists children; a leaf ends the chain.`,
      });
    }

    // A growth record that says `done` while its own steps are unfinished is a
    // contradiction a reader should see (live test N6).
    if (isRecord(frontmatter.growth)) {
      const growth = frontmatter.growth;
      const growthStatus = stringField(growth.status);
      const steps = Array.isArray(growth.steps) ? growth.steps : [];
      const unfinished = steps.filter(
        (step) =>
          isRecord(step) &&
          ["pending", "in_progress"].includes(stringField(step.state) ?? "pending"),
      );
      if (growthStatus === "done" && unfinished.length > 0) {
        push({
          kind: "growth_incomplete",
          path: node.vaultPath,
          project,
          message:
            `'${node.relPath}' records growth as \`done\` while ${unfinished.length} step(s) ` +
            "are still pending or in progress. Finish the steps or record the growth as " +
            "`active`.",
          data: {
            status: growthStatus,
            steps: unfinished.map((step) => stringField((step as Record<string, unknown>).title)),
          },
        });
      }
    }

    if (kind === "leaf" && !seenCycles.has(`n:${node.vaultPath}`)) {
      const cycle = findBeeCycle(tree, node);
      if (cycle) {
        const key = canonicalCycle(cycle);
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          push({
            kind: "bee_cycle",
            path: node.vaultPath,
            project,
            message:
              "The influence graph closes a loop: " +
              `${cycle.join(" → ")}. A cycle has no honest execution order; cut one edge.`,
            data: { cycle },
          });
        }
      }
    }
  }

  // Duplicate ids break "identity is the id, not the file name".
  for (const [id, list] of ids) {
    if (list.length < 2) continue;
    push({
      kind: "duplicate_id",
      path: list[0].vaultPath,
      project: projectOf(list[0]),
      message: `The id '${id}' is used by ${list.length} documents: ${list.map((n) => n.relPath).join(", ")}.`,
      data: { id, paths: list.map((node) => node.vaultPath) },
    });
  }

  // One root per project, and every project needs one.
  for (const project of projectNames(tree)) {
    if (projectFilter !== null && project !== projectFilter) continue;
    const nodes = [...tree.nodes.values()].filter((node) => projectOf(node) === project);
    const roots = nodes.filter((node) => kindOf(node) === "root");
    if (roots.length === 0) {
      push({
        kind: "missing_root",
        project,
        message: `Project '${project}' has no root node ('${project}/${project}.md').`,
      });
    } else if (roots.length > 1) {
      push({
        kind: "multiple_roots",
        project,
        path: roots[1].vaultPath,
        message:
          `Project '${project}' has ${roots.length} root nodes: ` +
          `${roots.map((node) => node.relPath).join(", ")}. A project holds one tree.`,
      });
    }
  }

  // Half-finished multi-file operations are visible only in the journal.
  const journals = new Set<string | null>();
  for (const node of tree.nodes.values()) journals.add(projectOf(node));
  if (tree.nodes.size === 0) journals.add(null);
  for (const project of journals) {
    if (projectFilter !== null && project !== projectFilter) continue;
    for (const operation of unfinishedOperations(tree.root, project)) {
      push({
        kind: "unfinished_operation",
        project,
        path: journalPathFor(tree.root, project),
        message:
          `Operation '${operation.id}' started and never finished: repeat the tool call with ` +
          "`op_id` set to it to finish the work, or roll it back from the snapshots.",
        data: { op_id: operation.id, journal: journalPathFor(tree.root, project) },
      });
    }
  }

  issues.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return (left.path ?? "").localeCompare(right.path ?? "");
  });

  const byKind: Record<string, number> = {};
  for (const issue of issues) byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;

  const nodeCounts: Record<string, number> = {};
  for (const node of tree.nodes.values()) {
    if (projectFilter !== null && projectOf(node) !== projectFilter) continue;
    const kind = kindOf(node);
    if (kind) nodeCounts[kind] = (nodeCounts[kind] ?? 0) + 1;
  }

  const window = issues.slice(offset, offset + limit);
  const omitted = Math.max(0, issues.length - offset - window.length);
  const nextArgs: Record<string, unknown> = { limit };
  if (input.project !== undefined) nextArgs.project = input.project;
  if (offset > 0 || omitted > 0) nextArgs.offset = offset + window.length;
  const continuation =
    omitted > 0
      ? makeContinuation(
          { tool: "plan_validate", arguments: nextArgs },
          "issue_window",
          omitted,
          `${omitted} integrity issues were not shown; ask for the next page.`,
        )
      : null;

  return withTruncation({
    ok: true,
    valid: issues.length === 0,
    root: tree.root.relPath,
    projects: projectFilter === null ? projectNames(tree) : [projectFilter],
    documents: tree.nodes.size,
    counts: { byKind: nodeCounts },
    issues: window,
    issue_count: issues.length,
    truncated_count: omitted,
    checked: {
      documents: tree.nodes.size,
      skipped: tree.skipped.length,
      journals: journals.size,
      rules: [
        "not_a_plan",
        "unresolved_link",
        "body_divergence",
        "orphan",
        "missing_root",
        "multiple_roots",
        "invalid_parent_kind",
        "invalid_status",
        "missing_counters",
        "missing_id",
        "duplicate_id",
        "leaf_with_children",
        "layout_mismatch",
        "kind_tag_mismatch",
        "bee_cycle",
        "growth_incomplete",
        "unfinished_operation",
      ],
    },
    note:
      issues.length === 0
        ? "No integrity problems: every link resolves, every body matches its frontmatter, one root per project."
        : "Each issue names the file to fix; nothing was changed by this call.",
  }, continuation);
}
