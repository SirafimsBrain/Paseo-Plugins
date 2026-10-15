import type { BugSeverity } from "../shared/links";
import type { GoalStep } from "../shared/goals";
import type { LeafStatus, Node } from "../shared/tree";
import { LEAF_STATUSES } from "../shared/tree";

/**
 * Slash-command logic for the composer (PLAN.md stage E3, `__doc.md` §6).
 *
 * Pure functions over injected RPC-shaped callbacks — no React, no React
 * Native, no SDK imports — so `/luck-status` and `/luck-bug` parsing,
 * leaf resolution and result messages are pinned by `tests/slash.test.ts`.
 * `index.client.tsx` only wires these to the host's `rpc` and `openPanel`.
 */

/** Placeholder draft the ⌘K "New high goal" item seeds (SDK has no dialog). */
export const NEW_GOAL_PLACEHOLDER: GoalStep[] = [
  {
    id: "step-1",
    title: "Describe this step",
    description: "Replace with the first atomic step of the plan.",
  },
];

export const NEW_GOAL_TEXT = "New high goal — describe the task (created via ⌘K)";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the string looks like a node id (uuid issued by the store). */
export function isNodeId(value: string): boolean {
  return UUID_RE.test(value);
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const USAGE_STATUS = `usage: /luck-status <leaf name or id> <status> — status one of: ${LEAF_STATUSES.join(", ")}`;
const USAGE_BUG = "usage: /luck-bug <title>";

/** Parsed `/luck-status <leaf> <status>` arguments. */
export interface LuckStatusArgs {
  leafRef: string;
  status: LeafStatus;
}

/**
 * Parses `/luck-status` arguments: everything but the last token is the
 * leaf reference (a name fragment or a node id), the last token must be a
 * valid leaf status.
 */
export function parseLuckStatus(args: string): ParseResult<LuckStatusArgs> {
  const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 2) return { ok: false, error: USAGE_STATUS };
  const statusToken = tokens[tokens.length - 1];
  if (!(LEAF_STATUSES as readonly string[]).includes(statusToken)) {
    return {
      ok: false,
      error: `unknown status "${statusToken}" — ${USAGE_STATUS}`,
    };
  }
  return {
    ok: true,
    value: { leafRef: tokens.slice(0, -1).join(" "), status: statusToken as LeafStatus },
  };
}

/** Parsed `/luck-bug <title>` arguments. */
export function parseLuckBug(args: string): ParseResult<{ title: string }> {
  const title = args.trim();
  if (title.length === 0) return { ok: false, error: USAGE_BUG };
  return { ok: true, value: { title } };
}

/** Severity of a reported bug; the composer slash command always uses it. */
export function bugSeverityFromArgs(_args: string): BugSeverity {
  return "medium";
}

/** Minimal search shape `resolveLeaf` needs (matches `tree-search`). */
export interface LeafSearch {
  (input: {
    projectKey: string;
    query: string;
    kinds?: Node["kind"][];
    limit?: number;
  }): Promise<{ results: Array<{ node: Node }> }>;
}

/**
 * Resolves a slash-command leaf reference to a node id: a uuid passes
 * through (the store answers with a readable "not found in project" if it
 * does not exist); anything else goes through FTS restricted to leaves —
 * exactly one hit wins, several demand a more specific query, none error.
 */
export async function resolveLeaf(
  search: LeafSearch,
  projectKey: string,
  ref: string,
): Promise<ParseResult<{ nodeId: string; name: string }>> {
  if (isNodeId(ref)) return { ok: true, value: { nodeId: ref, name: ref } };
  const { results } = await search({
    projectKey,
    query: ref,
    kinds: ["leaf"],
    limit: 10,
  });
  const leaves = results.map((hit) => hit.node).filter((node) => node.kind === "leaf");
  if (leaves.length === 0) {
    return { ok: false, error: `no leaf matches "${ref}" in this project` };
  }
  if (leaves.length === 1) {
    return { ok: true, value: { nodeId: leaves[0].id, name: leaves[0].name } };
  }
  const names = leaves
    .slice(0, 5)
    .map((node) => node.name)
    .join(", ");
  return {
    ok: false,
    error: `${leaves.length} leaves match "${ref}" (${names}${leaves.length > 5 ? ", …" : ""}) — be more specific or use the node id`,
  };
}
