import { describe, expect, it } from "vitest";

import { memoryFlashClientSettings } from "../shared/settings";

/**
 * Settings schema regression tests.
 *
 * The Paseo daemon fills in schema defaults when no settings file exists
 * (`schema.parseAsync({})`) and the client then re-validates the already
 * expanded values (`safeParse(values)`). Every default therefore has to
 * satisfy the same schema, otherwise a freshly installed plugin reports
 * its settings store as `invalid` and the settings screen renders the
 * raw Zod issue list instead of the form.
 */

const schema = memoryFlashClientSettings.schema;

describe("memory-flash-client settings schema", () => {
  it("accepts an empty store and expands every default", () => {
    expect(schema.parse({})).toEqual({
      injectIntoAgents: true,
      clientId: "",
      hostname: "",
      mcpServerName: "memory-flash",
      sendIdentityHeaders: true,
    });
  });

  it("round-trips its own output (daemon defaults -> client re-validation)", () => {
    const fromDaemon = schema.parse({});
    expect(schema.safeParse(fromDaemon).success).toBe(true);
    expect(schema.parse(fromDaemon)).toEqual(fromDaemon);
  });

  it("round-trips a saved, fully expanded store", () => {
    const stored = schema.parse({
      injectIntoAgents: false,
      clientId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      hostname: "studio-laptop",
      mcpServerName: "memory",
      sendIdentityHeaders: false,
    });
    expect(schema.parse(stored)).toEqual(stored);
  });

  it("keeps an empty clientId and hostname legal (identity fallbacks)", () => {
    // Empty values are not an error: index.server.ts resolves them to a
    // generated UUID and to os.hostname() respectively.
    const parsed = schema.parse({ clientId: "   ", hostname: "  " });
    expect(parsed.clientId).toBe("");
    expect(parsed.hostname).toBe("");
  });

  it("requires a UUID when a clientId is pinned", () => {
    const result = schema.safeParse({ clientId: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["clientId"]);
    }
  });

  it("trims a pinned clientId and accepts it", () => {
    const parsed = schema.parse({ clientId: "  3F2504E0-4F89-11D3-9A0C-0305E82C3301  " });
    expect(parsed.clientId).toBe("3F2504E0-4F89-11D3-9A0C-0305E82C3301");
  });

  it("still enforces the upper bounds", () => {
    expect(schema.safeParse({ hostname: "h".repeat(81) }).success).toBe(false);
    expect(schema.safeParse({ mcpServerName: "n".repeat(61) }).success).toBe(false);
  });
});