import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Identity of the Paseo project the calling agent belongs to.
 *
 * The stdio MCP server is spawned by the agent, so it inherits the Paseo
 * environment. `PASEO_AGENT_CWD` is the checkout of the project for a local
 * workspace, and `PASEO_WORKSPACE_ID` identifies the workspace inside that
 * project. All workspaces of one project share the planning tree; the workspace
 * id is recorded in each plan file's YAML instead of becoming a folder name.
 *
 * The project — not the workspace — is the scoping unit: every workspace of one
 * project may write the whole tree of that project, and none of them may reach
 * another project's tree. The folder name therefore comes from the project:
 * the environment override, else the root of the Git checkout the workspace
 * lives in (so a workspace opened in `repo/backend` or in a worktree of `repo`
 * shares the folder `repo`), else the last path segment of the working
 * directory. A workspace whose project cannot be named has `name: null` and the
 * planning tools refuse instead of guessing a folder — a wrong guess would put
 * one project's plans inside another project's tree.
 *
 * A standalone MCP process without Paseo context has no project scope: it is
 * configured by hand (`OBSIDIAN_VAULT_PATH`, `OBSIDIAN_PLAN_ROOT`) and keeps the
 * whole planning root.
 */
export interface ProjectIdentity {
  /** Stable Paseo workspace id, recorded in plan YAML; null when standalone. */
  workspaceId: string | null;
  /** Safe folder name of the Paseo project; null when standalone or unknown. */
  name: string | null;
}

/** Optional name override, useful for worktrees and for tests. */
export const PROJECT_NAME_ENV = "OBSIDIAN_PROJECT_NAME";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Bound for the walk to the repository root; a deep tree cannot hang a tool. */
const MAX_GIT_WALK = 64;

/**
 * Root of the Git checkout containing `cwd`, or `null`.
 *
 * `path.resolve` first: a workspace may be opened in a sub-directory of its
 * checkout (`repo/backend`) or in a linked worktree, and both belong to the
 * project `repo` — the same folder every other workspace of that project uses.
 */
export function gitRootOf(cwd: string): string | null {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < MAX_GIT_WALK; depth += 1) {
    try {
      if (fs.existsSync(path.join(current, ".git"))) return current;
    } catch {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function currentProject(env: NodeJS.ProcessEnv = process.env): ProjectIdentity {
  const workspaceId = env.PASEO_WORKSPACE_ID?.trim() || null;
  if (workspaceId === null) return { workspaceId: null, name: null };

  const cwd = env.PASEO_AGENT_CWD?.trim() || "";
  const override = env[PROJECT_NAME_ENV]?.trim() || "";
  const fromGit = cwd.length > 0 ? gitRootOf(cwd) : null;
  const candidate =
    override || (fromGit !== null ? path.basename(fromGit) : cwd.length > 0 ? path.basename(cwd) : "");
  // No fallback to the workspace id: one folder per workspace would let two
  // workspaces of the same project, or two projects, silently diverge.
  return { workspaceId, name: slug(candidate) || null };
}
