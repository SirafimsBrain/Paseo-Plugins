import * as crypto from "node:crypto";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { serializePlanDocument, stringField } from "./frontmatter";
import { appendJournal } from "./journal";
import { canTransitionGoal, GOAL_TRANSITIONS, orderPlanKeys, type GoalStatus } from "./model";
import { resolvePlanPath, resolvePlanRoot } from "./paths";
import {
  findPlanNode,
  kindOf,
  loadPlanTreeFor,
  projectOf,
  resolveLink,
  statusOf,
  suggestPlanNodes,
  type PlanNode,
  type PlanTree,
} from "./read";
import { renderPlanBody } from "./sections";
import {
  actorOf,
  commitNodeChange,
  fail,
  isRecord,
  json,
  loadWritableNode,
  nowIso,
  readOnlyRefusal,
  writeStored,
  wikilinkFor,
} from "./write";

/**
 * `plan_goal`: the formal task a project exists to satisfy.
 *
 * A goal is a file beside the tree (`<project>/_goals/<slug>.md`) with its
 * steps in `plan:`. This tool covers the authoring half — `create`, `update`,
 * `propose`; approval materialises the steps into leaves and belongs to
 * `plan_approve_goal` (stage 6), so an agent cannot approve its own plan here.
 */

const GOAL_FOLDER = "_goals";

type Step = Record<string, unknown>;

/** `plan:` steps: objects with a title, an optional description and a stable id. */
function normalizePlanSteps(value: unknown): { steps: Step[] } | { error: string } {
  if (value === null) return { steps: [] };
  if (!Array.isArray(value)) {
    return { error: "`plan` must be a list of steps (or null to clear it)." };
  }
  const steps: Step[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    let title = "";
    let description: string | null = null;
    let id = `s${index + 1}`;
    if (typeof entry === "string") {
      title = entry.trim();
    } else if (isRecord(entry)) {
      title = stringField(entry.title) ?? "";
      description = stringField(entry.description);
      const explicit = stringField(entry.id);
      if (explicit !== null) id = explicit;
    } else {
      return { error: `Step ${index + 1} must be a title string or an object with a \`title\`.` };
    }
    if (title.length === 0) {
      return { error: `Step ${index + 1} has no title; a step is a thing someone does.` };
    }
    if (ids.has(id)) {
      return { error: `Two steps share the id '${id}'; step ids must be unique.` };
    }
    ids.add(id);
    const step: Step = { id, title };
    if (description) step.description = description;
    steps.push(step);
  }
  return { steps };
}

function resolveProject(tree: PlanTree, value: string): PlanNode | null {
  const direct = resolveLink(tree, value);
  if (direct && kindOf(direct) === "root") return direct;
  const clean = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const slug = clean.split("/").pop() ?? clean;
  const byFolder = tree.nodes.get(`${tree.root.relPath}/${clean}/${slug}.md`);
  return byFolder && kindOf(byFolder) === "root" ? byFolder : null;
}

export function planGoal(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const disabled = readOnlyRefusal(settings);
  if (disabled) return disabled;

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const root = resolved.root;

  const action = stringField(input.action) ?? "create";
  if (!["create", "update", "propose"].includes(action)) {
    return fail("`action` must be `create`, `update` or `propose`.");
  }

  const rawPath = stringField(input.path);
  if (!rawPath) {
    return fail(
      "`path` is required: `<project>/_goals/<slug>`, e.g. `centurion/_goals/session-persistence`.",
    );
  }
  const resolvedPath = resolvePlanPath(root, rawPath);
  if ("error" in resolvedPath) return fail(resolvedPath.error);

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const found = findPlanNode(tree, rawPath);
  const existing = "error" in found ? null : found.node;
  if (existing && kindOf(existing) !== "goal") {
    return fail(
      `'${existing.relPath}' is a ${kindOf(existing) ?? "document"}, not a goal. A goal is its own ` +
        "file with `kind: goal`.",
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
    return fail(`'${collision.relPath}' already exists; a goal never overwrites a node.`);
  }

  const actor = actorOf(input);
  const now = nowIso();
  const folder = path.posix.dirname(resolvedPath.relPath);
  const projectFromPath = folder.split("/")[0];
  const declaredProject = stringField(input.project);

  if (action === "create") {
    if (existing) {
      return fail(
        `'${existing.relPath}' already exists. Use \`action: "update"\` to change it, or ` +
          "`action: \"propose\"` when it is ready for approval.",
      );
    }
    if (folder.split("/").pop() !== GOAL_FOLDER) {
      return fail(
        `A goal lives in '<project>/${GOAL_FOLDER}/<slug>' — got '${folder}'. Pass e.g. ` +
          `\`${projectFromPath}/${GOAL_FOLDER}/session-persistence\`.`,
      );
    }
    const name = stringField(input.name);
    if (!name) return fail("`name` is required when the goal file does not exist yet.");

    const steps = normalizePlanSteps(input.plan === undefined ? [] : input.plan);
    if ("error" in steps) return fail(steps.error);

    const project = declaredProject ?? (projectFromPath.startsWith("_") ? null : projectFromPath);
    const projectNode = resolveProject(tree, project ?? "");
    if (project === null) {
      return fail(
        "The goal path does not name a project. Pass `project` (a project folder or root link).",
      );
    }
    if (declaredProject && !projectNode) {
      return fail(`Project '${declaredProject}' is not a plan root in this tree.`, {
        suggestions: suggestPlanNodes(tree, declaredProject),
      });
    }

    const frontmatter: Record<string, unknown> = {
      id: crypto.randomUUID(),
      schema: 1,
      kind: "goal",
      name,
      formal_text: stringField(input.formal_text) ?? "",
      status: "draft",
      version: 1,
      revision: 1,
      plan: steps.steps,
      materialized: null,
      project: projectNode ? wikilinkFor(projectNode.vaultPath) : null,
      created: now,
      updated: now,
      created_by: actor,
      updated_by: actor,
      tags: ["plan/goal"],
    };
    const ordered = orderPlanKeys(frontmatter);
    const notes = typeof input.notes === "string" ? input.notes : "";
    const body = renderPlanBody(ordered, notes.length > 0 ? `## Заметки\n\n${notes}` : "");
    const text = serializePlanDocument({ frontmatter: ordered, body });

    const written = writeStored(root, vaultTarget, text, { create: true });
    if ("error" in written) return fail(written.error);

    const journal = appendJournal(root, project, {
      at: now,
      op: "plan_goal",
      target: wikilinkFor(vaultTarget),
      result: `created · draft · ${steps.steps.length} steps`,
      actor,
    });

    return json({
      ok: true,
      action: "created",
      path: noteRelPath,
      vault_path: vaultTarget,
      kind: "goal",
      name,
      status: "draft",
      project,
      steps: steps.steps,
      version: 1,
      revision: 1,
      journal: "path" in journal ? journal.path : null,
      journal_error: "error" in journal ? journal.error : null,
    });
  }

  if (!existing) {
    return fail(
      `'${resolvedPath.relPath}' does not exist. Create it first with \`action: "create"\`.`,
    );
  }

  const prepared = loadWritableNode(root, existing, input);
  if ("error" in prepared) return prepared.error;
  const stored = prepared.stored;
  const frontmatter = stored.document.frontmatter;
  const project = projectOf(existing);
  const currentStatus = statusOf(existing);

  if (action === "propose") {
    if (currentStatus === null) {
      return fail(`'${existing.relPath}' has no \`status\` in its frontmatter.`);
    }
    if (currentStatus === "proposed") {
      return fail(
        `'${existing.relPath}' is already proposed; approval is \`plan_approve_goal\`.`,
      );
    }
    if (!canTransitionGoal(currentStatus as GoalStatus, "proposed")) {
      const allowed = ((GOAL_TRANSITIONS[currentStatus as GoalStatus] ?? []) as readonly string[]).join(
        ", ",
      );
      return fail(
        `'${existing.relPath}' cannot go ${currentStatus} → proposed. Allowed from ` +
          `${currentStatus}: ${allowed || "none"} (nothing was written).`,
        { status: currentStatus, allowed },
      );
    }
    const change = commitNodeChange(
      settings,
      root,
      existing,
      stored,
      {
        next: { ...frontmatter, status: "proposed", status_by: actor },
        bump: "revision",
        reason: "status_change",
      },
      actor,
    );
    if ("error" in change) return fail(change.error);

    const journal = appendJournal(root, project, {
      at: now,
      op: "plan_goal",
      target: wikilinkFor(existing.vaultPath),
      result: `proposed · v${change.version} r${change.revision}`,
      actor,
      status: `${currentStatus} → proposed`,
    });
    return json({
      ok: true,
      action: "proposed",
      path: existing.relPath,
      vault_path: existing.vaultPath,
      kind: "goal",
      status: "proposed",
      previous_status: currentStatus,
      version: change.version,
      revision: change.revision,
      snapshot: change.snapshot,
      journal: "path" in journal ? journal.path : null,
      journal_error: "error" in journal ? journal.error : null,
    });
  }

  // ---- update ------------------------------------------------------------
  if (currentStatus === "cancelled" || currentStatus === "superseded") {
    return fail(
      `'${existing.relPath}' is ${currentStatus}: a closed goal is not edited. Create a new goal ` +
        "instead; its history stays readable through `plan_history`.",
    );
  }

  const next: Record<string, unknown> = { ...frontmatter };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(input, "name")) {
    const name = stringField(input.name);
    if (!name) return fail("`name` cannot be empty.");
    next.name = name;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(input, "formal_text")) {
    next.formal_text = stringField(input.formal_text) ?? "";
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(input, "plan")) {
    const steps = normalizePlanSteps(input.plan);
    if ("error" in steps) return fail(steps.error);
    next.plan = steps.steps;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(input, "project")) {
    const value = stringField(input.project);
    if (value === null) {
      next.project = null;
    } else {
      const projectNode = resolveProject(tree, value);
      if (!projectNode) {
        return fail(`Project '${value}' is not a plan root in this tree.`, {
          suggestions: suggestPlanNodes(tree, value),
        });
      }
      next.project = wikilinkFor(projectNode.vaultPath);
    }
    changed = true;
  }

  if (!changed) {
    return fail(
      "Nothing to update: pass `name`, `formal_text`, `plan`, `notes` or `project`.",
    );
  }

  const change = commitNodeChange(
    settings,
    root,
    existing,
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
    op: "plan_goal",
    target: wikilinkFor(existing.vaultPath),
    result: `updated · v${change.version} r${change.revision}`,
    actor,
  });

  return json({
    ok: true,
    action: "updated",
    path: existing.relPath,
    vault_path: existing.vaultPath,
    kind: "goal",
    status: stringField(next.status),
    project: projectOf({ ...existing, frontmatter: next }),
    plan: next.plan,
    version: change.version,
    revision: change.revision,
    snapshot: change.snapshot,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
  });
}
