import { useMemo } from "react";

/**
 * Host typography for the native panel (PLAN.md stage E2).
 *
 * The Paseo host passes only colours to plugins (`PluginTheme` has no
 * typography fields), while the app-wide Appearance settings (Settings →
 * Appearance → Fonts) live in web `localStorage` under `@paseo:app-settings`
 * — plugin components render inside the same page, so the panel reads the
 * configured interface size synchronously. Falls back to 1 (default size)
 * when storage is unavailable (native runtime). Read once per hook via
 * `useMemo`; the value changes rarely.
 *
 * Minimal on purpose — memory-flash carries a full font-family resolver, but
 * the panel only needs the numeric scale. The tsconfig has no DOM lib, so
 * `Storage` is described structurally instead of imported.
 */

type MinimalStorage = { getItem(key: string): string | null };

const SETTINGS_KEY = "@paseo:app-settings";
const BASE_SIZE = 14;

/** Interface text scale: configured size / 14. 1 = default. */
export function useHostFontScale(): number {
  return useMemo(() => {
    try {
      const scope = globalThis as unknown as { localStorage?: MinimalStorage };
      const storage = scope.localStorage;
      if (!storage) return 1;
      const raw = storage.getItem(SETTINGS_KEY);
      if (!raw) return 1;
      const parsed: unknown = JSON.parse(raw);
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
        if (Number.isFinite(size) && size > 0) return size / BASE_SIZE;
      }
      return 1;
    } catch {
      return 1;
    }
  }, []);
}

/** Scales a base font size by the host setting. */
export function scaledFont(base: number, scale: number): number {
  return Math.round(base * scale);
}
