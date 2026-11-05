/**
 * Dashboard URL parameters (PLAN.md stage G1, extended in L7).
 *
 * The tab is opened with `?token=…&project=…` (stage F2), and the whole app
 * keys off those two values: without a token every `/api/*` call is 401, and
 * without a project key there is no tree to draw. Stage L7 adds `?appearance=`,
 * the hint the plugin derives from Paseo's own colours so the tab opens in the
 * scheme the person is already looking at. Pure parsing, pinned here so a
 * future parameter cannot silently break an old tab.
 */
import { describe, expect, it } from "vitest";
import { parseDashboardParams } from "../dashboard/src/params";

describe("parseDashboardParams", () => {
  it("reads the token and the project key", () => {
    expect(parseDashboardParams("?token=lp_abc&project=%2Fhome%2Fme%2Fapp")).toEqual({
      token: "lp_abc",
      projectKey: "/home/me/app",
      appearance: null,
    });
  });

  it("accepts a search string without the leading question mark", () => {
    expect(parseDashboardParams("token=t&project=p")).toEqual({
      token: "t",
      projectKey: "p",
      appearance: null,
    });
  });

  it("yields empty strings when both are missing", () => {
    // The app renders the "open this from Paseo" hint instead of crashing.
    expect(parseDashboardParams("")).toEqual({
      token: "",
      projectKey: "",
      appearance: null,
    });
    expect(parseDashboardParams("?other=1")).toEqual({
      token: "",
      projectKey: "",
      appearance: null,
    });
  });

  it("ignores unknown parameters", () => {
    expect(parseDashboardParams("?view=3d&token=t&project=p&ref=x")).toEqual({
      token: "t",
      projectKey: "p",
      appearance: null,
    });
  });

  it("keeps a project path that contains slashes and spaces", () => {
    expect(parseDashboardParams("?token=t&project=/a%20b/c%2Fd")).toEqual({
      token: "t",
      projectKey: "/a b/c/d",
      appearance: null,
    });
  });

  // Stage L7: the host's appearance hint.
  it("reads the appearance hint the plugin appended", () => {
    expect(
      parseDashboardParams("?token=t&project=p&appearance=light").appearance,
    ).toBe("light");
    expect(
      parseDashboardParams("?token=t&project=p&appearance=dark").appearance,
    ).toBe("dark");
  });

  it("treats an unknown appearance as no hint", () => {
    // A host that starts sending something else must not pin the tab.
    expect(
      parseDashboardParams("?token=t&project=p&appearance=sepia").appearance,
    ).toBeNull();
    expect(
      parseDashboardParams("?token=t&project=p&appearance=").appearance,
    ).toBeNull();
  });
});
