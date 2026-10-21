import { useMemo } from "react";
import {
  defaultHostTypography,
  interfaceFontFamily,
  monoFontFamily,
  scaledFont,
  type HostTypography,
} from "../shared/host-fonts";
import { readHostTypography } from "./web";

/**
 * Resolves the host's appearance settings (Settings → Appearance → Fonts) on
 * the client. The page-storage read lives in `client/web.ts` — the only
 * module in `client/` allowed to touch a DOM global under Paseo's
 * cross-platform rules — and falls back to defaults when it is unavailable
 * (native runtime, storage blocked).
 *
 * The value is read once per hook via `useMemo`; the app applies settings
 * without reloading the page, so a plugin screen picks up changes the next
 * time it mounts (open/close a panel). Re-reading on every render would add
 * jank for a setting that changes rarely.
 */
export function useHostTypography(): HostTypography {
  return useMemo(() => readHostTypography() ?? defaultHostTypography(), []);
}

export { interfaceFontFamily, monoFontFamily, scaledFont };
export type { HostTypography };
