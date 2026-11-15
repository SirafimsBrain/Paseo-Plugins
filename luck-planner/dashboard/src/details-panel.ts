/**
 * The details drawer of the diagram views (0.54.0).
 *
 * The panel started as a fixed 300 px right column, then a resizable one
 * (450 px by default). With the planning strip above the diagram (0.51.2) it
 * broke the layout outright: the strip and the panel became grid items of the
 * two-column body, so the diagram was pushed into the narrow column and the
 * details took the main area (the reported 2D view).
 *
 * It is a **drawer under the diagram** now: full width, closed by default, and
 * opened by its own header button. Closed is the right default — the diagram
 * is the reason the tab is open, and the details are the answer to a click.
 * The open state is remembered for the **browsing session** (`sessionStorage`):
 * a new tab starts closed again, which is what "remember it for the active
 * session" means. The drawer's height is the user's drag and survives a reload
 * (`localStorage`, the theme's pattern).
 *
 * Pure over injected storages, so every rule is testable without a DOM.
 */

/** The height the drawer opens with. */
export const DEFAULT_DETAILS_HEIGHT = 280;

/** The shortest the drawer may be dragged — enough for the header and a row. */
export const MIN_DETAILS_HEIGHT = 140;

/** The tallest the drawer may be dragged — the diagram keeps the room above. */
export const MAX_DETAILS_HEIGHT = 640;

/** Where the dragged height is remembered (across visits). */
export const DETAILS_HEIGHT_KEY = "luck-planner:details-height";

/**
 * Where the open/closed state is remembered. `sessionStorage`, deliberately:
 * the requirement is "for the active session", and a collapsed drawer that
 * stays collapsed in a tab opened tomorrow would hide the answer to the click
 * that opened it.
 */
export const DETAILS_OPEN_KEY = "luck-planner:details-open";

/** Closed by default: the diagram is the surface, the details are on demand. */
export const DEFAULT_DETAILS_OPEN = false;

/** The slice of `Storage` this module needs (localStorage or sessionStorage). */
export interface DetailsPanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Clamps a dragged height into the allowed window. A non-finite height (a
 * pointer event without coordinates) falls back to the default.
 */
export function clampDetailsHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_DETAILS_HEIGHT;
  return Math.min(
    MAX_DETAILS_HEIGHT,
    Math.max(MIN_DETAILS_HEIGHT, Math.round(height)),
  );
}

/** The stored height, or the default when absent, unreadable or out of bounds. */
export function readStoredDetailsHeight(
  storage: DetailsPanelStorage | null,
): number {
  if (storage === null) return DEFAULT_DETAILS_HEIGHT;
  try {
    const stored = Number.parseInt(storage.getItem(DETAILS_HEIGHT_KEY) ?? "", 10);
    if (
      Number.isInteger(stored) &&
      stored >= MIN_DETAILS_HEIGHT &&
      stored <= MAX_DETAILS_HEIGHT
    ) {
      return stored;
    }
  } catch {
    // No storage: the default is fine.
  }
  return DEFAULT_DETAILS_HEIGHT;
}

/** Remembers the height for the next visit. */
export function storeDetailsHeight(
  storage: DetailsPanelStorage | null,
  height: number,
): void {
  if (storage === null) return;
  try {
    storage.setItem(DETAILS_HEIGHT_KEY, String(clampDetailsHeight(height)));
  } catch {
    // No storage: the height simply does not survive a reload.
  }
}

/** Forgets the height — the drawer returns to its default. */
export function forgetDetailsHeight(storage: DetailsPanelStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(DETAILS_HEIGHT_KEY);
  } catch {
    // No storage — nothing to forget.
  }
}

/**
 * The stored open/closed state, or {@link DEFAULT_DETAILS_OPEN}.
 *
 * Only the exact strings `"true"` / `"false"` count; anything else (an old
 * value, a hand-edited one, a storage that throws) falls back to the default
 * rather than guessing.
 */
export function readStoredDetailsOpen(
  storage: DetailsPanelStorage | null,
): boolean {
  if (storage === null) return DEFAULT_DETAILS_OPEN;
  try {
    const stored = storage.getItem(DETAILS_OPEN_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // No storage: the default is fine.
  }
  return DEFAULT_DETAILS_OPEN;
}

/** Remembers the open/closed state for the rest of the session. */
export function storeDetailsOpen(
  storage: DetailsPanelStorage | null,
  open: boolean,
): void {
  if (storage === null) return;
  try {
    storage.setItem(DETAILS_OPEN_KEY, open ? "true" : "false");
  } catch {
    // No storage: the drawer opens closed again in a new tab.
  }
}
