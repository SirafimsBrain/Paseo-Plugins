// Copied verbatim from memory-flash/shared/host-fonts.ts.
//
// Host appearance settings for plugin UIs: the Paseo host passes only
// colors to plugins, while the app-wide Appearance settings (interface
// font, code font, interface size) live in the app settings store. These
// helpers reconstruct the user's choices from `localStorage` (client side)
// and turn them into a numeric scale for plugin text.

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
  return value
    .replace(/[<>{}();]/g, "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
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

/** Maps a parsed settings record onto `HostTypography`. */
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

/** Multiplies a raw fontSize by the user's scale and rounds it. */
export function scaledFont(base: number, typography: HostTypography): number {
  const value = base * typography.scale;
  return Math.max(1, Math.round(value));
}

/**
 * Font family for interface text, or `null` when the user configured none —
 * the plugin must not set a family then, so the host rule stays in effect.
 */
export function interfaceFontFamily(typography: HostTypography): string | null {
  const family = typography.uiFontFamily;
  return family.length > 0 ? family : null;
}

/** Font family for monospace text, or `null` when none is configured. */
export function monoFontFamily(typography: HostTypography): string | null {
  const family = typography.monoFontFamily;
  return family.length > 0 ? family : null;
}
