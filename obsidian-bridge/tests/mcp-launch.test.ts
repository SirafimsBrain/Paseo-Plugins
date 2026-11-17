import { describe, expect, it } from "vitest";
import { nodeBinaryNames } from "../server/mcp-launch";

/**
 * 0.10.11 port audit: the injected command must be able to find Node on every
 * platform. On Windows the installed binary is `node.exe`, which the previous
 * lookup never probed.
 */

describe("nodeBinaryNames", () => {
  it("looks for node.exe first on Windows", () => {
    expect(nodeBinaryNames("win32")).toEqual(["node.exe", "node"]);
  });

  it("uses plain node on Linux and macOS", () => {
    expect(nodeBinaryNames("linux")).toEqual(["node"]);
    expect(nodeBinaryNames("darwin")).toEqual(["node"]);
  });
});
