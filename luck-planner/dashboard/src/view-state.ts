/**
 * Where the dashboard remembers which diagram the user wants (stage I4).
 *
 * The 2D/3D switch is a *preference*, not a mode of the session: a user who
 * lives in the 3D scene should find it there after a reload, and a link
 * shared with "3d" in it should open in 3D. Two carriers, in this order:
 *
 * 1. the **URL** (`?view=3d`) — explicit, shareable, survives a copy/paste
 *    of the tab's address;
 * 2. **localStorage** — the tab's own memory, used when the URL says
 *    nothing.
 *
 * Pure over injected inputs, like `theme.ts`: the search string and the
 * storage object are parameters, so the rule is testable without a DOM
 * (`tests/dashboard-view-state.test.ts`).
 *
 * WebGL is *not* consulted here: whether the 3D view can actually be shown
 * is the probe's and `planViewSwitch`'s business (stage I1) — this module
 * only remembers the wish.
 */
import type { DashboardView } from "./webgl";

/** URL parameter carrying the view. */
export const VIEW_PARAM = "view";

/** localStorage key of the last view the user chose. */
export const VIEW_STORAGE_KEY = "luck-planner:view";

/**
 * The slice of `Storage` this module touches — injectable so the rule can be
 * exercised without a browser (and so a storage-disabled tab is a normal
 * case, not an exception).
 */
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The two views, in the order the toolbar shows them. */
const VIEWS: readonly DashboardView[] = ["2d", "3d"];

/** Whether a string names a view at all. */
function isView(value: string | null | undefined): value is DashboardView {
  return value !== null && value !== undefined && (VIEWS as readonly string[]).includes(value);
}

/**
 * The view named by a query string (`?view=3d`), or `null` when it names
 * none. An unknown value is ignored, never guessed: a hand-edited URL must
 * not open a view that does not exist.
 */
export function readViewParam(search: string): DashboardView | null {
  const params = new URLSearchParams(search);
  const value = params.get(VIEW_PARAM);
  return isView(value) ? value : null;
}

/**
 * The view the user last chose, or `null` when nothing was stored (or the
 * storage is unavailable — private mode, disabled cookies).
 */
export function readStoredView(storage: ViewStorage | null): DashboardView | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(VIEW_STORAGE_KEY);
    return isView(value) ? value : null;
  } catch {
    // A storage that throws is a storage that does not exist.
    return null;
  }
}

/** Remembers the view for the next visit. Failures are ignored. */
export function writeStoredView(storage: ViewStorage | null, view: DashboardView): void {
  if (storage === null) return;
  try {
    storage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Nothing to do: the URL still carries the view.
  }
}

/**
 * The view a tab should open in: the URL wins, the stored choice is the
 * fallback, and 2D is the default (the diagram that always works).
 */
export function initialView(search: string, storage: ViewStorage | null): DashboardView {
  return readViewParam(search) ?? readStoredView(storage) ?? "2d";
}

/**
 * The search string a tab should carry for `view`: the parameter is always
 * written, so a copied link opens in the same diagram the sender saw.
 * Every other parameter (the token, the project) is preserved.
 */
export function viewSearch(search: string, view: DashboardView): string {
  const params = new URLSearchParams(search);
  params.set(VIEW_PARAM, view);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}
