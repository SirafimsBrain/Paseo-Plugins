import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../shared/settings";
import { resolveInsideVault } from "./vault";

/**
 * Directory roles.
 *
 * The plugin is given **one** directory it may touch at all (`vaultPath`, the
 * "directory available to Paseo"). Inside it, three roles are configured:
 *
 * | Role | Meaning | Agent use |
 * | --- | --- | --- |
 * | `workspace` | the configured directory itself | working material of the project |
 * | `inbox` | incoming material: converted documents, reference books, primary sources | read |
 * | `out` | authored documents produced on request | write |
 * | `raw` | scratch: clarifications, bugfix alternatives, temporary notes | write freely |
 *
 * Everything is enforced here, not in prompts: a path above `vaultPath` cannot
 * be resolved at all (`resolveInsideVault`), and a write is only accepted when
 * its target lands inside one of the configured roles.
 */

export type Role = "workspace" | "inbox" | "out" | "raw";

export interface RoleDirs {
  /** Vault-relative directory the plugin may access; `""` = the root itself. */
  workspace: string;
  inbox: string | null;
  out: string | null;
  raw: string | null;
}

/** Normalizes a configured sub-directory; `null` when it is unusable. */
export function normalizeRoleDir(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) return null;
  if (path.posix.isAbsolute(trimmed)) return null;
  const segments = trimmed.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  if (segments[0] === ".obsidian") return null;
  return segments.join("/");
}

export function resolveRoleDirs(settings: RuntimeSettings): RoleDirs {
  return {
    workspace: "",
    inbox: normalizeRoleDir(settings.inboxDir),
    out: normalizeRoleDir(settings.outDir),
    raw: normalizeRoleDir(settings.rawDir),
  };
}

/**
 * Role of a vault-relative path. `other` means "inside the workspace directory
 * but outside every named role" — readable, never writable.
 */
export function roleOfPath(relPath: string, dirs: RoleDirs): Role {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const matches = (dir: string | null): boolean =>
    dir !== null && (normalized === dir || normalized.startsWith(`${dir}/`));
  if (matches(dirs.raw)) return "raw";
  if (matches(dirs.out)) return "out";
  if (matches(dirs.inbox)) return "inbox";
  return "workspace";
}

/** True when the path is inside a directory agents may write to. */
export function isWritableRole(role: Role): boolean {
  return role === "inbox" || role === "out" || role === "raw";
}

/** Resolves `dir/name` into a vault-relative path, or explains why not. */
export function resolveRolePath(
  dirs: RoleDirs,
  role: Exclude<Role, "workspace">,
  name: string,
): { path: string } | { error: string } {
  const dir = dirs[role];
  if (dir === null) {
    return {
      error:
        `The ${role} directory is not configured. Ask the user to set it in ` +
        "Settings → Plugins → Obsidian Bridge.",
    };
  }
  const rawName = name.trim().replace(/\\/g, "/");
  // Absolute names are refused before any normalization: stripping the leading
  // slash would silently turn `/etc/passwd` into a relative name.
  if (rawName.length === 0) return { error: "A document name is required." };
  if (path.posix.isAbsolute(rawName)) {
    return { error: `'${name}' is not a file name inside the ${role} directory.` };
  }
  const cleaned = rawName.replace(/^\.\//, "").replace(/\.md$/i, "");
  const segments = cleaned.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return { error: "A document name is required." };
  if (segments.some((segment) => segment === "..")) {
    return { error: `'${name}' is not a file name inside the ${role} directory.` };
  }
  const relPath = `${dir}/${segments.join("/")}.md`;
  return { path: relPath };
}

export interface AppendOutcome {
  path: string;
  created: boolean;
  duplicate: boolean;
  bytes: number;
}

/**
 * Appends a section to a note inside one of the writable roles.
 *
 * Append-only by construction: the existing content is never rewritten. A
 * created note gets a small frontmatter block and one heading; later calls add
 * `## <date> — <title>` sections. The size check after the write catches the one
 * realistic conflict — Obsidian saving a stale buffer over the append — and the
 * caller retries once before reporting it.
 */
export function appendToNote(input: {
  root: string;
  dirs: RoleDirs;
  role: Exclude<Role, "workspace">;
  name: string;
  title?: string;
  body: string;
  create: boolean;
}): AppendOutcome | { error: string } {
  const resolved = resolveRolePath(input.dirs, input.role, input.name);
  if ("error" in resolved) return resolved;
  const absolute = resolveInsideVault(input.root, resolved.path);
  if (!absolute) return { error: `'${input.name}' resolves outside the configured directory.` };

  const body = input.body.replace(/\r\n/g, "\n").trimEnd();
  if (body.trim().length === 0) return { error: "Refusing to write an empty document." };
  if (body.length > 200_000) return { error: "Document body is too large (200 000 characters)." };

  const exists = fs.existsSync(absolute);
  if (!exists && !input.create) {
    return { error: `'${resolved.path}' does not exist and create was not requested.` };
  }

  const existing = exists ? fs.readFileSync(absolute, "utf-8") : "";
  if (existing.includes(body.trim())) {
    return { path: resolved.path, created: false, duplicate: true, bytes: 0 };
  }

  const title = (input.title?.trim() || path.posix.basename(resolved.path, ".md")).slice(0, 200);
  const date = new Date().toISOString().slice(0, 10);
  const section = `## ${date} — ${title}\n\n${body}\n`;

  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!exists) {
      const frontmatter = [
        "---",
        `title: ${title}`,
        `kind: ${input.role}`,
        `created: ${date}`,
        "source: obsidian-bridge",
        "---",
        "",
        `# ${title}`,
        "",
      ].join("\n");
      fs.writeFileSync(absolute, `${frontmatter}${section}`, "utf-8");
      return {
        path: resolved.path,
        created: true,
        duplicate: false,
        bytes: Buffer.byteLength(section),
      };
    }

    const before = fs.statSync(absolute).size;
    // O_APPEND: a concurrent append cannot interleave with ours.
    fs.appendFileSync(absolute, `\n${section}`, "utf-8");
    const after = fs.statSync(absolute).size;
    if (after < before + Buffer.byteLength(section)) {
      // Obsidian (or another writer) replaced the file between our read and our
      // write. One retry is enough for the realistic race; then report it.
      const retry = fs.readFileSync(absolute, "utf-8");
      fs.writeFileSync(absolute, `${retry.trimEnd()}\n\n${section}`, "utf-8");
    }
    return {
      path: resolved.path,
      created: false,
      duplicate: false,
      bytes: Buffer.byteLength(section),
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Human- and agent-readable directory map, used by instructions and tools. */
export function describeRoleDirs(dirs: RoleDirs): Array<{ role: Role; path: string; use: string }> {
  return [
    {
      role: "workspace",
      path: dirs.workspace === "" ? "." : dirs.workspace,
      use: "Project working material; readable everywhere inside this directory, writable only through the roles below.",
    },
    {
      role: "inbox",
      path: dirs.inbox ?? "(not configured)",
      use: "Incoming material: converted documents, reference books and other primary sources. Read; append when asked.",
    },
    {
      role: "out",
      path: dirs.out ?? "(not configured)",
      use: "Authored documents produced on request (guides, instructions, recommendations). Write here.",
    },
    {
      role: "raw",
      path: dirs.raw ?? "(not configured)",
      use: "Scratch: clarifications, bugfix alternatives, temporary notes that lose value after the work. Write freely.",
    },
  ];
}
