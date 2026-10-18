/**
 * Dashboard URL parameters (PLAN.md stage G1).
 *
 * The tab is opened with `?token=…&project=…` (stage F2), and the whole app
 * keys off those two values: without a token every `/api/*` call is 401, and
 * without a project key there is no tree to draw. Pure parsing, pinned here so
 * a future `view=3d` parameter cannot silently break an old tab.
 */
import { describe, expect, it } from "vitest";
import { parseDashboardParams } from "../dashboard/src/params";

describe("parseDashboardParams", () => {
  it("reads the token and the project key", () => {
    expect(parseDashboardParams("?token=lp_abc&project=%2Fhome%2Fme%2Fapp")).toEqual({
      token: "lp_abc",
      projectKey: "/home/me/app",
    });
  });

  it("accepts a search string without the leading question mark", () => {
    expect(parseDashboardParams("token=t&project=p")).toEqual({
      token: "t",
      projectKey: "p",
    });
  });

  it("yields empty strings when both are missing", () => {
    // The app renders the "open this from Paseo" hint instead of crashing.
    expect(parseDashboardParams("")).toEqual({ token: "", projectKey: "" });
    expect(parseDashboardParams("?other=1")).toEqual({ token: "", projectKey: "" });
  });

  it("ignores unknown parameters", () => {
    expect(parseDashboardParams("?view=3d&token=t&project=p&ref=x")).toEqual({
      token: "t",
      projectKey: "p",
    });
  });

  it("keeps a project path that contains slashes and spaces", () => {
    expect(parseDashboardParams("?token=t&project=/a%20b/c%2Fd")).toEqual({
      token: "t",
      projectKey: "/a b/c/d",
    });
  });
});
