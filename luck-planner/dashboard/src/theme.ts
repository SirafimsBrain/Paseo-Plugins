/**
 * Theme selection in the dashboard tab (PLAN.md stage G1, rewritten in L7).
 *
 * Stage G1 hard-wired two palettes here and applied them from the app; L7 moved
 * the palettes **out of the code** into `themes/*.json` (shipped) and into the
 * user's `themes/` directory, served by `GET /api/themes`. What is left here is
 * the browser-side half: the storage key, the guarded read/write of the user's
 * choice, and the one function that turns a theme into CSS custom properties.
 *
 * Everything else — which appearance applies, which theme id wins, how the
 * catalog merges — lives in `shared/themes.ts`, because the server needs the
 * same rules and a tab that decided differently from the server would be a bug
 * waiting for a big project.
 *
 * No DOM here: the app owns `document.documentElement`; this module returns the
 * record it sets, so the rule stays testable in Node.
 */
import {
  resolveThemeId,
  themeCssVariables,
  type Appearance,
  type ThemeTokens,
} from "../../shared/themes";

/** Storage key of the user's explicit choice (absent = match Paseo/OS). */
export const THEME_STORAGE_KEY = "luck-planner:theme";

/**
 * Stored value meaning "no choice": follow the appearance hint (Paseo's own
 * colours) and, without one, the operating system. Kept as a sentinel instead
 * of deleting the key so the picker has a value to render.
 */
export const THEME_FOLLOW = "";

/** The CSS custom properties of a theme, ready for `applyThemeVariables`. */
export function themeVariables(tokens: ThemeTokens): Record<string, string> {
  return themeCssVariables(tokens);
}

/**
 * The storage the app hands in — `view-state.ts`'s `ViewStorage` shape, so the
 * tab passes the very object it already uses for the view choice and this
 * module needs no DOM (it is compiled by the plugin's Node build too).
 */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The stored choice, or `null` when unavailable (private mode, no storage). */
export function readStoredTheme(storage: ThemeStorage | null): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(THEME_STORAGE_KEY);
  } catch {
    // A storage that throws is a storage that does not exist.
    return null;
  }
}

/**
 * Remembers the choice (`THEME_FOLLOW` clears the follow-the-app hint).
 *
 * A storage that refuses the write (private browsing, a full quota) is not an
 * error the user can act on: the choice still applies to this tab, it just
 * does not survive a reload.
 */
export function writeStoredTheme(
  storage: ThemeStorage | null,
  themeId: string,
): void {
  if (storage === null) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    // Ignored on purpose: see above.
  }
}

/**
 * The theme id to paint, given the stored choice and the resolved appearance —
 * a thin re-export so the app has one import for "what do I paint".
 */
export function initialThemeId(
  stored: string | null,
  catalog: { default: string; themes: ReadonlyArray<{ id: string; appearance: Appearance }> },
  appearance: Appearance,
): string {
  return resolveThemeId(stored, catalog, appearance);
}
