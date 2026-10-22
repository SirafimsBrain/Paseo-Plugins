/**
 * Host interface size (PLAN.md stage E2, `__doc.md` §6).
 *
 * Paseo hands plugins only colours (`PluginTheme` has no typography fields),
 * while the app-wide Appearance settings (Settings → Appearance → Fonts) live
 * in the page's `localStorage` under `@paseo:app-settings` — plugin components
 * render inside the same page, so a surface reads the configured interface
 * size synchronously.
 *
 * This module is the **pure** half: it takes the raw settings document and
 * answers the scale. The DOM read lives in `client/web.ts` (the only module
 * allowed to touch a DOM global) and the React hook that joins them lives in
 * `client/use-host-typography.ts`. Keeping the parsing separate is what makes
 * it testable — vitest cannot load the Flow-typed `react-native` package, so a
 * test can exercise this file but never `web.ts`.
 */

/** The host's base interface size, in points. */
export const BASE_FONT_SIZE = 14;

/**
 * Interface text scale: configured size / 14. 1 = default.
 *
 * The host's document has carried the setting under several names, so the
 * lookup accepts the three known spellings in the order the newest one is
 * expected to win. A missing, malformed or non-positive value means "the user
 * did not change it" — the default scale of 1.
 */
export function parseHostFontScale(raw: string | null): number {
  if (raw === null || raw.length === 0) return 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 1;
  }
  if (parsed === null || typeof parsed !== "object") return 1;
  const record = parsed as Record<string, unknown>;
  const candidates = [
    record.uiBaseFontSize,
    (record.appearance as Record<string, unknown> | undefined)?.uiBaseFontSize,
    (record.fonts as Record<string, unknown> | undefined)?.uiBaseFontSize,
  ];
  for (const candidate of candidates) {
    const size =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim().length > 0
          ? Number(candidate)
          : NaN;
    if (Number.isFinite(size) && size > 0) return size / BASE_FONT_SIZE;
  }
  return 1;
}

/** Scales a base font size by the host setting. */
export function scaledFont(base: number, scale: number): number {
  return Math.round(base * scale);
}
