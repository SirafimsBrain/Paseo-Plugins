/**
 * Theme catalog on disk (PLAN.md stage L7, `__doc.md` §6).
 *
 * Two directories, one format:
 *
 * - the **shipped** catalog (`<plugin>/themes/*.json`, committed with the
 *   code) — the palettes the plugin ships and the stylesheet's floor defaults
 *   agree with;
 * - the **user** directory (`<data>/themes/*.json`, next to the database, the
 *   way `backups/` already is) — where a person puts a palette of their own.
 *
 * The loader is deliberately forgiving: a theme is a taste, and a typo in one
 * file must not take the dashboard down or hide the other themes. Every
 * unusable file becomes an entry in `problems` (file + one sentence), the rest
 * of the catalog loads, and the tab shows the same colours it would have shown
 * without the file. That is the difference between a bad theme and a broken
 * product.
 *
 * The user directory is read on **every request**, not cached at startup:
 * there is no watcher, no invalidation and no stale copy — adding a file and
 * reloading the tab is the whole workflow.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultThemeId,
  mergeThemes,
  themeCatalogSchema,
  themeDefinitionSchema,
  type ThemeCatalog,
  type ThemeCatalogEntry,
  type ThemeDefinition,
  type ThemeProblem,
} from "../shared/themes";

/** A theme file is a palette, not a document: anything near this is a mistake. */
const MAX_THEME_FILE_BYTES = 64 * 1024;

/** Only regular files named like a theme id are read. */
const THEME_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

/**
 * The user theme directory for a database path: `themes/` beside the file,
 * the same convention as `backups/` (ADR-2). A test store in a temp directory
 * therefore gets a temp theme directory, not the user's real one.
 */
export function defaultThemeDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), "themes");
}

/** What one directory yielded: the themes it defined, the files it refused. */
export interface ThemeDirectoryRead {
  themes: ThemeDefinition[];
  problems: ThemeProblem[];
}

/**
 * Reads one directory of theme files.
 *
 * A missing directory is not a problem — it is the normal state of a fresh
 * install, and the user directory usually does not exist until someone makes
 * it. Files are read in sorted name order and each one is validated on its
 * own, so the result never depends on the filesystem's enumeration order.
 */
export function readThemeDirectory(dir: string): ThemeDirectoryRead {
  const themes: ThemeDefinition[] = [];
  const problems: ThemeProblem[] = [];
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => THEME_FILE.test(name))
      .sort();
  } catch {
    return { themes, problems };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const problem = (message: string): void => {
      problems.push({ file, problem: message });
    };
    let raw: string;
    try {
      const stats = fs.statSync(file);
      if (!stats.isFile()) {
        problem("not a file");
        continue;
      }
      if (stats.size > MAX_THEME_FILE_BYTES) {
        problem(`larger than ${MAX_THEME_FILE_BYTES} bytes`);
        continue;
      }
      raw = fs.readFileSync(file, "utf8");
    } catch (cause) {
      problem(`cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      problem(`is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    const result = themeDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      problem(
        issue === undefined
          ? "does not match the theme format"
          : `${issue.path.join(".") || "theme"}: ${issue.message}`,
      );
      continue;
    }
    const theme = result.data;
    const expected = `${theme.id}.json`;
    if (name !== expected) {
      // The file name *is* how two directories claim the same id; a mismatch
      // would make the merge order decide which file wins.
      problem(`declares id "${theme.id}" — rename the file to ${expected}`);
      continue;
    }
    themes.push(theme);
  }
  return { themes, problems };
}

/** Loads the whole catalog: shipped first, the user's directory on top. */
export function loadThemeCatalog(options: {
  builtInDir: string;
  userDir: string;
}): ThemeCatalog {
  const builtIn = readThemeDirectory(options.builtInDir);
  const user = readThemeDirectory(options.userDir);
  const themes: readonly ThemeCatalogEntry[] = mergeThemes(
    builtIn.themes,
    user.themes,
  );
  return themeCatalogSchema.parse({
    default: defaultThemeId(themes),
    themes,
    problems: [...builtIn.problems, ...user.problems],
    userDirectory: options.userDir,
  });
}
