import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import { normalizeRoleDir } from "../dirs";
import { resolveVaultRoot } from "../paths";
import { PLAN_SYSTEM_DIRS, isPlanSystemPath, resolveInsideVault } from "../vault";

/**
 * Path boundary of the planning tools.
 *
 * Planning is not a second vault: `planRoot` is a directory **inside** the one
 * directory the plugin already owns (`vaultPath`), by default `Workspaces`. A
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
 * Nothing here creates a directory: a missing planning root is reported, never
 * materialised, so `plan_scope` on an empty installation stays read-only.
 */

/** Directory the planning tools are confined to when nothing else is configured. */
export const DEFAULT_PLAN_ROOT = "Workspaces";

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
export function resolvePlanRoot(settings: RuntimeSettings): PlanRootResult {
  const vaultRoot = resolveVaultRoot(settings.vaultPath);
  if (vaultRoot.length === 0) {
    return {
      reason: "not_configured",
      error:
        "The Obsidian directory is not configured, so there is no planning directory either. " +
        "Ask the user to set it in Settings → Plugins → Obsidian Bridge.",
    };
  }

  const configured = settings.planRoot.trim();
  if (configured.length === 0) {
    return {
      reason: "not_configured",
      error:
        "The planning directory is not configured. Set `planRoot` in Settings → Plugins → " +
        `Obsidian Bridge; the default is '${DEFAULT_PLAN_ROOT}'.`,
    };
  }

  const relPath = normalizeRoleDir(configured);
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

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return {
      reason: "missing",
      error: `The planning directory '${relPath}' does not exist under '${vaultRoot}'.`,
    };
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

  return { root: { vaultRoot, relPath, absolute: realRoot } };
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
  const resolved = resolvePlanRoot(settings);
  if ("root" in resolved) {
    return { root: resolved.root.relPath, path: resolved.root.absolute, exists: true };
  }
  return {
    root: settings.planRoot.trim() || DEFAULT_PLAN_ROOT,
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
