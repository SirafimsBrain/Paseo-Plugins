import type { LuckPlannerStore } from "./store";

/**
 * Idempotent project seeding (0.40.8, `__doc.md` §10.11 items 2 and 3).
 *
 * The store scopes every row by `projectKey` (ADR-2), and that key is the
 * workspace's `projectRootPath`. Nothing exists for a project until its first
 * write, which has two visible effects this module removes:
 *
 * 1. A **new worktree** starts with an empty tree: the dashboard shows an
 *    empty board and the first agent has to bootstrap the skeleton itself
 *    through `luck_tree_upsert_leaf`'s no-parent path.
 * 2. A **new workspace** is invisible until an agent writes to it — an empty
 *    dashboard can look like a broken dashboard.
 *
 * Paseo 0.15.0 exposes exactly the hooks this needs: `worktree.create.after`
 * (awaited before workspace setup and agents start) and the two
 * `*.after` events `workspace.create.after` / `agent.create.after`.
 *
 * The seeding itself is the store's own `ensureSkeletonBranch` — the same
 * root → trunk → `General` skeleton, with its own audit rows — so a seeded
 * project and a bootstrapped one are indistinguishable. The check before it
 * is what makes the call idempotent: `ensureSkeletonBranch` *throws* when a
 * tree already exists (by design — it is the "first leaf of a fresh project"
 * path), and a hook that threw would be a hook that fails an agent creation.
 */

/** Actor recorded on the skeleton rows. An agent does not exist yet. */
export const SEED_ACTOR = "paseo";

export interface SeedProjectInput {
  /** Workspace `projectRootPath` (or the worktree path being created). */
  projectKey: string;
  /** Audit actor; defaults to {@link SEED_ACTOR}. */
  actor?: string;
}

export interface SeedProjectResult {
  /** Normalised key the call addressed, or `""` when the input was unusable. */
  projectKey: string;
  /** `true` only when this call created the skeleton. */
  created: boolean;
  /** One line for `paseo plugin logs`, always set. */
  why: string;
}

/**
 * Canonical project key for a filesystem path: trimmed, with trailing
 * separators removed (except for the root itself). Returns `null` for an
 * empty or blank path, so a hook with a missing payload never seeds `""`.
 */
export function normalizeProjectKey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const uncollapsed = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
  return uncollapsed.length === 0 ? trimmed : uncollapsed;
}

/**
 * Seeds the minimal tree for `projectKey` when — and only when — the project
 * has no live tree yet. Never throws: a hook that throws takes an agent
 * creation or a worktree creation down with it.
 */
export function seedProjectTree(
  store: LuckPlannerStore,
  input: SeedProjectInput,
): SeedProjectResult {
  const projectKey = normalizeProjectKey(input.projectKey);
  if (projectKey === null) {
    return { projectKey: "", created: false, why: "no project key in the payload" };
  }
  const actor = (input.actor ?? SEED_ACTOR).trim();
  try {
    const roots = store.listChildren(projectKey, null);
    if (roots.length > 0) {
      return {
        projectKey,
        created: false,
        why: `the project already has a tree (root '${roots[0]?.name ?? "?"}')`,
      };
    }
    const branch = store.ensureSkeletonBranch({ projectKey, actor: actor.length > 0 ? actor : SEED_ACTOR });
    return {
      projectKey,
      created: true,
      why: `seeded root → trunk → '${branch.name}' for ${projectKey}`,
    };
  } catch (cause) {
    return {
      projectKey,
      created: false,
      why: `seeding failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}
