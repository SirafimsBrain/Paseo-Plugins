import { z } from "zod";

/**
 * Themes (PLAN.md stage L7, `__doc.md` §6).
 *
 * Stage G1 shipped two palettes hard-wired in `dashboard/src/theme.ts` and
 * called it done (ADR-1: the tab is a standalone app, so it cannot read
 * Paseo's tokens). That was honest for one install and wrong for a tool people
 * stare at all day: the palette is a taste, and a taste is not a compile-time
 * constant. A theme is therefore **data**: one JSON file per theme, a shipped
 * catalog directory plus a user directory beside the database, loaded by the
 * server and served to the tab over `/api/themes`.
 *
 * This module is the client/server-neutral half: the schemas a file must
 * satisfy, the merge of the two directories, and the two rules that decide
 * which theme is painted. It reads and writes nothing — `server/themes.ts`
 * owns the filesystem and `dashboard/src/theme.ts` owns the browser.
 *
 * The appearance split (`light`/`dark`) exists for one reason: the tab should
 * open in the scheme the person is already looking at. Paseo tells the plugin
 * its own colours (not an `appearance` flag), so the appearance is **derived**
 * from the luminance of the host's surface colour — a hint, never a promise.
 */

// ── The model ────────────────────────────────────────────────────────────

/** Which scheme a theme belongs to. */
export const appearanceSchema = z.enum(["light", "dark"]);
export type Appearance = z.infer<typeof appearanceSchema>;
export const APPEARANCES = appearanceSchema.options;

/**
 * The colours a theme controls — exactly the CSS custom properties the
 * stylesheet reads, so no theme can promise a token the dashboard does not
 * paint with. Anything that is *semantic* (kind shapes, status colours, the
 * growth ramp, bee statuses) stays in `dashboard/src/colors.ts`: those encode
 * meaning, and a theme that recoloured them would change what the diagram
 * says rather than how it looks.
 */
export const themeTokensSchema = z.object({
  /** Page and canvas background. */
  bg: z.string().min(1),
  /** Toolbar / details-panel / legend surface. */
  surface: z.string().min(1),
  border: z.string().min(1),
  text: z.string().min(1),
  textMuted: z.string().min(1),
  accent: z.string().min(1),
  /** Selection/hover wash over nodes and rows (an `rgba()` is normal). */
  selection: z.string().min(1),
});
export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export const THEME_TOKEN_KEYS = Object.keys(
  themeTokensSchema.shape,
) as readonly (keyof ThemeTokens)[];

/**
 * CSS custom property per token. One table: the applier, the stylesheet and
 * the tests cannot drift apart as long as this is the only naming.
 */
export const THEME_TOKEN_VARIABLES: Record<keyof ThemeTokens, string> = {
  bg: "--lp-bg",
  surface: "--lp-surface",
  border: "--lp-border",
  text: "--lp-text",
  textMuted: "--lp-text-muted",
  accent: "--lp-accent",
  selection: "--lp-selection",
};

/** The CSS custom properties of one theme, ready to apply to `:root`. */
export function themeCssVariables(
  tokens: ThemeTokens,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) {
    variables[THEME_TOKEN_VARIABLES[key]] = tokens[key];
  }
  return variables;
}

/**
 * A theme id: lowercase, digits and single hyphens — the value stored in the
 * tab, the file name on disk and the key the two directories merge on. Strict
 * on purpose: an id is an identifier, not a title.
 */
export const themeIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "theme ids are lowercase letters, digits and hyphens")
  .max(40);

/** One theme file on disk (`themes/dark.json` and friends). */
export const themeDefinitionSchema = z.object({
  id: themeIdSchema,
  /** Human label in the picker; the id stays stable across renames. */
  name: z.string().min(1).max(60),
  appearance: appearanceSchema,
  tokens: themeTokensSchema,
});
export type ThemeDefinition = z.infer<typeof themeDefinitionSchema>;

/** Where a catalog entry came from — shown in the picker and the docs. */
export const themeOriginSchema = z.enum(["built-in", "user"]);
export type ThemeOrigin = z.infer<typeof themeOriginSchema>;

export const themeCatalogEntrySchema = themeDefinitionSchema.extend({
  origin: themeOriginSchema,
});
export type ThemeCatalogEntry = z.infer<typeof themeCatalogEntrySchema>;

/** One file that could not be used, and why (never fatal). */
export const themeProblemSchema = z.object({
  file: z.string().min(1),
  problem: z.string().min(1),
});
export type ThemeProblem = z.infer<typeof themeProblemSchema>;

/**
 * `GET /api/themes`: everything the tab needs to paint itself.
 *
 * `default` is the theme used when neither a stored choice nor an appearance
 * match survives (the shipped `dark`), and `userDirectory` is spelled out so
 * the docs can name one real path instead of a rule.
 */
export const themeCatalogSchema = z.object({
  default: z.string(),
  themes: z.array(themeCatalogEntrySchema),
  problems: z.array(themeProblemSchema),
  userDirectory: z.string(),
});
export type ThemeCatalog = z.infer<typeof themeCatalogSchema>;

/** The id of the theme painted when nothing else applies. */
export const DEFAULT_THEME_ID = "dark";

// ── The catalog ──────────────────────────────────────────────────────────

/** Order of the entries: built-ins first, then user themes, each by id. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merges the shipped catalog with the user's directory.
 *
 * A user file with a shipped id **replaces** the shipped one — the honest way
 * to tweak a palette you almost like — and the entry keeps the user's name and
 * origin, so the picker never claims a custom palette is the shipped one. The
 * order is built-ins then user-only entries, each sorted by id: a directory
 * read cannot leak into the picker's order.
 */
export function mergeThemes(
  builtIn: readonly ThemeDefinition[],
  user: readonly ThemeDefinition[],
): ThemeCatalogEntry[] {
  const byThemeId = new Map<string, ThemeCatalogEntry>();
  for (const theme of [...builtIn].sort(byId)) {
    byThemeId.set(theme.id, { ...theme, origin: "built-in" });
  }
  for (const theme of [...user].sort(byId)) {
    byThemeId.set(theme.id, { ...theme, origin: "user" });
  }
  return [...byThemeId.values()].sort(byId);
}

/**
 * The id `default` points at: the shipped dark theme when the catalog has it,
 * else the first theme of any appearance, else `""` (an empty catalog — the
 * tab then keeps the stylesheet's own floor palette).
 */
export function defaultThemeId(
  themes: readonly { readonly id: string }[],
): string {
  return (
    themes.find((theme) => theme.id === DEFAULT_THEME_ID)?.id ??
    themes[0]?.id ??
    ""
  );
}

// ── Which theme is painted ───────────────────────────────────────────────

/**
 * The appearance the tab should use: the host's hint (Paseo's own colours),
 * else the operating system's `prefers-color-scheme`, else dark — the palette
 * the stylesheet itself falls back to.
 */
export function resolveAppearance(
  host: Appearance | null,
  prefersDark: boolean,
): Appearance {
  if (host !== null) return host;
  return prefersDark ? "dark" : "light";
}

/**
 * The theme id to paint.
 *
 * A stored choice wins while it still exists — a user theme deleted from disk
 * must not leave the tab on a palette that is gone, and falling back to the
 * appearance match is exactly what "the file vanished" should look like. With
 * nothing stored (or nothing usable), the first theme of the resolved
 * appearance wins, then the catalog default. `""` means "no catalog": the tab
 * keeps the stylesheet's floor palette rather than inventing one.
 */
export function resolveThemeId(
  stored: string | null,
  catalog: {
    readonly default: string;
    readonly themes: readonly {
      readonly id: string;
      readonly appearance: Appearance;
    }[];
  },
  appearance: Appearance,
): string {
  if (stored !== null && stored.length > 0) {
    const chosen = catalog.themes.find((theme) => theme.id === stored);
    if (chosen !== undefined) return chosen.id;
  }
  const matching = catalog.themes.find(
    (theme) => theme.appearance === appearance,
  );
  if (matching !== undefined) return matching.id;
  // `default` is answered only while it names a theme that exists: painting an
  // id nobody ships would leave the tab on the stylesheet's floor palette and
  // call it a choice.
  if (catalog.themes.some((theme) => theme.id === catalog.default)) {
    return catalog.default;
  }
  return catalog.themes[0]?.id ?? "";
}

// ── The host's happiness hint ────────────────────────────────────────────

/**
 * WCAG relative luminance of a CSS colour, or `null` when the string is not a
 * hex colour this module understands. Alpha is ignored: a translucent surface
 * is still painted over its own background (ADR-1's palettes are opaque).
 */
export function relativeLuminance(color: string): number | null {
  const hex = color.trim().replace(/^#/, "");
  const expanded =
    hex.length === 3 || hex.length === 4
      ? hex
          .slice(0, 3)
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expanded)) return null;
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  );
}

/** Below this luminance a surface reads as dark; standard mid-grey is 0.216. */
export const APPEARANCE_LUMINANCE_THRESHOLD = 0.5;

/** `light`/`dark` of one colour, or `null` when it cannot be read. */
export function appearanceOfColor(color: string): Appearance | null {
  const luminance = relativeLuminance(color);
  if (luminance === null) return null;
  return luminance >= APPEARANCE_LUMINANCE_THRESHOLD ? "light" : "dark";
}

/**
 * The appearance hint Paseo's own theme carries.
 *
 * The host hands the plugin colours, not a mode: `surface0` is the app's
 * background token, so its luminance *is* the answer. Unreadable colours yield
 * `null`, which means "no hint" and lets the OS preference decide — a host
 * that changes its palette shape must not silently pin the tab to dark.
 */
export function appearanceFromHostColors(colors: {
  readonly surface0?: string;
  readonly foreground?: string;
}): Appearance | null {
  if (typeof colors.surface0 === "string" && colors.surface0.length > 0) {
    return appearanceOfColor(colors.surface0);
  }
  if (typeof colors.foreground === "string" && colors.foreground.length > 0) {
    // No surface: a dark *foreground* implies a light surface.
    const foreground = appearanceOfColor(colors.foreground);
    return foreground === null ? null : foreground === "dark" ? "light" : "dark";
  }
  return null;
}
