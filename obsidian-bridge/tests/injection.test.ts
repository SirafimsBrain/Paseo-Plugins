import { describe, expect, it } from "vitest";
import {
  INJECTION_METADATA_KEY,
  injectionMarker,
  readInjectionMarker,
  withInjectionMarker,
} from "../server/injection";
import { citationBlock, wikilinkFor } from "../shared/citations";

/**
 * 0.9.11: the per-agent marker the hooks record, and the exact link text the
 * composer control inserts.
 */

describe("injection marker", () => {
  it("round-trips through metadata and leaves other plugins' keys alone", () => {
    const metadata = withInjectionMarker(
      { "other-plugin": { mode: "whatever" }, flag: true },
      injectionMarker("tool", "provider has no MCP support"),
    );
    expect(metadata["other-plugin"]).toEqual({ mode: "whatever" });
    expect(metadata.flag).toBe(true);
    expect(readInjectionMarker(metadata)).toMatchObject({
      mode: "tool",
      reason: "provider has no MCP support",
    });
  });

  it("replaces a previous marker instead of duplicating it", () => {
    const first = withInjectionMarker({}, injectionMarker("skipped", "gate"));
    const second = withInjectionMarker(first, injectionMarker("mcp", "injected"));
    expect(Object.keys(second)).toEqual([INJECTION_METADATA_KEY]);
    expect(readInjectionMarker(second)?.mode).toBe("mcp");
  });

  it("claims nothing for a missing, foreign or malformed value", () => {
    expect(readInjectionMarker(null)).toBeNull();
    expect(readInjectionMarker({})).toBeNull();
    expect(readInjectionMarker({ [INJECTION_METADATA_KEY]: "mcp" })).toBeNull();
    expect(readInjectionMarker({ [INJECTION_METADATA_KEY]: { mode: "advanced" } })).toBeNull();
    expect(
      readInjectionMarker({ [INJECTION_METADATA_KEY]: { mode: "config" } }),
    ).toEqual({ mode: "config", reason: "", at: "" });
  });

  it("drops the key when asked, keeping the rest", () => {
    const metadata = withInjectionMarker({ keep: 1 }, null);
    expect(metadata).toEqual({ keep: 1 });
  });
});

describe("citation text", () => {
  it("drops the .md suffix and carries the heading and title", () => {
    expect(wikilinkFor("Projects/orion/Plan.md", "Queue", "The queue")).toBe(
      "[[Projects/orion/Plan#Queue|The queue]]",
    );
  });

  it("omits an empty heading", () => {
    expect(wikilinkFor("Inbox/source.md", "", "Source")).toBe("[[Inbox/source|Source]]");
  });

  it("falls back to the target when the title is blank", () => {
    expect(wikilinkFor("out/guide.md", "", "  ")).toBe("[[out/guide|out/guide]]");
  });

  it("formats one line per hit, and nothing for no hits", () => {
    expect(citationBlock([])).toBe("");
    expect(
      citationBlock([
        { path: "a/one.md", heading: "Intro", title: "One" },
        { path: "b/two.md", heading: "", title: "Two" },
      ]),
    ).toBe("\n- [[a/one#Intro|One]]\n- [[b/two|Two]]\n");
  });
});
