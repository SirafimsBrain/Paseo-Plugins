/**
 * The dashboard's own theme (PLAN.md stage G1, ADR-1).
 *
 * The dashboard is a standalone web app served over loopback: it must not read
 * Paseo's theme tokens (they are not even reachable from a browser tab), so it
 * ships its own small palette in CSS custom properties, with a light and a
 * dark variant keyed off `prefers-color-scheme`. Colors are chosen for a
 * technical diagram: dark canvas, muted surfaces, saturated accents reserved
 * for state (status bars, bee edges, bug badges).
 *
 * Pure data + pure functions: `tests/dashboard-theme.test.ts` pins the palettes
 * and the preference rule without a DOM; the app applies them in
 * `dashboard/src/main.tsx`.
 */

/** Which of the two palettes is active. */
export type ThemeName = "dark" | "light";

/**
 * CSS custom-property names the app defines on `:root` and reads in
 * `dashboard/src/styles.css`. Kept as data so a theme switch is a
 * re-application of one record, not a second stylesheet.
 */
export interface ThemeTokens {
  /** Page and canvas background. */
  readonly bg: string;
  /** Toolbar / details-panel / legend surface. */
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  /** Selection/hover wash over nodes and rows. */
  readonly selection: string;
}

/** Dark palette — the default: dashboards are read on a second screen. */
export const DARK_THEME: ThemeTokens = {
  bg: "#0f1115",
  surface: "#171a21",
  border: "#262b36",
  text: "#e6e9ef",
  textMuted: "#8b93a3",
  accent: "#5b9dff",
  selection: "rgba(91, 157, 255, 0.16)",
};

/** Light palette for daytime use; same roles, higher contrast borders. */
export const LIGHT_THEME: ThemeTokens = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  border: "#d7dbe2",
  text: "#1b1f27",
  textMuted: "#5c6470",
  accent: "#1f6feb",
  selection: "rgba(31, 111, 235, 0.12)",
};

/** The palette for a theme name. */
export function tokensFor(theme: ThemeName): ThemeTokens {
  return theme === "light" ? LIGHT_THEME : DARK_THEME;
}

/**
 * Resolves the startup theme: an explicit user choice (stored by the app)
 * wins over the OS preference, which wins over the dark default.
 */
export function resolveTheme(
  stored: string | null,
  prefersDark: boolean,
): ThemeName {
  if (stored === "dark" || stored === "light") return stored;
  return prefersDark ? "dark" : "light";
}

/** Storage key of the user's explicit choice (absent = follow the OS). */
export const THEME_STORAGE_KEY = "luck-planner:theme";
