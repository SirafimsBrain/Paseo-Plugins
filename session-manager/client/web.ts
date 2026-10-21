import { Platform } from "react-native";
import {
  readHostTypographyFromLocalStorage,
  type HostTypography,
} from "../shared/host-fonts";

/**
 * The single home for DOM globals in this plugin's client code.
 *
 * Paseo runs plugin clients on iOS, Android and the browser through React
 * Native Web, and its spec keeps DOM globals (`window`, `document`,
 * `localStorage`, `navigator`, `location`) out of cross-platform components:
 * they belong in `client/web.ts`, declared only for what that module uses,
 * with every export gated on `Platform.OS === "web"` and a native no-op or
 * fallback otherwise. The spec's client audit flags a DOM-global hit in any
 * other `client/` module as a bug.
 *
 * `client/` is the only directory allowed to import this module; `shared/`
 * stays runtime-neutral (it takes the storage object as a parameter and
 * never reaches for a global itself).
 */

type MinimalStorage = { getItem(key: string): string | null };

/**
 * Reads the host appearance settings (Settings → Appearance → Fonts) out of
 * the page's `localStorage`, where the desktop app persists them.
 *
 * Returns `null` outside the browser — native runtimes and storage-blocked
 * contexts — so callers fall back to the defaults. Reads are cheap, but the
 * caller memoizes them: the app applies settings without reloading the page,
 * so a plugin panel picks the change up the next time it mounts.
 */
export function readHostTypography(): HostTypography | null {
  if (Platform.OS !== "web") return null;
  // `globalThis` plus a minimal structural type: the plugin tsconfig omits
  // the DOM library, so `Storage` would not resolve here.
  const scope = globalThis as unknown as { localStorage?: MinimalStorage };
  const storage = scope.localStorage;
  return readHostTypographyFromLocalStorage(storage);
}
