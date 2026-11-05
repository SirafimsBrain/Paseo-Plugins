/**
 * URL parameters of the dashboard tab (PLAN.md stage G1, extended in L7).
 *
 * The tab is opened with `dashboardUrl(origin, token, projectKey)` (stage F2,
 * `shared/api.ts`): the token travels in the query string because a browser
 * navigation cannot attach an `Authorization` header, and the project key rides
 * along so a tab opened from another workspace shows that workspace.
 *
 * Stage L7 adds `?appearance=light|dark`: the plugin derives it from Paseo's
 * own colours before opening the tab (`withAppearance`), so a tab opened from a
 * light host starts light instead of guessing from the OS preference. An
 * unknown value is `null` — "no hint" — because a host that starts sending
 * something else must not silently pin the tab to a scheme.
 *
 * Pure over its input (a search string, not `location`) so the parsing rule is
 * pinned by `tests/dashboard-params.test.ts` without a DOM — the same
 * pure-module-plus-thin-wiring split `client/slash.ts` and
 * `client/open-dashboard.ts` use on the native side.
 */
import {
  DASHBOARD_APPEARANCE_PARAM,
  DASHBOARD_PROJECT_PARAM,
  DASHBOARD_TOKEN_PARAM,
} from "../../shared/api";
import { appearanceSchema, type Appearance } from "../../shared/themes";

/** What the app needs to talk to the plugin's HTTP API. */
export interface DashboardParams {
  /** Per-installation access token; empty when the URL carried none. */
  readonly token: string;
  /** Canonical project key (ADR-2); empty when the URL carried none. */
  readonly projectKey: string;
  /** Appearance hint of the host that opened the tab; `null` when absent. */
  readonly appearance: Appearance | null;
}

/**
 * Parses `?token=…&project=…&appearance=…` out of a search string. Unknown
 * parameters are ignored on purpose (a future `view=3d` must not break an old
 * tab), and an absent parameter yields `""`/`null` rather than throwing — the
 * caller renders a "open this page from Paseo" hint instead of a blank crash.
 */
export function parseDashboardParams(search: string): DashboardParams {
  const params = new URLSearchParams(search);
  const appearance = appearanceSchema.safeParse(
    params.get(DASHBOARD_APPEARANCE_PARAM) ?? "",
  );
  return {
    token: params.get(DASHBOARD_TOKEN_PARAM) ?? "",
    projectKey: params.get(DASHBOARD_PROJECT_PARAM) ?? "",
    appearance: appearance.success ? appearance.data : null,
  };
}
