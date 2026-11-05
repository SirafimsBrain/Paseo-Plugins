/**
 * Theme catalog (PLAN.md stage L7, `__doc.md` §6).
 *
 * A theme is data: one JSON file per palette, a shipped directory and a user
 * directory merged by id, served to the tab over `/api/themes`. These tests pin
 * the three halves that can go wrong independently:
 *
 * - the **model** (`shared/themes.ts`): merge order, the theme that gets
 *   painted, and the appearance hint derived from Paseo's colours;
 * - the **loader** (`server/themes.ts`): a bad file is a `problems` entry, not
 *   a crash — a typo in one palette must never hide the others;
 * - the **URL helpers** (`shared/api.ts`): the appearance hint appended to an
 *   already-built dashboard address.
 *
 * Real files in temp directories, like the store tests: the loader is exactly
 * the code that reads the user's directory, and mocking `fs` would test the
 * mock instead.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appearanceFromHostColors,
  appearanceOfColor,
  defaultThemeId,
  DEFAULT_THEME_ID,
  mergeThemes,
  relativeLuminance,
  resolveAppearance,
  resolveThemeId,
  themeCssVariables,
  themeDefinitionSchema,
  THEME_TOKEN_KEYS,
  THEME_TOKEN_VARIABLES,
  type ThemeDefinition,
} from "../shared/themes";
import { defaultThemeDir, loadThemeCatalog, readThemeDirectory } from "../server/themes";
import { themesUrl, withAppearance } from "../shared/api";

const dirs: string[] = [];

function tempDir(name = "luck-planner-themes-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function theme(
  id: string,
  appearance: "light" | "dark",
  extra: Partial<ThemeDefinition> = {},
): ThemeDefinition {
  return {
    id,
    name: id,
    appearance,
    tokens: {
      bg: appearance === "dark" ? "#0f1115" : "#f6f7f9",
      surface: appearance === "dark" ? "#171a21" : "#ffffff",
      border: "#262b36",
      text: "#e6e9ef",
      textMuted: "#8b93a3",
      accent: "#5b9dff",
      selection: "rgba(91, 157, 255, 0.16)",
    },
    ...extra,
  };
}

function writeTheme(dir: string, file: string, content: unknown): void {
  writeFileSync(
    path.join(dir, file),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

// ── The model ────────────────────────────────────────────────────────────

describe("mergeThemes", () => {
  it("orders built-ins before user themes, each by id", () => {
    const merged = mergeThemes(
      [theme("zeta", "dark"), theme("alpha", "dark")],
      [theme("beta", "light")],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["alpha", "beta", "zeta"]);
    expect(merged.find((entry) => entry.id === "beta")?.origin).toBe("user");
  });

  it("lets a user file replace a shipped theme with the same id", () => {
    const merged = mergeThemes(
      [theme("dark", "dark", { name: "Graphite" })],
      [theme("dark", "light", { name: "My dark" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "dark",
      name: "My dark",
      appearance: "light",
      origin: "user",
    });
  });
});

describe("defaultThemeId", () => {
  it("prefers the shipped dark theme, then the first theme", () => {
    expect(defaultThemeId([theme("alpha", "light"), theme(DEFAULT_THEME_ID, "dark")])).toBe(
      DEFAULT_THEME_ID,
    );
    expect(defaultThemeId([theme("alpha", "light")])).toBe("alpha");
    expect(defaultThemeId([])).toBe("");
  });
});

describe("resolveThemeId", () => {
  const catalog = {
    default: "dark",
    themes: [theme("dark", "dark"), theme("light", "light")],
  };

  it("keeps a stored theme that still exists, whatever the appearance", () => {
    expect(resolveThemeId("light", catalog, "dark")).toBe("light");
  });

  it("matches the appearance when nothing is stored", () => {
    expect(resolveThemeId(null, catalog, "light")).toBe("light");
    expect(resolveThemeId(null, catalog, "dark")).toBe("dark");
  });

  it("falls back to the default, then to the first theme", () => {
    const onlyLight = { default: "gone", themes: [theme("light", "light")] };
    expect(resolveThemeId(null, onlyLight, "dark")).toBe("light");
    expect(resolveThemeId(null, { default: "", themes: [] }, "dark")).toBe("");
  });
});

describe("resolveAppearance", () => {
  it("takes the host hint first, then the OS", () => {
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance(null, false)).toBe("light");
    expect(resolveAppearance(null, true)).toBe("dark");
  });
});

describe("appearance from colours", () => {
  it("reads the luminance of the palettes' own surfaces", () => {
    expect(appearanceOfColor("#0f1115")).toBe("dark");
    expect(appearanceOfColor("#171a21")).toBe("dark");
    expect(appearanceOfColor("#f6f7f9")).toBe("light");
    expect(appearanceOfColor("#ffffff")).toBe("light");
    expect(appearanceOfColor("#000")).toBe("dark");
    expect(appearanceOfColor("#fff")).toBe("light");
    // An alpha channel does not change how the surface reads.
    expect(appearanceOfColor("#ffffffcc")).toBe("light");
  });

  it("answers null for a colour it cannot parse", () => {
    expect(relativeLuminance("rgb(15, 17, 21)")).toBeNull();
    expect(relativeLuminance("nonsense")).toBeNull();
    expect(appearanceOfColor("#12")).toBeNull();
  });

  it("marks the midpoint of the scale as dark (0.216 luminance)", () => {
    expect(appearanceOfColor("#808080")).toBe("dark");
    expect(appearanceOfColor("#c0c0c0")).toBe("light");
  });

  it("derives the hint from the host's surface, falling back to the text colour", () => {
    expect(appearanceFromHostColors({ surface0: "#1b1f27" })).toBe("dark");
    expect(appearanceFromHostColors({ surface0: "#ffffff" })).toBe("light");
    expect(appearanceFromHostColors({ foreground: "#f5f5f5" })).toBe("dark");
    expect(appearanceFromHostColors({})).toBeNull();
    expect(appearanceFromHostColors({ surface0: "not-a-colour" })).toBeNull();
  });
});

describe("themeCssVariables", () => {
  it("maps every token onto the stylesheet's custom property", () => {
    const tokens = theme("x", "dark").tokens;
    const variables = themeCssVariables(tokens);
    expect(Object.keys(variables).sort()).toEqual(
      Object.values(THEME_TOKEN_VARIABLES).sort(),
    );
    for (const key of THEME_TOKEN_KEYS) {
      expect(variables[THEME_TOKEN_VARIABLES[key]]).toBe(tokens[key]);
    }
  });
});

describe("themeDefinitionSchema", () => {
  it("accepts a well-formed file", () => {
    expect(themeDefinitionSchema.safeParse(theme("graphite", "dark")).success).toBe(
      true,
    );
  });

  it("rejects an id that is not an identifier, and a missing token", () => {
    expect(themeDefinitionSchema.safeParse(theme("Graphite Dark", "dark")).success).toBe(
      false,
    );
    const { textMuted: _ignored, ...incomplete } = theme("x", "dark").tokens;
    expect(
      themeDefinitionSchema.safeParse({ ...theme("x", "dark"), tokens: incomplete })
        .success,
    ).toBe(false);
  });
});

// ── The loader ───────────────────────────────────────────────────────────

describe("readThemeDirectory", () => {
  it("reads the well-formed files and ignores files that are not themes", () => {
    const dir = tempDir();
    writeTheme(dir, "graphite.json", theme("graphite", "dark"));
    writeTheme(dir, "notes.txt", "not a theme");
    writeTheme(dir, "graphite.json.bak", theme("graphite", "dark"));
    const read = readThemeDirectory(dir);
    expect(read.themes.map((entry) => entry.id)).toEqual(["graphite"]);
    expect(read.problems).toEqual([]);
  });

  it("reports a directory that is named like a theme file", () => {
    // It looks like a theme and is not one; silence would be the surprise.
    const dir = tempDir();
    mkdirSync(path.join(dir, "folder.json"));
    const read = readThemeDirectory(dir);
    expect(read.themes).toEqual([]);
    expect(read.problems[0]?.problem).toMatch(/not a file/);
  });

  it("answers an empty catalog for a directory that does not exist", () => {
    expect(readThemeDirectory(path.join(tempDir(), "absent"))).toEqual({
      themes: [],
      problems: [],
    });
  });

  it("reports a file that is not JSON, and keeps the others", () => {
    const dir = tempDir();
    writeTheme(dir, "paper.json", theme("paper", "light"));
    writeTheme(dir, "broken.json", "{ nope");
    const read = readThemeDirectory(dir);
    expect(read.themes.map((entry) => entry.id)).toEqual(["paper"]);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]?.file).toContain("broken.json");
    expect(read.problems[0]?.problem).toMatch(/not valid JSON/);
  });

  it("names the offending field when the file does not match the format", () => {
    const dir = tempDir();
    writeTheme(dir, "half.json", { id: "half", name: "Half", appearance: "dark" });
    const read = readThemeDirectory(dir);
    expect(read.themes).toEqual([]);
    expect(read.problems[0]?.problem).toMatch(/tokens/);
  });

  it("refuses a file whose name disagrees with its id", () => {
    const dir = tempDir();
    writeTheme(dir, "wrong.json", theme("graphite", "dark"));
    const read = readThemeDirectory(dir);
    expect(read.themes).toEqual([]);
    expect(read.problems[0]?.problem).toMatch(/rename the file to graphite\.json/);
  });

  it("refuses an absurdly large file", () => {
    const dir = tempDir();
    writeTheme(dir, "huge.json", `{"pad":"${"x".repeat(70 * 1024)}"}`);
    const read = readThemeDirectory(dir);
    expect(read.themes).toEqual([]);
    expect(read.problems[0]?.problem).toMatch(/larger than/);
  });
});

describe("loadThemeCatalog", () => {
  it("merges the shipped catalog with the user's directory", () => {
    const builtInDir = tempDir();
    const userDir = tempDir();
    writeTheme(builtInDir, "dark.json", theme("dark", "dark", { name: "Graphite" }));
    writeTheme(builtInDir, "light.json", theme("light", "light", { name: "Paper" }));
    writeTheme(userDir, "sepia.json", theme("sepia", "light", { name: "Sepia" }));
    writeTheme(userDir, "dark.json", theme("dark", "dark", { name: "Mine" }));

    const catalog = loadThemeCatalog({ builtInDir, userDir });
    expect(catalog.default).toBe("dark");
    expect(catalog.themes.map((entry) => entry.id)).toEqual([
      "dark",
      "light",
      "sepia",
    ]);
    expect(catalog.themes.find((entry) => entry.id === "dark")).toMatchObject({
      name: "Mine",
      origin: "user",
    });
    expect(catalog.themes.find((entry) => entry.id === "sepia")?.origin).toBe("user");
    expect(catalog.userDirectory).toBe(userDir);
    expect(catalog.problems).toEqual([]);
  });

  it("collects the problems of both directories without failing", () => {
    const builtInDir = tempDir();
    const userDir = tempDir();
    writeTheme(builtInDir, "dark.json", theme("dark", "dark"));
    writeTheme(builtInDir, "bad.json", "[]");
    writeTheme(userDir, "worse.json", "{");
    const catalog = loadThemeCatalog({ builtInDir, userDir });
    expect(catalog.themes.map((entry) => entry.id)).toEqual(["dark"]);
    expect(catalog.problems.map((entry) => path.basename(entry.file))).toEqual([
      "bad.json",
      "worse.json",
    ]);
  });

  it("keeps the default pointing at a theme that exists", () => {
    const builtInDir = tempDir();
    const userDir = tempDir();
    writeTheme(builtInDir, "paper.json", theme("paper", "light"));
    const catalog = loadThemeCatalog({ builtInDir, userDir });
    expect(catalog.default).toBe("paper");
  });
});

describe("defaultThemeDir", () => {
  it("sits beside the database, like backups/", () => {
    expect(defaultThemeDir("/paseo/plugins/luck-planner/luck-planner.db")).toBe(
      "/paseo/plugins/luck-planner/themes",
    );
  });
});

// ── The URL helpers ──────────────────────────────────────────────────────

describe("withAppearance", () => {
  it("appends the hint to an already-built dashboard URL", () => {
    const url = withAppearance(
      "http://127.0.0.1:8899/?token=t&project=%2Fp",
      "light",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("appearance")).toBe("light");
    // The existing parameters survive untouched.
    expect(parsed.searchParams.get("token")).toBe("t");
    expect(parsed.searchParams.get("project")).toBe("/p");
  });

  it("leaves the URL alone without a usable hint", () => {
    const url = "http://127.0.0.1:8899/?token=t";
    expect(withAppearance(url, null)).toBe(url);
    expect(withAppearance(url, "sepia")).toBe(url);
  });
});

describe("themesUrl", () => {
  it("carries the token, like every other API call", () => {
    const parsed = new URL(themesUrl("lp_abc"), "http://127.0.0.1:8899");
    expect(parsed.pathname).toBe("/api/themes");
    expect(parsed.searchParams.get("token")).toBe("lp_abc");
  });
});
