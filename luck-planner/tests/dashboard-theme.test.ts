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
import { describe, expect, it } from "vitest";
import { LEAF_STATUSES, NODE_KINDS } from "../shared/tree";
import {
  KIND_COLORS,
  KIND_GLYPHS,
  KIND_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  paletteIsComplete,
} from "../dashboard/src/colors";
import {
  DARK_THEME,
  LIGHT_THEME,
  resolveTheme,
  tokensFor,
} from "../dashboard/src/theme";

describe("resolveTheme", () => {
  it("prefers the stored choice over the OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("falls back to the OS preference when nothing is stored", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });

  it("treats an unknown stored value as absent", () => {
    expect(resolveTheme("sepia", true)).toBe("dark");
    expect(resolveTheme("sepia", false)).toBe("light");
  });
});

describe("theme tokens", () => {
  it("returns the palette for each theme name", () => {
    expect(tokensFor("dark")).toBe(DARK_THEME);
    expect(tokensFor("light")).toBe(LIGHT_THEME);
  });

  it("defines every token in both palettes", () => {
    const keys = Object.keys(DARK_THEME).sort();
    expect(Object.keys(LIGHT_THEME).sort()).toEqual(keys);
    for (const tokens of [DARK_THEME, LIGHT_THEME]) {
      for (const [name, value] of Object.entries(tokens)) {
        expect(value, `${name} must be a hex/rgba colour`).toMatch(
          /^#|^rgba\(/,
        );
      }
    }
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
