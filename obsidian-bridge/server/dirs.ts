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

/** The roles a write may target. */
export type WritableRole = Exclude<Role, "workspace">;

export interface RoleDirs {
  /** Vault-relative directory the plugin may access; `""` = the root itself. */
  workspace: string;
  inbox: string | null;
  out: string | null;
  raw: string | null;
}

/** Upper bound for a configured sub-directory and for one document name. */
const MAX_PATH_CHARS = 200;

/** Control characters have no business in a note or folder name. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Normalizes a vault-relative folder; `null` when it is unusable. Refuses
 * absolute paths, parent traversal and the vault's own configuration directory,
 * so a folder argument can never point above the configured root.
 */
export function normalizeRoleDir(value: string): string | null {
  const raw = value.trim().replace(/\\/g, "/");
  if (raw.length === 0 || raw.length > MAX_PATH_CHARS) return null;
  if (path.posix.isAbsolute(raw)) return null;
  const segments = raw.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === ".." || CONTROL_CHARS.test(segment))) return null;
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
 * Role of a vault-relative path. `workspace` means "inside the configured
 * directory but outside every named role" — readable, never writable.
 */
export function roleOfPath(relPath: string, dirs: RoleDirs): Role {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  for (const role of ["raw", "out", "inbox"] as const) {
    const dir = dirs[role];
    if (dir !== null && (normalized === dir || normalized.startsWith(`${dir}/`))) return role;
  }
  return "workspace";
}

/**
 * Turns a document name into a path relative to its role, or `null` when the
 * name could address something outside it. Nested names (`guides/queues`) are
 * allowed; absolute names, `..`, control characters and empty names are not.
 */
export function normalizeDocumentName(value: string): string | null {
  const raw = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (raw.length === 0 || raw.length > MAX_PATH_CHARS) return null;
  if (path.posix.isAbsolute(raw)) return null;
  const segments = raw
    .replace(/\.md$/i, "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === ".." || CONTROL_CHARS.test(segment))) return null;
  return `${segments.join("/")}.md`;
}

/** Resolves `dir/name` into a vault-relative path, or explains why not. */
export function resolveRolePath(
  dirs: RoleDirs,
  role: WritableRole,
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
  const fileName = normalizeDocumentName(name);
  if (fileName === null) {
    return { error: `'${name}' is not a valid document name inside the ${role} directory.` };
  }
  return { path: `${dir}/${fileName}` };
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
 * `## <date> — <title>` sections.
 *
 * The two writer races are handled explicitly:
 * - creation uses `O_EXCL` (`flag: "wx"`), so a note created concurrently by the
 *   user or Obsidian is appended to instead of being overwritten;
 * - `appendFileSync` opens with `O_APPEND`, so a concurrent append cannot lose
 *   our offset, and the section is then read back from the file's tail. If the
 *   file was replaced in between (Obsidian saving a stale buffer), the append is
 *   repeated; when it still cannot be seen, the tool reports it instead of
 *   claiming success.
 */
export function appendToNote(input: {
  root: string;
  dirs: RoleDirs;
  role: WritableRole;
  name: string;
  title?: string;
  body: string;
  create: boolean;
}): AppendOutcome | { error: string } {
  const resolved = resolveRolePath(input.dirs, input.role, input.name);
  if ("error" in resolved) return resolved;
  const absolute = resolveInsideVault(input.root, resolved.path);
  if (!absolute) return { error: `'${resolved.path}' resolves outside the configured directory.` };

  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (body.length === 0) return { error: "Refusing to write an empty document." };

  const title = (input.title?.trim() || path.posix.basename(resolved.path, ".md")).slice(0, 200);
  const date = new Date().toISOString().slice(0, 10);
  const section = `## ${date} — ${title}\n\n${body}\n`;

  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });

    const existing = readIfExists(absolute);
    if (existing !== null) {
      if (existing.includes(body)) {
        return { path: resolved.path, created: false, duplicate: true, bytes: 0 };
      }
      appendSection(absolute, section);
      return {
        path: resolved.path,
        created: false,
        duplicate: false,
        bytes: Buffer.byteLength(section),
      };
    }

    if (!input.create) {
      return { error: `'${resolved.path}' does not exist and create was not requested.` };
    }

    const header = [
      "---",
      `title: ${title}`,
      `kind: ${input.role}`,
      `created: ${date}`,
      "source: obsidian-bridge",
      "---",
      "",
      `# ${title}`,
      "",
      "",
    ].join("\n");
    const document = `${header}${section}`;
    try {
      fs.writeFileSync(absolute, document, { encoding: "utf-8", flag: "wx" });
      return {
        path: resolved.path,
        created: true,
        duplicate: false,
        bytes: Buffer.byteLength(document),
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      // Someone created the note between our read and our create: append to it.
      appendSection(absolute, section, body);
      return {
        path: resolved.path,
        created: false,
        duplicate: false,
        bytes: Buffer.byteLength(section),
      };
    }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function readIfExists(absolute: string): string | null {
  try {
    return fs.readFileSync(absolute, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/**
 * Appends `section` and confirms it landed. Repeats the append once when the
 * file was replaced while writing; throws rather than lying about the outcome.
 */
function appendSection(absolute: string, section: string, body = section): void {
  const chunk = `\n${section}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // O_APPEND: the kernel picks the offset, so concurrent appends cannot
    // overwrite each other.
    fs.appendFileSync(absolute, chunk, "utf-8");
    if (tailContains(absolute, body)) return;
  }
  throw new Error(
    `Could not confirm the append to '${path.basename(absolute)}': the file was replaced while ` +
      "writing, which is what Obsidian does when it saves a stale buffer. Wait for Obsidian to " +
      "finish saving and retry the call.",
  );
}

/** True when `needle` appears in the last few kilobytes of the file. */
function tailContains(absolute: string, needle: string): boolean {
  const stat = fs.statSync(absolute);
  const size = Math.min(stat.size, Buffer.byteLength(needle) + 512);
  if (size === 0) return false;
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(absolute, "r");
  try {
    fs.readSync(fd, buffer, 0, size, stat.size - size);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf-8").includes(needle);
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
