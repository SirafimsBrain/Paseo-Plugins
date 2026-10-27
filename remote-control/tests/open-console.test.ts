import { describe, expect, it, vi } from "vitest";
import { isOpenableConsoleUrl, openConsoleUrl } from "../client/open-console";

const URL = "http://127.0.0.1:8899/?token=x";

describe("open-console", () => {
  it("accepts http", () => {
    expect(isOpenableConsoleUrl(URL)).toBe(true);
  });
  it("rejects non-http", () => {
    expect(isOpenableConsoleUrl("javascript:alert(1)")).toBe(false);
  });
  it("prefers browser", async () => {
    const browserCalls: any[] = [];
    const externalCalls: string[] = [];
    const openers = {
      openBrowser: (input: any) => browserCalls.push(input),
      openExternal: async (u: string) => { externalCalls.push(u); },
    };
    const outcome = await openConsoleUrl(URL, openers, "ws-1");
    expect(outcome.via).toBe("browser");
    expect(browserCalls).toHaveLength(1);
    expect(externalCalls).toHaveLength(0);
    // The console needs the workspace it belongs to: terminals created there
    // become tabs of that workspace.
    expect(browserCalls[0].workspaceId).toBe("ws-1");
    expect(browserCalls[0].url).toContain("workspaceId=ws-1");
    expect(browserCalls[0].url).toContain("token=x");
  });
  it("falls back when browser throws", async () => {
    const externalCalls: string[] = [];
    const openers = {
      openBrowser: () => { throw new Error("no"); },
      openExternal: async (u: string) => { externalCalls.push(u); },
    };
    const outcome = await openConsoleUrl(URL, openers, "ws-1");
    expect(outcome.via).toBe("external");
    expect(externalCalls).toEqual([URL]);
  });
});
