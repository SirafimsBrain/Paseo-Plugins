import { z } from "zod";

/**
 * The execution brief of a leaf (0.53.0).
 *
 * ## Why this exists
 *
 * A leaf was a title plus a prose description. That is enough to *find* a fact
 * and not enough to *do* it: an agent that read a leaf still had to open the
 * project, re-derive where the work lives and re-read the source document,
 * which is the opposite of what the tree promises. The cause was measured on a
 * real incident — the human pasted the entry point of a leaf into a task, the
 * agent did not recognise it, searched the daemon's files and the documents,
 * and only then found the leaf it had been handed.
 *
 * A brief is the missing half of a leaf: the concrete start (an entry point),
 * the ordered steps, the files, what "done" means, and what has already been
 * established so nobody researches it again. It lives in `payload.brief`, so
 * the storage schema, the export format and the import path stay untouched
 * (`payload` is already a JSON object on every node).
 *
 * ## Rules
 *
 * - `steps` is required and ordered: a brief without steps is not a plan.
 * - Everything is optional except `steps`; a leaf that only needs a pointer
 *   may carry an `entryPoint` alone.
 * - The text form ({@link leafBriefText}) is what the dashboard copies and what
 *   an agent reads, so it is shared code here rather than a UI string.
 * - Validation is strict on write ({@link leafBriefSchema} in
 *   `shared/tools.ts`) and forgiving on read ({@link readLeafBrief} returns
 *   `null` for a payload that does not match, so an old or hand-written payload
 *   never breaks a read path).
 */

/** Key of the brief inside a node's `payload`. */
export const BRIEF_PAYLOAD_KEY = "brief";

/**
 * A leaf's execution brief.
 *
 * Deliberately text-only: paths, symbols, commands and acceptance criteria are
 * prose the executing agent interprets, not a build system this plugin would
 * have to model.
 */
export const leafBriefSchema = z.object({
  /** Where the work starts: `file:line symbol`, a command, a URL. */
  entryPoint: z.string().min(1).optional(),
  /** Ordered, concrete actions — the plan itself. At least one. */
  steps: z.array(z.string().min(1)).min(1).max(50),
  /** Files the work touches (repository-relative where possible). */
  files: z.array(z.string().min(1)).max(50).optional(),
  /** What must be true for the leaf to be `done`. */
  acceptance: z.array(z.string().min(1)).max(50).optional(),
  /** Where the fact came from (a document, a message, a commit). */
  source: z.string().min(1).optional(),
  /**
   * Facts already verified while the leaf was written. The point of the field
   * is negative: an agent must not spend tokens re-establishing them.
   */
  established: z.array(z.string().min(1)).max(50).optional(),
});
export type LeafBrief = z.infer<typeof leafBriefSchema>;

/** The brief a payload carries, or `null` when it carries none / an invalid one. */
export function readLeafBrief(
  payload: Record<string, unknown> | null | undefined,
): LeafBrief | null {
  if (payload === null || payload === undefined) return null;
  const raw = payload[BRIEF_PAYLOAD_KEY];
  if (raw === undefined || raw === null) return null;
  const parsed = leafBriefSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * A payload with `brief` written into it. `base` is the payload the caller is
 * building (a full replace) and `previous` the stored one (a partial edit) —
 * an update that carries only a brief must not drop the other keys.
 */
export function payloadWithBrief(options: {
  brief: LeafBrief | undefined;
  given?: Record<string, unknown>;
  previous?: Record<string, unknown> | null;
}): Record<string, unknown> | undefined {
  const { brief } = options;
  if (brief === undefined) return options.given;
  const base = options.given ?? options.previous ?? {};
  return { ...base, [BRIEF_PAYLOAD_KEY]: brief };
}

/** One labelled line, or nothing when the value is empty. */
function line(label: string, value: string | undefined): string[] {
  return value === undefined || value.length === 0 ? [] : [`${label}: ${value}`];
}

/**
 * The brief as the text an agent reads (and the dashboard copies).
 *
 * No leading/trailing blank lines; the caller decides where it goes. A leaf
 * without a brief answers an empty string, so callers can concatenate
 * unconditionally.
 */
export function leafBriefText(brief: LeafBrief | null): string {
  if (brief === null) return "";
  const lines: string[] = [];
  lines.push(...line("Entry point", brief.entryPoint));
  lines.push(...line("Files", brief.files?.join(", ")));
  lines.push("Steps:");
  brief.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (brief.acceptance !== undefined && brief.acceptance.length > 0) {
    lines.push("Acceptance:");
    for (const item of brief.acceptance) lines.push(`- ${item}`);
  }
  if (brief.established !== undefined && brief.established.length > 0) {
    lines.push("Already established (do not re-research):");
    for (const item of brief.established) lines.push(`- ${item}`);
  }
  lines.push(...line("Source", brief.source));
  return lines.join("\n");
}

/**
 * First line of a copied leaf: the machine-recognisable reference.
 *
 * `luck-planner-leaf` is a stable marker (the agent skill and the MCP
 * instructions name it), `project` is the exact `projectKey` the tool calls
 * need and `id` is the leaf's node id — so a paste is self-describing and one
 * `luck_tree_get_context` call turns it into the work.
 */
export const LEAF_REFERENCE_MARKER = "luck-planner-leaf";

/** `luck-planner-leaf project="…" id="…"` */
export function leafReference(projectKey: string, leafId: string): string {
  return `${LEAF_REFERENCE_MARKER} project="${projectKey}" id="${leafId}"`;
}

/** What a leaf needs to render its own agent instruction. */
export interface LeafInstructionInput {
  readonly projectKey: string;
  readonly leafId: string;
  readonly name: string;
  /** Breadcrumb of ancestor names, root first (may be empty). */
  readonly path: string;
  readonly status: string;
  readonly version: string;
  readonly revision: number;
  readonly description?: string;
  readonly brief: LeafBrief | null;
}

/**
 * The complete instruction a person copies from a card and pastes into a task.
 *
 * It opens with the reference line, states what the leaf is, and **ends with
 * how to use it** — the sentence exists because the failure it fixes was an
 * agent that treated the paste as an unknown blob and went researching. A
 * leaf without a brief says so explicitly, so the agent knows the plan is
 * genuinely missing instead of searching for one that was never written.
 */
export function leafAgentInstruction(input: LeafInstructionInput): string {
  const lines: string[] = [leafReference(input.projectKey, input.leafId)];
  lines.push(`Leaf: ${input.name}`);
  if (input.path.length > 0) lines.push(`Path: ${input.path}`);
  lines.push(
    `Status: ${input.status} · v${input.version || "—"} · r${input.revision}`,
  );
  if (input.description !== undefined && input.description.trim().length > 0) {
    lines.push(`Fact: ${input.description.trim()}`);
  }
  const briefText = leafBriefText(input.brief);
  if (briefText.length > 0) {
    lines.push("", "Execution brief", briefText);
  } else {
    lines.push(
      "",
      "Execution brief: none recorded — the leaf states the fact but not the " +
        "steps. Read the leaf's description and neighbors before starting.",
    );
  }
  lines.push(
    "",
    "How to use this: this paste IS the task. Read the leaf with " +
      `luck_tree_get_context { "projectKey": "${input.projectKey}", "nodeId": "${input.leafId}" } ` +
      "and execute the brief — do not re-research the project, re-read the " +
      "source document or re-plan the work. Move the leaf's status as you go " +
      "(luck_tree_upsert_leaf with leafId + status).",
  );
  return lines.join("\n");
}
