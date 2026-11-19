import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import { normalizeRoleDir } from "../dirs";
import { resolveVaultRoot } from "../paths";
import { PLAN_SYSTEM_DIRS, isPlanSystemPath, resolveInsideVault } from "../vault";
import { currentProject } from "./project";

/**
 * Path boundary of the planning tools.
 *
 * Planning is not a second vault: `planRoot` is a directory **inside** the one
 * directory the plugin already owns (`vaultPath`), by default `Projects`. A
 * `plan_*` tool therefore has no path syntax of its own — every argument is a
 * path relative to `planRoot` and is resolved by the same ladder as an
 * `obsidian_*` argument:
 *
 * 1. `normalizeRoleDir` rejects an absolute path, `..`, control characters and
 *    `.obsidian`;
 * 2. `resolveInsideVault` rejects anything above the vault;
 * 3. a `realpath` comparison against the planning root rejects a symlink that
 *    leads out of it (the same check `obsidian_edit` makes on a note).
 *
 * The plugin owns the directory hierarchy. A missing planning root is created
 * here (with `recursive: true`), together with a folder named after the Paseo
 * project of the calling agent. The **project** is the scoping unit: all
 * workspaces of that project share this tree, the calling workspace is recorded
 * in each plan file's YAML by id, and no workspace can address a sibling
 * project — its root is already the project folder, and `..` is refused by
 * `normalizePlanPath`. A workspace whose project cannot be named is refused
 * rather than given a folder of its own, because a guessed folder could place
 * one project's plans inside another project's tree. Status queries pass
 * `{ create: false }` so reporting never changes the vault.
 */

/** Directory the planning tools are confined to when nothing else is configured. */
export const DEFAULT_PLAN_ROOT = "Projects";

export { PLAN_SYSTEM_DIRS, isPlanSystemPath };

/** Control characters have no business in a note or folder name. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Sorted, normalized planning root: the only handle a path resolver needs. */
export interface PlanRoot {
  /** Absolute vault root (`vaultPath` after `resolveVaultRoot`). */
  vaultRoot: string;
  /** Vault-relative planning directory, e.g. `Workspaces`. */
  relPath: string;
  /** Absolute, symlink-resolved planning directory. */
  absolute: string;
  /** Paseo project whose plan tree this root addresses; null when standalone. */
  project: { name: string } | null;
  /** Paseo workspace id recorded in plan files; null when standalone. */
  workspaceId: string | null;
}

export type PlanUnavailableReason = "not_configured" | "invalid" | "missing";

export type PlanRootResult =
  | { root: PlanRoot }
  | { reason: PlanUnavailableReason; error: string };

/**
 * Resolves `planRoot` inside the configured vault.
 *
 * The planning directory must already exist: creating it is a user decision
 * (start a project, ask for a tree), not a side effect of reading the scope.
 */
export function resolvePlanRoot(
  settings: RuntimeSettings,
  options: { allowMissing?: boolean; create?: boolean } = {},
): PlanRootResult {
  const vaultRoot = resolveVaultRoot(settings.vaultPath);
  if (vaultRoot.length === 0) {
    return {
      reason: "not_configured",
      error:
        "The Obsidian directory is not configured, so there is no planning directory either. " +
        "Ask the user to set it in Settings → Plugins → Obsidian Bridge.",
    };
  }

  // Scoping is by project, never by workspace (0.20.13). A Paseo workspace whose
  // project folder cannot be derived gets an explanation instead of a private
  // folder: one folder per workspace would silently split a project's tree and,
  // worse, put a guessed name next to other projects.
  const identity = currentProject();
  if (identity.workspaceId !== null && identity.name === null) {
    return {
      reason: "invalid",
      error:
        "The Paseo project of this workspace cannot be determined, so the planning tools " +
        "refuse to choose a project folder: a guessed folder could write into another " +
        "project's plan tree. Open the workspace from its project checkout (or set " +
        "OBSIDIAN_PROJECT_NAME for it) and retry; nothing was created.",
    };
  }

  const relPath = planRootRelPath(settings);
  if (relPath === null) {
    return {
      reason: "invalid",
      error:
        `'${settings.planRoot}' is not a valid planning directory: pass a path relative to the ` +
        "vault, without '..', an absolute path or `.obsidian`.",
    };
  }

  const absolute = resolveInsideVault(vaultRoot, relPath);
  if (absolute === null) {
    return {
      reason: "invalid",
      error: `The planning directory '${relPath}' resolves outside the configured vault.`,
    };
  }
  const scope =
    identity.name === null
      ? { project: null, workspaceId: null }
      : { project: { name: identity.name }, workspaceId: identity.workspaceId };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    if (options.allowMissing) return { root: { vaultRoot, relPath, absolute, ...scope } };
    if (options.create === false) {
      return {
        reason: "missing",
        error: `The planning directory '${relPath}' does not exist under '${vaultRoot}'.`,
      };
    }
    try {
      fs.mkdirSync(absolute, { recursive: true });
      stat = fs.statSync(absolute);
    } catch (cause) {
      return {
        reason: "invalid",
        error: `The planning directory '${relPath}' cannot be created: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      };
    }
  }
  if (!stat.isDirectory()) {
    return { reason: "missing", error: `The planning directory '${relPath}' is not a directory.` };
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(absolute);
  } catch (cause) {
    return {
      reason: "invalid",
      error: `The planning directory '${relPath}' cannot be resolved: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (escapes(rootPrefix(vaultRoot), realRoot)) {
    return {
      reason: "invalid",
      error: `The planning directory '${relPath}' resolves outside the configured vault.`,
    };
  }

  return { root: { vaultRoot, relPath, absolute: realRoot, ...scope } };
}

/**
 * Vault-relative planning root: the configured directory (or the default) plus
 * the folder named after the current Paseo project. Pure — no filesystem
 * access — so the UI can show the effective root without creating anything.
 */
export function planRootRelPath(settings: RuntimeSettings): string | null {
  const base = settings.planRoot.trim() || DEFAULT_PLAN_ROOT;
  const normalized = normalizeRoleDir(base);
  if (normalized === null) return null;
  const identity = currentProject();
  return identity.name === null ? normalized : `${normalized}/${identity.name}`;
}

export interface ResolvedPlanPath {
  /** Absolute path on disk. */
  absolute: string;
  /** Path relative to the planning root, e.g. `centurion/centurion.md`. */
  relPath: string;
  /** Vault-relative path, the form Obsidian links and `obsidian_*` use. */
  vaultPath: string;
}

/**
 * Normalizes a planning-relative path; `null` when it could address something
 * outside the planning root.
 */
export function normalizePlanPath(value: string): string | null {
  const raw = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (raw.length === 0) return null;
  if (path.posix.isAbsolute(raw)) return null;
  const segments = raw
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return null;
  if (
    segments.some(
      (segment) => segment === ".." || segment === ".obsidian" || CONTROL_CHARS.test(segment),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

/**
 * Resolves a path relative to the planning root, or explains why it cannot.
 *
 * `root` must come from {@link resolvePlanRoot}, so the two boundaries — the
 * vault and the planning directory — are always applied in that order.
 */
export function resolvePlanPath(
  root: PlanRoot,
  value: string,
): ResolvedPlanPath | { error: string } {
  const relPath = normalizePlanPath(value);
  if (relPath === null) {
    return {
      error:
        `'${value}' is not a path inside the planning directory '${root.relPath}': pass a path ` +
        "relative to it, without '..', an absolute path or `.obsidian`.",
    };
  }
  const vaultPath = `${root.relPath}/${relPath}`;
  const absolute = resolveInsideVault(root.vaultRoot, vaultPath);
  if (absolute === null) {
    return { error: `'${value}' resolves outside the configured vault.` };
  }
  if (escapes(rootPrefix(root.absolute), nearestExisting(absolute))) {
    return {
      error: `'${value}' resolves outside the planning directory '${root.relPath}'.`,
    };
  }
  return { absolute, relPath, vaultPath };
}

/** Cheap planning-root summary for `obsidian_status`; never walks the tree. */
export function planRootSummary(settings: RuntimeSettings): {
  root: string;
  path: string | null;
  exists: boolean;
} {
  // Reporting must not create directories; `plan_scope` and the plan tools do.
  const resolved = resolvePlanRoot(settings, { create: false });
  if ("root" in resolved) {
    return { root: resolved.root.relPath, path: resolved.root.absolute, exists: true };
  }
  return {
    root: (planRootRelPath(settings) ?? settings.planRoot.trim()) || DEFAULT_PLAN_ROOT,
    path: null,
    exists: false,
  };
}

function rootPrefix(absolute: string): string {
  return absolute.endsWith(path.sep) ? absolute : `${absolute}${path.sep}`;
}

function escapes(prefix: string, target: string): boolean {
  return target !== prefix.slice(0, -1) && !target.startsWith(prefix);
}

/**
 * Nearest ancestor that exists, with its symlinks resolved.
 *
 * A file that is about to be created does not exist yet, but its parent does —
 * resolving the parent catches a symlink that points out of the planning root
 * before anything is written.
 */
function nearestExisting(absolute: string): string {
  let current = absolute;
  while (true) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
