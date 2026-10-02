/**
 * Host appearance settings for plugin UIs.
 *
 * The Paseo host (0.8–0.9) passes ONLY colors to plugins — `PluginTheme` has
 * no typography fields — while the app-wide Appearance settings (Settings →
 * Appearance → Fonts: interface font, code font, interface size) exist since
 * 0.1.88 and are applied to the whole document, including plugin surfaces.
 * The observed mismatch (plugins render smaller than the configured size) is
 * a hard host limitation, so these helpers reconstruct the user's choices
 * from the settings store and turn them into a numeric scale for both
 * plugins.
 *
 * Two independent sources are used:
 *  1. Client-side: the app persists its settings to web `localStorage` under
 *     `@paseo:app-settings` (JSON). Plugin components run inside the same
 *     page, so the value can be read synchronously at render time.
 *  2. Server-side fallback (v2+ desktop): settings also live in the Chromium
 *     Local Storage leveldb of the Electron profile. Reading it requires a
 *     `level`-compatible binding, which is intentionally NOT bundled — the
 *     resolver simply reports failure and the client keeps its fallback value.
 *
 * Reference values extracted from the host bundle (dist app 0.9):
 *   FONT_SIZE = { sm: 12, base: 14, lg: 16, xl: 18, 2xl: 20, 3xl: 22, 4xl: 26 }
 *   scale     = uiBaseFontSize / FONT_SIZE.base
 *   DEFAULTS: uiFontFamily "", monoFontFamily "", uiBaseFontSize 14,
 *             contentFontSize 15, codeFontSize 12
 */

export const HOST_FONT_SIZE = {
  sm: 12,
  base: 14,
  lg: 16,
  xl: 18,
  "2xl": 20,
  "3xl": 22,
  "4xl": 26,
} as const;

/** localStorage key of the desktop app settings store (web build). */
export const PASEO_SETTINGS_KEY = "@paseo:app-settings";

/** Host-side fontSize presets that the scale factor is applied to. */
export type HostFontSizeToken = keyof typeof HOST_FONT_SIZE;

export interface HostTypography {
  /** Computed interface text scale: uiBaseFontSize / 14. 1 = default. */
  scale: number;
  /** Configured interface font family, "" = system default. */
  uiFontFamily: string;
  /** Configured code font family, "" = system default. */
  monoFontFamily: string;
  /** Raw configured interface size (px), 14 when unset. */
  uiBaseFontSize: number;
  /** Raw configured content size (px), 15 when unset. */
  contentFontSize: number;
  /** Raw configured code size (px), 12 when unset. */
  codeFontSize: number;
}

const DEFAULT_TYPOGRAPHY: HostTypography = {
  scale: 1,
  uiFontFamily: "",
  monoFontFamily: "",
  uiBaseFontSize: HOST_FONT_SIZE.base,
  contentFontSize: 15,
  codeFontSize: 12,
};

export function defaultHostTypography(): HostTypography {
  return { ...DEFAULT_TYPOGRAPHY };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // Mirrors the host's own sanitizer: strip angle brackets/braces and
  // line breaks before the value can reach a CSS font-family declaration.
  return value
    .replace(/[<>{}();]/g, "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  // Keep the exact ratio so scaled sizes track the host's own math; clamp to
  // a sane band against corrupt settings (host presets live in 11–26px).
  return Math.min(2, Math.max(0.5, value));
}

/**
 * Reads the app settings out of `localStorage`. Returns `null` when
 * unavailable (native, storage blocked) — callers fall back to defaults.
 */
export function readHostTypographyFromLocalStorage(
  storage: Pick<Storage, "getItem"> | undefined | null,
): HostTypography | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(PASEO_SETTINGS_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeHostTypography(parsed);
}

/**
 * Maps a parsed settings record onto `HostTypography`. Unknown shapes fall
 * back to the defaults, and any field may be overridden by the caller (used
 * by tests and by the server-side fallback).
 */
export function normalizeHostTypography(raw: unknown): HostTypography | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const legacyUiFontSize = toFiniteNumber(record["uiFontSize"]);
  const uiBase = toFiniteNumber(record["uiBaseFontSize"]);
  const uiBaseFontSize =
    uiBase ?? (legacyUiFontSize !== null ? Math.round((HOST_FONT_SIZE.base * legacyUiFontSize) / 16) : null);

  const uiBaseFontSizeValue = uiBaseFontSize ?? DEFAULT_TYPOGRAPHY.uiBaseFontSize;
  const contentFontSize = toFiniteNumber(record["contentFontSize"]) ?? DEFAULT_TYPOGRAPHY.contentFontSize;
  const codeFontSize = toFiniteNumber(record["codeFontSize"]) ?? DEFAULT_TYPOGRAPHY.codeFontSize;

  return {
    scale: clampScale(uiBaseFontSizeValue / HOST_FONT_SIZE.base),
    uiFontFamily: sanitizeFontFamily(record["uiFontFamily"]),
    monoFontFamily: sanitizeFontFamily(record["monoFontFamily"]),
    uiBaseFontSize: uiBaseFontSizeValue,
    contentFontSize,
    codeFontSize,
  };
}

/**
 * Applies the host typography to a raw fontSize number the way the host
 * applies its presets: multiplies by the user's scale and rounds to integer.
 * Use this for every hardcoded fontSize in plugin styles.
 */
export function scaledFont(base: number, typography: HostTypography): number {
  const value = base * typography.scale;
  return Math.max(1, Math.round(value));
}

/**
 * Resolves the font family to use for interface text. When the user has not
 * configured one, returns `null` — the plugin must NOT set a fontFamily in
 * that case so the host's `--paseo-ui-font` rule (applied to all elements in
 * `#root` / `#overlay-root`) stays in effect.
 */
export function interfaceFontFamily(typography: HostTypography): string | null {
  const family = typography.uiFontFamily;
  return family.length > 0 ? family : null;
}

/**
 * Resolves the font family for monospace text (templates, code). Falls back
 * to `null` so the host rule applies; plugin styles then pass their own
 * "monospace" fallback only when the user has no code font configured.
 */
export function monoFontFamily(typography: HostTypography): string | null {
  const family = typography.monoFontFamily;
  return family.length > 0 ? family : null;
}
