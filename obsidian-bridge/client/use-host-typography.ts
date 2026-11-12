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
 * the client, falling back to defaults when storage is unavailable. Read once
 * per mount: the app applies settings without reloading, so a screen picks the
 * change up the next time it opens.
 */
export function useHostTypography(): HostTypography {
  return useMemo(() => readHostTypography() ?? defaultHostTypography(), []);
}

export { interfaceFontFamily, monoFontFamily, scaledFont };
export type { HostTypography };
