import { describe, expect, it } from "vitest";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import {
  CLEANUP_DAY_OPTIONS,
  DEFAULT_SETTINGS,
  cleanupDaysOf,
  sessionManagerSettings,
  settingsSchema,
} from "../shared/settings";

describe("settings schema", () => {
  it("parses an empty document into the defaults", () => {
    // Paseo parses the stored document ({} on a fresh install) with this schema,
    // so every field needs a default to avoid an "invalid" settings state.
    expect(settingsSchema.parse({})).toEqual({
      cleanupDays: 30,
      sortOldestFirst: true,
      exportBeforeDelete: false,
    });
    expect(DEFAULT_SETTINGS).toEqual(settingsSchema.parse({}));
  });

  it("rejects a cleanup age the panel cannot render", () => {
    expect(settingsSchema.safeParse({ cleanupDays: 45 }).success).toBe(false);
  });

  it("round-trips stored values", () => {
    const values = { cleanupDays: 90, sortOldestFirst: false, exportBeforeDelete: true };
    expect(settingsSchema.parse(values)).toEqual(values);
  });

  it("declares host scope and a stable id", () => {
    expect(sessionManagerSettings.id).toBe("session-manager");
    expect(sessionManagerSettings.scope).toBe("host");
    expect(sessionManagerSettings.version).toBe(1);
  });
});

describe("cleanupDaysOf", () => {
  it("maps the settings option values onto day counts", () => {
    expect(cleanupDaysOf("0")).toBe(0);
    expect(cleanupDaysOf("30")).toBe(30);
    expect(cleanupDaysOf("90")).toBe(90);
    // Any unexpected value keeps the reminder useful instead of disabling it.
    expect(cleanupDaysOf("whatever")).toBe(30);
  });

  it("keeps the option values in sync with the schema", () => {
    for (const option of CLEANUP_DAY_OPTIONS) {
      expect(settingsSchema.safeParse({ cleanupDays: cleanupDaysOf(option.value) }).success).toBe(
        true,
      );
    }
  });
});

describe("defineSettings validation", () => {
  it("rejects an id that the host would not accept", () => {
    expect(() =>
      defineSettings({ id: "Agent sessions", scope: "host", version: 1, schema: z.object({}) }),
    ).toThrow(/Invalid settings ID/);
  });
});
