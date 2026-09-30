import { useMemo } from "react";
import {
  defaultHostTypography,
  interfaceFontFamily,
  monoFontFamily,
  readHostTypographyFromLocalStorage,
  scaledFont,
  type HostTypography,
} from "../shared/host-fonts";

/**
 * Resolves the host's appearance settings (Settings → Appearance → Fonts) on
 * the client. Plugin components render inside the app page, so the settings
 * JSON in `localStorage` is available synchronously — no RPC, no re-render
 * churn. Falls back to defaults when storage is unavailable (native runtime).
 *
 * The value is read once per hook via `useMemo`; the app applies settings
 * without reloading the page, so a plugin surface picks up changes the next
 * time it mounts (open/close a panel). Re-reading on every render would add
 * jank for a setting that changes rarely.
 */
export function useHostTypography(): HostTypography {
  return useMemo(() => {
    // `globalThis` + a minimal structural type: the plugin tsconfig has no
    // DOM lib, and `Storage` would not resolve there.
    type MinimalStorage = { getItem(key: string): string | null };
    const scope = globalThis as unknown as { localStorage?: MinimalStorage };
    const storage = typeof globalThis !== "undefined" ? scope.localStorage : undefined;
    return readHostTypographyFromLocalStorage(storage) ?? defaultHostTypography();
  }, []);
}

export { interfaceFontFamily, monoFontFamily, scaledFont };
export type { HostTypography };
