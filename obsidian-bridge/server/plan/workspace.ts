import * as path from "node:path";

/**
 * Identity of the Paseo workspace the calling agent belongs to.
 *
 * The stdio MCP server is spawned by the agent, so it inherits the Paseo
 * environment. No new plugin API or daemon call is needed: `PASEO_WORKSPACE_ID`
 * identifies the workspace and `PASEO_AGENT_CWD` gives its human-readable name
 * (the workspace root for a local checkout). A standalone MCP process without
 * Paseo context has no workspace scope and keeps using the planning root as a
 * single shared tree.
 */
export interface WorkspaceIdentity {
  /** Stable Paseo id, or null when the process was not launched by an agent. */
  id: string | null;
  /** Safe folder name taken from Paseo (name of the workspace). */
  name: string | null;
}

/** Optional override, useful for a standalone MCP process and for tests. */
export const WORKSPACE_NAME_ENV = "OBSIDIAN_WORKSPACE_NAME";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function currentWorkspace(env: NodeJS.ProcessEnv = process.env): WorkspaceIdentity {
  const id = env.PASEO_WORKSPACE_ID?.trim() || null;
  if (id === null) return { id: null, name: null };

  const cwd = env.PASEO_AGENT_CWD?.trim() || "";
  const fromPaseo = env[WORKSPACE_NAME_ENV]?.trim() || (cwd.length > 0 ? path.basename(cwd) : "");
  return { id, name: slug(fromPaseo) || id };
}
