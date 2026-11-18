import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { stringField } from "./frontmatter";
import { appendJournal } from "./journal";
import {
  GROWTH_STATUSES,
  GROWTH_STEP_STATES,
  isPlanKind,
  orderPlanKeys,
  type GrowthStatus,
} from "./model";
import { resolvePlanRoot } from "./paths";
import {
  findPlanNode,
  kindOf,
  loadPlanTreeFor,
  projectOf,
  summarize,
  type PlanNode,
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
 * `plan_growth`: the progress record of one node or goal.
 *
 * `growth:` lives inside the subject's own frontmatter rather than in a separate
 * file, so a plan-fact review reads the claim and its evidence in one document.
 * Steps are merged by title: re-recording a step updates its state instead of
 * appending a duplicate, and `replace: true` is the explicit way to start over.
 */

type GrowthStep = Record<string, unknown>;

interface GrowthRecord {
  status: GrowthStatus;
  summary?: string;
  progress?: number;
  steps?: GrowthStep[];
  updated: string;
}

function normalizeSteps(value: unknown): { steps: GrowthStep[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: "`steps` must be a list of steps." };
  }
  const steps: GrowthStep[] = [];
  const titles = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    let title = "";
    let state: string | null = null;
    let note: string | null = null;
    let at: string | null = null;
    if (typeof entry === "string") {
      title = entry.trim();
    } else if (isRecord(entry)) {
      title = stringField(entry.title) ?? "";
      state = stringField(entry.state);
      note = stringField(entry.note);
      at = stringField(entry.at);
    } else {
      return { error: `Step ${index + 1} must be a title string or an object with a \`title\`.` };
    }
    if (title.length === 0) {
      return { error: `Step ${index + 1} has no title; a growth step is a unit of progress.` };
    }
    if (titles.has(title)) {
      return { error: `Two growth steps share the title '${title}'; steps are merged by title.` };
    }
    titles.add(title);
    const nextState = state ?? "pending";
    if (!(GROWTH_STEP_STATES as readonly string[]).includes(nextState)) {
      return {
        error: `'${nextState}' is not a step state. Use one of ${GROWTH_STEP_STATES.join(", ")}.`,
      };
    }
    const step: GrowthStep = { title, state: nextState };
    if (note) step.note = note;
    if (at) step.at = at;
    steps.push(step);
  }
  return { steps };
}

/** Merges incoming steps into the stored ones by title. */
function mergeSteps(existing: GrowthStep[], incoming: GrowthStep[]): GrowthStep[] {
  const byTitle = new Map(existing.map((step) => [stringField(step.title) ?? "", { ...step }]));
  const merged: GrowthStep[] = [];
  const seen = new Set<string>();
  for (const step of incoming) {
    const title = stringField(step.title) ?? "";
    const prior = byTitle.get(title);
    merged.push(prior ? { ...prior, ...step, title } : step);
    seen.add(title);
  }
  for (const step of existing) {
    const title = stringField(step.title) ?? "";
    if (!seen.has(title)) merged.push(step);
  }
  return merged;
}

export function planGrowth(
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
    return fail("`path` is required: the node or goal whose growth you record.");
  }

  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) return fail(loaded.error, { reason: loaded.reason });
  const tree = loaded.tree;

  const found = findPlanNode(tree, rawPath);
  if ("error" in found) return fail(found.error, { suggestions: found.suggestions });
  const node: PlanNode = found.node;
  const kind = kindOf(node);
  if (kind === "incident") {
    return fail(
      `${node.relPath} is an incident: a defect is resolved with \`plan_set_status\`, and progress ` +
        "belongs to the work it blocks.",
    );
  }
  if (!isPlanKind(kind)) {
    return fail(`'${node.relPath}' is not a plan document, so it has no growth record.`);
  }

  const prepared = loadWritableNode(root, node, input);
  if ("error" in prepared) return prepared.error;
  const stored = prepared.stored;
  const frontmatter = stored.document.frontmatter;
  const existing: GrowthRecord | null = isRecord(frontmatter.growth)
    ? (frontmatter.growth as unknown as GrowthRecord)
    : null;

  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  if (!has("status") && !has("summary") && !has("progress") && !has("steps")) {
    return fail(
      "Nothing to record: pass `status`, `summary`, `progress` or `steps`.",
      { growth: existing },
    );
  }

  const status = stringField(input.status) ?? existing?.status ?? "active";
  if (!(GROWTH_STATUSES as readonly string[]).includes(status)) {
    return fail(`'${status}' is not a growth status. Use one of ${GROWTH_STATUSES.join(", ")}.`);
  }

  const record: Record<string, unknown> = { status };
  const summary = has("summary") ? stringField(input.summary) : existing?.summary ?? null;
  if (summary) record.summary = summary;

  let progress: number | null = null;
  if (has("progress")) {
    const raw = input.progress;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100) {
      return fail("`progress` must be a number between 0 and 100.");
    }
    progress = Math.trunc(raw);
  } else if (typeof existing?.progress === "number") {
    progress = existing.progress;
  }
  if (progress !== null) record.progress = progress;

  const priorSteps = Array.isArray(existing?.steps)
    ? existing.steps.filter(isRecord)
    : [];
  if (has("steps")) {
    const incoming = input.steps === null ? { steps: [] } : normalizeSteps(input.steps);
    if ("error" in incoming) return fail(incoming.error);
    record.steps = input.replace === true ? incoming.steps : mergeSteps(priorSteps, incoming.steps);
  } else if (priorSteps.length > 0) {
    record.steps = priorSteps;
  }
  record.updated = nowIso();

  const actor = actorOf(input);
  const change = commitNodeChange(
    settings,
    root,
    node,
    stored,
    {
      next: { ...frontmatter, growth: orderPlanKeys(record, ["status", "summary", "progress", "steps", "updated"]) },
      bump: "revision",
      reason: "content_update",
    },
    actor,
  );
  if ("error" in change) return fail(change.error);

  const project = projectOf(node);
  const journal = appendJournal(root, project, {
    at: record.updated as string,
    op: "plan_growth",
    target: wikilinkFor(node.vaultPath),
    result: `growth · ${status}${progress !== null ? ` · ${progress}%` : ""} · v${change.version} r${change.revision}`,
    actor,
  });

  return json({
    ok: true,
    path: node.relPath,
    vault_path: node.vaultPath,
    kind,
    node: summarize(node),
    growth: record,
    version: change.version,
    revision: change.revision,
    snapshot: change.snapshot,
    journal: "path" in journal ? journal.path : null,
    journal_error: "error" in journal ? journal.error : null,
  });
}
