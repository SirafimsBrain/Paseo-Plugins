import { useMemo } from "react";
import { parseHostFontScale } from "./host-font-scale";
import { readHostAppSettings } from "./web";

/**
 * Host typography for the native surfaces (PLAN.md stage E2).
 *
 * The page-storage read lives in `client/web.ts` — the only module in
 * `client/` allowed to touch a DOM global under Paseo's cross-platform rules —
 * and the pure parsing lives in `client/host-font-scale.ts`. This hook is the
 * join: it reads once per mount and falls back to the default scale when the
 * storage is unavailable (native runtime, storage blocked).
 *
 * The value is read once per hook via `useMemo`; the app applies settings
 * without reloading the page, so a plugin surface picks up the change the next
 * time it mounts (open or close a panel). Re-reading on every render would add
 * jank for a setting that changes rarely.
 */
export function useHostFontScale(): number {
  return useMemo(() => parseHostFontScale(readHostAppSettings()), []);
}
