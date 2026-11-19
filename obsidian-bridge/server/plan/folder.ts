import * as fs from "node:fs";
import type { RuntimeSettings } from "../../shared/settings";
import { normalizeRoleDir } from "../dirs";
import { resolveVaultRoot } from "../paths";
import { resolveInsideVault } from "../vault";
import { DEFAULT_PLAN_ROOT } from "./paths";

/**
 * Existence check and creation of the **planning base folder**.
 *
 * The settings screen offers this so a typo in "Planning directory" is caught
 * before the first `plan_*` call: it reports whether `<vaultPath>/<planRoot>`
 * exists, and can create it (with missing parents) on request.
 *
 * The same ladder as every other path in this plugin applies: the absolute
 * value is refused by `normalizeRoleDir`, the vault boundary (including the
 * `realpath` comparison, so a symlink cannot step out) by `resolveInsideVault`.
 * Nothing above the planning base is created — the per-project subfolder is
 * still created by `plan_*` itself, because only an agent knows its project.
 */

export interface PlanDirectoryState {
  /** Normalized vault-relative folder that was checked (`""` when unusable). */
  folder: string;
  /** Absolute path on disk; null when it could not be resolved. */
  path: string | null;
  exists: boolean;
  isDirectory: boolean;
  /** True only when this call made the folder. */
  created: boolean;
  error: string | null;
}

function failure(folder: string, error: string, absolute: string | null = null): PlanDirectoryState {
  return { folder, path: absolute, exists: false, isDirectory: false, created: false, error };
}

/**
 * Resolves (and optionally creates) the planning base folder.
 *
 * Never creates anything unless `options.create` is true; a status query is
 * read-only.
 */
export function planDirectoryState(
  settings: RuntimeSettings,
  options: { relPath?: string; create?: boolean } = {},
): PlanDirectoryState {
  const vaultRoot = resolveVaultRoot(settings.vaultPath);
  if (vaultRoot.length === 0) {
    return failure("", "Set the directory available to Paseo first.");
  }

  const requested = (options.relPath ?? settings.planRoot).trim() || DEFAULT_PLAN_ROOT;
  const folder = normalizeRoleDir(requested);
  if (folder === null) {
    return failure(
      requested,
      `'${requested}' is not a valid planning directory: pass a path relative to the vault, ` +
        "without '..', an absolute path or `.obsidian`.",
    );
  }

  const absolute = resolveInsideVault(vaultRoot, folder);
  if (absolute === null) {
    return failure(folder, `The planning directory '${folder}' resolves outside the configured vault.`);
  }

  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(absolute);
  } catch {
    stat = null;
  }

  if (stat !== null) {
    if (!stat.isDirectory()) {
      return failure(folder, `'${folder}' exists but is a file, not a directory.`, absolute);
    }
    return { folder, path: absolute, exists: true, isDirectory: true, created: false, error: null };
  }

  if (options.create !== true) {
    return {
      folder,
      path: absolute,
      exists: false,
      isDirectory: false,
      created: false,
      error: null,
    };
  }

  try {
    fs.mkdirSync(absolute, { recursive: true });
  } catch (cause) {
    return failure(
      folder,
      `The planning directory '${folder}' cannot be created: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      absolute,
    );
  }

  // Re-resolve: the folder now exists, so the realpath comparison runs on the
  // folder itself instead of its nearest existing ancestor (a symlinked parent
  // that leads out of the vault is refused here, before anything is written).
  if (resolveInsideVault(vaultRoot, folder) === null) {
    return failure(
      folder,
      `The planning directory '${folder}' resolves outside the configured vault.`,
      absolute,
    );
  }
  try {
    if (!fs.statSync(absolute).isDirectory()) {
      return failure(folder, `'${folder}' exists but is a file, not a directory.`, absolute);
    }
  } catch (cause) {
    return failure(
      folder,
      `The planning directory '${folder}' cannot be read back: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      absolute,
    );
  }

  return { folder, path: absolute, exists: true, isDirectory: true, created: true, error: null };
}
