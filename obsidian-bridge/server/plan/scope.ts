import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { MAX_NOTE_BYTES, walkMarkdown } from "../vault";
import {
  DEFAULT_PLAN_ROOT,
  PLAN_SYSTEM_DIRS,
  planRootRelPath,
  resolvePlanRoot,
  type PlanUnavailableReason,
} from "./paths";

/**
 * `plan_scope`: the first call of every planning workflow.
 *
 * It answers one question — is there a planning tree to work with, and where —
 * without opening the index, creating a directory or writing anything. An agent
 * that gets `planning_available: false` must stop instead of guessing a path,
 * and the reason tells it what to ask the user for.
 */

export interface PlanScopeResult {
  /** `true` only when the directory exists and holds at least one plan document. */
  planning_available: boolean;
  /** Why planning is unavailable; `null` when it is available. */
  reason: null | PlanUnavailableReason | "empty";
  /** Vault-relative planning directory, including the Paseo project folder. */
  root: string;
  /** Paseo project whose plan tree is reachable; null in a standalone process. */
  project: { name: string } | null;
  /** Paseo workspace id recorded in plan files; null in a standalone process. */
  workspaceId: string | null;
  /** Absolute planning directory; `null` when it does not resolve. */
  path: string | null;
  /** True when the project folder exists but holds no plan documents yet. */
  empty: boolean;
  /** `false` when `readOnly` is on: every `plan_*` write refuses. */
  writesEnabled: boolean;
  /** Projects found in the planning root (its first-level folders with notes). */
  projectCount: number;
  projects: string[];
  /** Markdown documents under the root, excluding `__history` and `_archive`. */
  documents: number;
  /** Vault path of the project registry, when it exists. */
  registry: string | null;
  /** Vault path of the schema document, when it exists. */
  schema: string | null;
  /** Directories the planning tools always hide from search, listings and reads. */
  systemDirs: string[];
  limits: { maxWriteChars: number; maxNoteBytes: number };
  error: string | null;
}

export function planScope(settings: RuntimeSettings): PlanScopeResult {
  const base: PlanScopeResult = {
    planning_available: false,
    reason: null,
    root: (planRootRelPath(settings) ?? settings.planRoot.trim()) || DEFAULT_PLAN_ROOT,
    project: null,
    workspaceId: null,
    path: null,
    empty: false,
    // There is nowhere to write until a planning directory resolves, and
    // `readOnly` closes the gate even then.
    writesEnabled: false,
    projectCount: 0,
    projects: [],
    documents: 0,
    registry: null,
    schema: null,
    systemDirs: [...PLAN_SYSTEM_DIRS],
    limits: { maxWriteChars: settings.maxWriteChars, maxNoteBytes: MAX_NOTE_BYTES },
    error: null,
  };

  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) {
    return { ...base, reason: resolved.reason, error: resolved.error };
  }

  const { root } = resolved;
  // The walk already skips `__history` and `_archive`, so the counts describe
  // the live tree and never its snapshots.
  const walk = walkMarkdown(root.vaultRoot, {
    includeFolders: root.relPath,
    excludeGlobs: "",
  });

  const projects = new Set<string>();
  for (const vaultPath of walk.files) {
    const planPath = vaultPath.slice(root.relPath.length + 1);
    const [first] = planPath.split("/");
    if (planPath.includes("/") && !first.startsWith("_")) projects.add(first);
  }
  const registryPath = `${root.relPath}/_index.md`;
  const schemaPath = `${root.relPath}/_schema.md`;

  const scope: PlanScopeResult = {
    ...base,
    project: root.project,
    workspaceId: root.workspaceId,
    path: root.absolute,
    writesEnabled: !settings.readOnly,
    projectCount: projects.size,
    projects: [...projects].sort(),
    documents: walk.files.length,
    registry: fs.existsSync(path.join(root.vaultRoot, registryPath)) ? registryPath : null,
    schema: fs.existsSync(path.join(root.vaultRoot, schemaPath)) ? schemaPath : null,
  };

  const empty = walk.files.length === 0;
  return {
    ...scope,
    empty,
    planning_available: true,
    error: empty
      ? `The planning directory '${root.relPath}' is ready but holds no plan documents. ` +
        "Create the first node with `plan_create_node`."
      : null,
  };
}

export function planScopeTool(settings: RuntimeSettings): ToolOutcome {
  const scope = planScope(settings);
  return { text: JSON.stringify(scope, null, 2), structuredContent: scope };
}
