import * as path from "node:path";

/**
 * Identity of the Paseo project the calling agent belongs to.
 *
 * The stdio MCP server is spawned by the agent, so it inherits the Paseo
 * environment. `PASEO_AGENT_CWD` is the checkout of the project for a local
 * workspace, and `PASEO_WORKSPACE_ID` identifies the workspace inside that
 * project. All workspaces of one project share the planning tree; the workspace
 * id is recorded in each plan file's YAML instead of becoming a folder name.
 * A standalone MCP process without Paseo context has no project scope.
 */
export interface ProjectIdentity {
  /** Stable Paseo workspace id, recorded in plan YAML; null when standalone. */
  workspaceId: string | null;
  /** Safe folder name of the Paseo project; null when standalone. */
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

export function currentProject(env: NodeJS.ProcessEnv = process.env): ProjectIdentity {
  const workspaceId = env.PASEO_WORKSPACE_ID?.trim() || null;
  if (workspaceId === null) return { workspaceId: null, name: null };

  const cwd = env.PASEO_AGENT_CWD?.trim() || "";
  const fromPaseo = env[PROJECT_NAME_ENV]?.trim() || (cwd.length > 0 ? path.basename(cwd) : "");
  return { workspaceId, name: slug(fromPaseo) || workspaceId };
}
