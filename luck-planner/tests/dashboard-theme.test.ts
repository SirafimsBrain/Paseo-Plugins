/**
 * Dashboard theme and colour palette (PLAN.md stage G1).
 *
 * The dashboard ships its own dark/light theme (ADR-1: the tab cannot read
 * Paseo's tokens) and one semantic colour module that both the legend renders
 * now and the G3 nodes will paint with. These tests pin the preference rule
 * (stored choice > OS preference > dark) and — the failure that would
 * otherwise only be spotted by eye — that every `shared/tree.ts` kind and
 * status has a colour, a label and a glyph.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEAF_STATUSES, NODE_KINDS } from "../shared/tree";
import { BEE_STATUSES } from "../shared/links";
import { GOAL_STATUSES } from "../shared/goals";
import { GROWTH_STATUSES, summarizeGrowth } from "../shared/growth";
import type { Growth } from "../shared/growth";
import {
  BEE_STATUS_COLORS,
  BEE_STATUS_LABELS,
  GOAL_STATUS_COLORS,
  GOAL_STATUS_LABELS,
  GROWTH_STATUS_COLORS,
  GROWTH_STATUS_LABELS,
  HEAT_RAMP,
  heatColor,
  KIND_COLORS,
  KIND_GLYPHS,
  KIND_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  STATUS_PROGRESS,
  paletteIsComplete,
  withAlpha,
} from "../dashboard/src/colors";
import {
  THEME_FOLLOW,
  THEME_STORAGE_KEY,
  readStoredTheme,
  themeVariables,
  writeStoredTheme,
} from "../dashboard/src/theme";
import {
  DEFAULT_THEME_ID,
  resolveAppearance,
  resolveThemeId,
  THEME_TOKEN_KEYS,
  THEME_TOKEN_VARIABLES,
  themeCatalogSchema,
  themeDefinitionSchema,
  type ThemeCatalog,
} from "../shared/themes";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The shipped palettes are data now (L7), so the tests read the real files. */
function shippedCatalog(): ThemeCatalog {
  const dir = join(__dirname, "..", "themes");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const themes = files.map((name) => {
    const parsed = themeDefinitionSchema.parse(
      JSON.parse(readFileSync(join(dir, name), "utf8")),
    );
    expect(`${parsed.id}.json`, "the file name is the theme id").toBe(name);
    return { ...parsed, origin: "built-in" as const };
  });
  return themeCatalogSchema.parse({
    default: DEFAULT_THEME_ID,
    themes,
    problems: [],
    userDirectory: "/tmp/luck-planner-test-themes",
  });
}

describe("theme catalog (L7)", () => {
  const catalog = shippedCatalog();

  it("ships a dark and a light palette, and the default is shipped", () => {
    expect(catalog.themes.map((theme) => theme.appearance).sort()).toEqual([
      "dark",
      "light",
    ]);
    expect(catalog.themes.some((theme) => theme.id === catalog.default)).toBe(true);
  });

  it("defines every token in every shipped palette", () => {
    for (const theme of catalog.themes) {
      expect(Object.keys(theme.tokens).sort()).toEqual(
        [...THEME_TOKEN_KEYS].sort(),
      );
      for (const [name, value] of Object.entries(theme.tokens)) {
        expect(value, `${theme.id}.${name} must be a colour`).toMatch(/^#|^rgba\(/);
      }
    }
  });

  it("maps every token onto the CSS property the stylesheet reads", () => {
    const variables = themeVariables(catalog.themes[0]!.tokens);
    expect(Object.keys(variables).sort()).toEqual(
      Object.values(THEME_TOKEN_VARIABLES).sort(),
    );
    expect(variables["--lp-bg"]).toBe(catalog.themes[0]!.tokens.bg);
  });
});

describe("resolveAppearance", () => {
  it("prefers the host hint over the OS preference", () => {
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });

  it("follows the OS when the host gave no hint", () => {
    expect(resolveAppearance(null, true)).toBe("dark");
    expect(resolveAppearance(null, false)).toBe("light");
  });
});

describe("resolveThemeId", () => {
  const catalog = shippedCatalog();

  it("honours a stored id that still exists", () => {
    expect(resolveThemeId("light", catalog, "dark")).toBe("light");
  });

  it("falls back to the appearance when nothing is stored", () => {
    expect(resolveThemeId(null, catalog, "dark")).toBe("dark");
    expect(resolveThemeId(THEME_FOLLOW, catalog, "light")).toBe("light");
  });

  it("treats a stored id whose file vanished as absent", () => {
    expect(resolveThemeId("sepia", catalog, "light")).toBe("light");
  });

  it("answers an empty id for an empty catalog (no invented palette)", () => {
    expect(
      resolveThemeId("dark", { default: "", themes: [] }, "dark"),
    ).toBe("");
  });
});

describe("theme storage", () => {
  function memoryStorage(): {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  } {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    };
  }

  it("round-trips the choice under one key", () => {
    const storage = memoryStorage();
    expect(readStoredTheme(storage)).toBeNull();
    writeStoredTheme(storage, "light");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredTheme(storage)).toBe("light");
  });

  it("treats a missing or throwing storage as no choice", () => {
    expect(readStoredTheme(null)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredTheme(throwing)).toBeNull();
    expect(() => writeStoredTheme(throwing, "dark")).not.toThrow();
  });
});

describe("colour palette", () => {
  it("covers every node kind", () => {
    for (const kind of NODE_KINDS) {
      expect(KIND_COLORS[kind], `KIND_COLORS.${kind}`).toBeTruthy();
      expect(KIND_LABELS[kind], `KIND_LABELS.${kind}`).toBeTruthy();
      expect(KIND_GLYPHS[kind], `KIND_GLYPHS.${kind}`).toBeTruthy();
    }
  });

  it("covers every leaf status", () => {
    for (const status of LEAF_STATUSES) {
      expect(STATUS_COLORS[status], `STATUS_COLORS.${status}`).toBeTruthy();
      expect(STATUS_LABELS[status], `STATUS_LABELS.${status}`).toBeTruthy();
    }
  });

  it("reports completeness (the guard the legend relies on)", () => {
    expect(paletteIsComplete()).toBe(true);
  });
});

describe("G3 palettes", () => {
  it("covers every bee status with a colour and a text label", () => {
    for (const status of BEE_STATUSES) {
      expect(BEE_STATUS_COLORS[status], `BEE_STATUS_COLORS.${status}`).toBeTruthy();
      expect(BEE_STATUS_LABELS[status], `BEE_STATUS_LABELS.${status}`).toBeTruthy();
    }
  });

  it("covers every goal status with a frame colour and a text label", () => {
    for (const status of GOAL_STATUSES) {
      expect(GOAL_STATUS_COLORS[status], `GOAL_STATUS_COLORS.${status}`).toBeTruthy();
      expect(GOAL_STATUS_LABELS[status], `GOAL_STATUS_LABELS.${status}`).toBeTruthy();
    }
  });

  it("fills the status bar along plan → work → done, never past 100%", () => {
    for (const status of LEAF_STATUSES) {
      const value = STATUS_PROGRESS[status];
      expect(value, `STATUS_PROGRESS.${status}`).toBeGreaterThanOrEqual(0);
      expect(value, `STATUS_PROGRESS.${status}`).toBeLessThanOrEqual(1);
    }
    expect(STATUS_PROGRESS.draft).toBeLessThan(STATUS_PROGRESS.ready);
    expect(STATUS_PROGRESS.ready).toBeLessThan(STATUS_PROGRESS.claimed);
    expect(STATUS_PROGRESS.claimed).toBeLessThan(STATUS_PROGRESS.in_progress);
    expect(STATUS_PROGRESS.in_progress).toBeLessThan(STATUS_PROGRESS.done);
    expect(STATUS_PROGRESS.done).toBe(1);
    // Terminal-broken statuses read as "stopped", never as finished.
    expect(STATUS_PROGRESS.blocked).toBeLessThan(STATUS_PROGRESS.done);
    expect(STATUS_PROGRESS.cancelled).toBeLessThan(STATUS_PROGRESS.done);
    expect(STATUS_PROGRESS.superseded).toBeLessThan(STATUS_PROGRESS.done);
  });

  it("blends hexes into rgba within the valid channel range", () => {
    expect(withAlpha("#5b9dff", 0.5)).toBe("rgba(91, 157, 255, 0.5)");
    expect(withAlpha("#5b9dff", 2)).toBe("rgba(91, 157, 255, 1)");
    expect(withAlpha("#5b9dff", -1)).toBe("rgba(91, 157, 255, 0)");
  });
});

describe("G5 palettes", () => {
  it("covers every growth status with a colour and a text label", () => {
    for (const status of GROWTH_STATUSES) {
      expect(GROWTH_STATUS_COLORS[status], `GROWTH_STATUS_COLORS.${status}`).toBeTruthy();
      expect(GROWTH_STATUS_LABELS[status], `GROWTH_STATUS_LABELS.${status}`).toBeTruthy();
    }
    expect(paletteIsComplete()).toBe(true);
  });

  it("keeps the heat ramp sorted, spanning 0 → 1, every stop a hex", () => {
    expect(HEAT_RAMP.length).toBeGreaterThanOrEqual(3);
    expect(HEAT_RAMP[0].at).toBe(0);
    expect(HEAT_RAMP[HEAT_RAMP.length - 1].at).toBe(1);
    for (let i = 1; i < HEAT_RAMP.length; i += 1) {
      expect(HEAT_RAMP[i].at, `stop ${i} must follow stop ${i - 1}`).toBeGreaterThan(
        HEAT_RAMP[i - 1].at,
      );
    }
    for (const stop of HEAT_RAMP) {
      expect(stop.color, `stop at ${stop.at}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("returns the ramp colours at the stops and clamps the ends", () => {
    expect(heatColor(0)).toBe(HEAT_RAMP[0].color);
    expect(heatColor(1)).toBe(HEAT_RAMP[HEAT_RAMP.length - 1].color);
    expect(heatColor(0.5)).toBe(HEAT_RAMP[1].color);
    // Out-of-range and non-finite input still yields a valid end colour.
    expect(heatColor(-1)).toBe(HEAT_RAMP[0].color);
    expect(heatColor(2)).toBe(HEAT_RAMP[HEAT_RAMP.length - 1].color);
    expect(heatColor(Number.NaN)).toBe(HEAT_RAMP[0].color);
  });

  it("blends between stops and keeps 0 % vs 100 % distinguishable", () => {
    const quarter = heatColor(0.25);
    expect(quarter).toMatch(/^#[0-9a-f]{6}$/i);
    expect(quarter).not.toBe(heatColor(0));
    expect(quarter).not.toBe(heatColor(0.5));
    expect(heatColor(0)).not.toBe(heatColor(1));
  });

  it("uses the shared step arithmetic for the roll-up", () => {
    const record = (id: string, states: Growth["steps"][number]["state"][]): Growth => ({
      id,
      projectKey: "/tmp/luck-planner-g5",
      subjectType: "node",
      subjectId: "node-1",
      steps: states.map((state, index) => ({
        id: `s${index}`,
        title: `step ${index}`,
        state,
        facts: [],
        reason: "",
      })),
      status: "active",
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
      createdBy: null,
      updatedBy: null,
    });

    const summary = summarizeGrowth([
      record("g1", ["completed", "pending"]),
      record("g2", ["completed", "failed", "skipped"]),
    ]);
    expect(summary).toEqual({
      total: 5,
      completed: 2,
      failed: 1,
      ratio: 0.4,
      records: 2,
    });
    expect(summarizeGrowth([])).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      ratio: 0,
      records: 0,
    });
  });
});
