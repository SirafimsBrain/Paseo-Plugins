import { Platform } from "react-native";

/**
 * The single home for DOM globals in this plugin's client code.
 *
 * Paseo runs plugin clients on iOS, Android and in the browser through React
 * Native Web, and its spec keeps DOM globals (`window`, `document`,
 * `localStorage`, `navigator`, `location`) out of cross-platform components:
 * they belong in `client/web.ts`, declared only for what that module uses,
 * with every export gated on `Platform.OS === "web"` and a native no-op or
 * fallback otherwise. The spec's client audit flags a DOM-global hit in any
 * other `client/` module as a bug — `tests/client-dom-globals.test.ts` runs
 * the same audit here, so a regression fails the suite instead of the review.
 *
 * `client/` is the only directory allowed to import this module; `shared/`
 * stays runtime-neutral and the pure parsing lives in
 * `client/host-font-scale.ts`, which takes the raw settings document as a
 * parameter and never reaches for a global itself.
 */

type MinimalStorage = { getItem(key: string): string | null };

/**
 * Key the host persists its app settings under. The interface size lives
 * there (Settings → Appearance → Fonts) and the page is the same one the
 * plugin components render into, so a web client can read the configured size
 * synchronously.
 */
export const HOST_APP_SETTINGS_KEY = "@paseo:app-settings";

/**
 * Reads the raw host app-settings document out of the page's `localStorage`.
 *
 * Returns `null` outside the browser — native runtimes and storage-blocked
 * contexts — so callers fall back to the defaults. Reads are cheap, but the
 * caller memoizes them: the app applies settings without reloading the page,
 * so a plugin surface picks the change up the next time it mounts.
 */
export function readHostAppSettings(): string | null {
  if (Platform.OS !== "web") return null;
  // `globalThis` plus a minimal structural type: the plugin tsconfig omits
  // the DOM library, so `Storage` would not resolve here.
  const scope = globalThis as unknown as { localStorage?: MinimalStorage };
  const storage = scope.localStorage;
  if (!storage) return null;
  try {
    return storage.getItem(HOST_APP_SETTINGS_KEY);
  } catch {
    // Storage can throw when the page is in a blocked or private mode.
    return null;
  }
}
