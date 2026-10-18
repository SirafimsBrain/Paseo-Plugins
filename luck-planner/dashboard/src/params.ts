/**
 * URL parameters of the dashboard tab (PLAN.md stage G1).
 *
 * The tab is opened with `dashboardUrl(origin, token, projectKey)` (stage F2,
 * `shared/api.ts`): the token travels in the query string because a browser
 * navigation cannot attach an `Authorization` header, and the project key rides
 * along so a tab opened from another workspace shows that workspace.
 *
 * Pure over its input (a search string, not `location`) so the parsing rule is
 * pinned by `tests/dashboard-params.test.ts` without a DOM — the same
 * pure-module-plus-thin-wiring split `client/slash.ts` and
 * `client/open-dashboard.ts` use on the native side.
 */
import {
  DASHBOARD_PROJECT_PARAM,
  DASHBOARD_TOKEN_PARAM,
} from "../../shared/api";

/** What the app needs to talk to the plugin's HTTP API. */
export interface DashboardParams {
  /** Per-installation access token; empty when the URL carried none. */
  readonly token: string;
  /** Canonical project key (ADR-2); empty when the URL carried none. */
  readonly projectKey: string;
}

/**
 * Parses `?token=…&project=…` out of a search string. Unknown parameters are
 * ignored on purpose (a future `view=3d` must not break an old tab), and an
 * absent parameter yields `""` rather than throwing — the caller renders a
 * "open this page from Paseo" hint instead of a blank crash.
 */
export function parseDashboardParams(search: string): DashboardParams {
  const params = new URLSearchParams(search);
  return {
    token: params.get(DASHBOARD_TOKEN_PARAM) ?? "",
    projectKey: params.get(DASHBOARD_PROJECT_PARAM) ?? "",
  };
}
