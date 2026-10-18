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
import { BEE_STATUSES } from "../shared/links";
import { GOAL_STATUSES } from "../shared/goals";
import {
  BEE_STATUS_COLORS,
  BEE_STATUS_LABELS,
  GOAL_STATUS_COLORS,
  GOAL_STATUS_LABELS,
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
