import { describe, expect, it } from "vitest";
import { parseSessionArgs } from "../client/session-slash";

/**
 * 0.7.0: the `/sessions` grammar. The command only turns text into the intent the
 * Command Center items already write, so these cases are the whole contract.
 */

describe("parseSessionArgs", () => {
  it("opens the panel unchanged without arguments", () => {
    expect(parseSessionArgs("")).toEqual({ intent: null, openSettings: false });
    expect(parseSessionArgs("   ")).toEqual({ intent: null, openSettings: false });
  });

  it("defaults `old` to 30 days and selects the match", () => {
    expect(parseSessionArgs("old")).toEqual({
      intent: { ageDays: 30, selectShown: true },
      openSettings: false,
    });
  });

  it("accepts an explicit day count and a bare number", () => {
    expect(parseSessionArgs("old 7").intent).toEqual({ ageDays: 7, selectShown: true });
    expect(parseSessionArgs("older 90").intent).toEqual({ ageDays: 90, selectShown: true });
    expect(parseSessionArgs("14").intent).toEqual({ ageDays: 14, selectShown: true });
  });

  it("understands archived and combines it with an age", () => {
    expect(parseSessionArgs("archived")).toEqual({
      intent: { archivedOnly: true, selectShown: true },
      openSettings: false,
    });
    expect(parseSessionArgs("archived old 30").intent).toEqual({
      archivedOnly: true,
      ageDays: 30,
      selectShown: true,
    });
  });

  it("routes settings to the settings screen", () => {
    expect(parseSessionArgs("settings")).toEqual({ intent: null, openSettings: true });
    expect(parseSessionArgs("OLD 7 settings")).toEqual({ intent: null, openSettings: true });
  });

  it("opens the panel rather than guessing on unknown words", () => {
    expect(parseSessionArgs("everything")).toEqual({ intent: null, openSettings: false });
  });

  it("treats a zero day count as the default rather than a filter that matches all", () => {
    expect(parseSessionArgs("old 0").intent).toEqual({ ageDays: 30, selectShown: true });
  });
});
