/**
 * The details panel's width (stage I4 follow-up).
 *
 * The panel used to be a fixed 300 px column, which cut the node names and
 * the history rows mid-word. It is 1.5× that by default and **resizable**:
 * the user drags its left edge, and the width is remembered for the next
 * visit — the same localStorage pattern the theme uses.
 *
 * Pure over an injected storage, so the rule is testable without a DOM (the
 * theme's `resolveTheme` precedent).
 */

/** The width the panel opens with: the old 300 px column, times 1.5. */
export const DEFAULT_DETAILS_WIDTH = 450;

/** The narrowest the panel may become. */
export const MIN_DETAILS_WIDTH = 280;

/** The widest the panel may become — beyond that the canvas suffers. */
export const MAX_DETAILS_WIDTH = 720;

/** Where the chosen width is remembered. */
export const DETAILS_WIDTH_KEY = "luck-planner:details-width";

/** The slice of `Storage` this module needs. */
export interface DetailsWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Clamps a dragged width into the allowed window. A non-finite width (a
 * pointer event without coordinates) falls back to the default.
 */
export function clampDetailsWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DETAILS_WIDTH;
  return Math.min(MAX_DETAILS_WIDTH, Math.max(MIN_DETAILS_WIDTH, Math.round(width)));
}

/**
 * The stored width, or the default when it is absent, unreadable or out of
 * bounds. A storage that throws (private mode) is a storage that does not
 * exist.
 */
export function readStoredDetailsWidth(
  storage: DetailsWidthStorage | null,
): number {
  if (storage === null) return DEFAULT_DETAILS_WIDTH;
  try {
    const stored = Number.parseInt(storage.getItem(DETAILS_WIDTH_KEY) ?? "", 10);
    if (
      Number.isInteger(stored) &&
      stored >= MIN_DETAILS_WIDTH &&
      stored <= MAX_DETAILS_WIDTH
    ) {
      return stored;
    }
  } catch {
    // No storage: the default is fine.
  }
  return DEFAULT_DETAILS_WIDTH;
}

/** Remembers the width for the next visit. */
export function storeDetailsWidth(
  storage: DetailsWidthStorage | null,
  width: number,
): void {
  if (storage === null) return;
  try {
    storage.setItem(DETAILS_WIDTH_KEY, String(clampDetailsWidth(width)));
  } catch {
    // No storage: the width simply does not survive a reload.
  }
}

/** Forgets the width — the panel returns to its default. */
export function forgetDetailsWidth(storage: DetailsWidthStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(DETAILS_WIDTH_KEY);
  } catch {
    // No storage — nothing to forget.
  }
}
