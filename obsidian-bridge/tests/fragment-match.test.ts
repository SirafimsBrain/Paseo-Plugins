import { describe, expect, it } from "vitest";
import {
  countOccurrences,
  findFragment,
  lineNumberAt,
  normalizeWhitespace,
  suggestFragments,
} from "../server/fragment-match";

/**
 * 0.10.11: `obsidian_edit` gets a whitespace-insensitive mode and shows the
 * closest text when a fragment does not match. Both keep the exactly-once rule.
 */

const NOTE = ["# Plan", "", "The queue drains in two passes.", "", "## Notes", "", "alpha beta gamma", ""].join(
  "\n",
);

describe("findFragment", () => {
  it("finds an exact unique fragment with its offsets", () => {
    const result = findFragment(NOTE, "alpha beta gamma");
    expect(result).toMatchObject({ status: "found", normalizedLineEndings: false, ignoreWhitespace: false });
    if (result.status === "found") {
      expect(NOTE.slice(result.start, result.end)).toBe("alpha beta gamma");
    }
  });

  it("retries a CRLF note with converted line breaks", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    expect(findFragment(crlf, "alpha beta gamma")).toMatchObject({
      status: "found",
      normalizedLineEndings: false,
    });
    const result = findFragment(crlf, "## Notes\n\nalpha beta gamma");
    expect(result).toMatchObject({ status: "found", normalizedLineEndings: true });
  });

  it("refuses an ambiguous fragment but says where it occurs", () => {
    const note = "one\ntwo\none\n";
    const result = findFragment(note, "one");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.occurrences).toBe(2);
      expect(result.suggestions.map((entry) => entry.line)).toEqual([1, 3]);
    }
  });

  it("suggests the closest text for a fragment that is not there", () => {
    const result = findFragment(NOTE, "The queue drains in three passes.");
    expect(result.status).toBe("not-found");
    if (result.status === "not-found") {
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions[0].line).toBe(3);
      expect(result.suggestions[0].text).toContain("two passes");
    }
  });

  it("matches a re-wrapped fragment only with ignoreWhitespace", () => {
    const reWrapped = "The queue drains\nin two   passes.";
    expect(findFragment(NOTE, reWrapped).status).toBe("not-found");
    const result = findFragment(NOTE, reWrapped, { ignoreWhitespace: true });
    expect(result).toMatchObject({ status: "found", ignoreWhitespace: true });
    if (result.status === "found") {
      expect(NOTE.slice(result.start, result.end)).toContain("drains");
    }
  });

  it("still refuses when the whitespace-insensitive fragment matches twice", () => {
    const spaced = "a   b\nlater\na\tb\n";
    expect(findFragment(spaced, "a b", { ignoreWhitespace: true })).toMatchObject({
      status: "ambiguous",
      occurrences: 2,
    });
  });
});

describe("helpers", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "z")).toBe(0);
  });

  it("maps normalized offsets back to the original text", () => {
    const { text, map } = normalizeWhitespace("a\n\n b");
    expect(text).toBe("a b");
    expect(map[0]).toBe(0);
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(4);
    expect(map[3]).toBe(5);
  });

  it("numbers lines from one", () => {
    expect(lineNumberAt("a\nb\nc", 0)).toBe(1);
    expect(lineNumberAt("a\nb\nc", 2)).toBe(2);
    expect(lineNumberAt("a\nb\nc", 4)).toBe(3);
  });

  it("returns suggestions best-first and bounded", () => {
    const suggestions = suggestFragments(NOTE, "queue passes", 2);
    expect(suggestions.length).toBeLessThanOrEqual(2);
    expect(suggestions[0].score).toBeGreaterThan(0);
    for (const entry of suggestions) expect(entry.line).toBeGreaterThan(0);
  });
});
