import { describe, expect, it, vi } from "vitest";
import {
  isOpenableDashboardUrl,
  openDashboardUrl,
  type DashboardOpeners,
} from "../client/open-dashboard";

/**
 * Stage F2 acceptance (`PLAN.md`): "on desktop the dashboard opens in a Paseo
 * tab; without a workspace or on non-Electron — the external browser".
 *
 * The rule lives in a pure module with injected openers (no React, no SDK), so
 * every branch of that sentence is pinned here: the in-app browser wins on
 * Electron, it needs a workspace id (given, else discovered, else the external
 * opener), and a host whose `openBrowser` throws must not lose the URL.
 */

const URL_UNDER_TEST = "http://127.0.0.1:8899/?token=lp_abc&project=%2Fp";

/** Records which opener ran, and with what. */
function openers(overrides: Partial<DashboardOpeners> = {}): {
  openers: DashboardOpeners;
  browserCalls: Array<{ url: string; workspaceId: string }>;
  externalCalls: string[];
} {
  const browserCalls: Array<{ url: string; workspaceId: string }> = [];
  const externalCalls: string[] = [];
  const result: DashboardOpeners = {
    openBrowser: (input) => {
      browserCalls.push(input);
    },
    openExternal: async (url) => {
      externalCalls.push(url);
    },
    ...overrides,
  };
  return { openers: result, browserCalls, externalCalls };
}

describe("isOpenableDashboardUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(isOpenableDashboardUrl("http://127.0.0.1:8899/?token=x")).toBe(true);
    expect(isOpenableDashboardUrl("https://example.test/dash")).toBe(true);
  });

  it("rejects anything an opener must not navigate to", () => {
    expect(isOpenableDashboardUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableDashboardUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableDashboardUrl("/relative/path")).toBe(false);
    expect(isOpenableDashboardUrl("")).toBe(false);
  });
});

describe("openDashboardUrl", () => {
  it("prefers Paseo's in-app browser with the workspace the caller names", async () => {
    const recorder = openers();
    const outcome = await openDashboardUrl(
      URL_UNDER_TEST,
      recorder.openers,
      "workspace-1",
    );

    expect(outcome).toEqual({ via: "browser", workspaceId: "workspace-1" });
    expect(recorder.browserCalls).toEqual([
      { url: URL_UNDER_TEST, workspaceId: "workspace-1" },
    ]);
    expect(recorder.externalCalls).toEqual([]);
  });

  it("discovers a workspace when the caller has none (global command / screen)", async () => {
    const listWorkspaceIds = vi.fn(async () => ["workspace-7", "workspace-8"]);
    const recorder = openers({ listWorkspaceIds });

    const outcome = await openDashboardUrl(URL_UNDER_TEST, recorder.openers);

    expect(outcome).toEqual({ via: "browser", workspaceId: "workspace-7" });
    expect(recorder.browserCalls[0].workspaceId).toBe("workspace-7");
    expect(recorder.externalCalls).toEqual([]);
  });

  it("falls back to the external opener on a host without navigation", async () => {
    // Not Electron: the host exposes no `openBrowser` at all.
    const recorder = openers({ openBrowser: undefined });

    const outcome = await openDashboardUrl(URL_UNDER_TEST, recorder.openers, "workspace-1");

    expect(outcome).toEqual({ via: "external", workspaceId: null });
    expect(recorder.browserCalls).toEqual([]);
    expect(recorder.externalCalls).toEqual([URL_UNDER_TEST]);
  });

  it("falls back to the external opener when no workspace can be resolved", async () => {
    const recorder = openers({ listWorkspaceIds: async () => [] });

    const outcome = await openDashboardUrl(URL_UNDER_TEST, recorder.openers);

    expect(outcome.via).toBe("external");
    expect(recorder.externalCalls).toEqual([URL_UNDER_TEST]);
  });

  it("survives a workspace list that fails", async () => {
    const recorder = openers({
      listWorkspaceIds: async () => {
        throw new Error("daemon unreachable");
      },
    });

    const outcome = await openDashboardUrl(URL_UNDER_TEST, recorder.openers);

    expect(outcome.via).toBe("external");
    expect(recorder.externalCalls).toEqual([URL_UNDER_TEST]);
  });

  it("falls back when the in-app browser throws instead of losing the URL", async () => {
    const recorder = openers({
      openBrowser: () => {
        throw new Error("no such workspace on this host");
      },
    });

    const outcome = await openDashboardUrl(URL_UNDER_TEST, recorder.openers, "workspace-1");

    expect(outcome.via).toBe("external");
    expect(recorder.externalCalls).toEqual([URL_UNDER_TEST]);
  });

  it("refuses to hand a non-http URL to any opener", async () => {
    const recorder = openers();

    await expect(
      openDashboardUrl("javascript:alert(1)", recorder.openers, "workspace-1"),
    ).rejects.toThrow(/non-http/);
    expect(recorder.browserCalls).toEqual([]);
    expect(recorder.externalCalls).toEqual([]);
  });

  it("treats an empty workspace id as 'no workspace'", async () => {
    const recorder = openers();

    const outcome = await openDashboardUrl(URL_UNDER_TEST, recorder.openers, "");

    expect(outcome.via).toBe("external");
  });
});
