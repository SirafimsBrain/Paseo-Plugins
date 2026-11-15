import { describe, expect, it } from "vitest";
import { obsidianBridgeSettings } from "../shared/settings";

/**
 * The host refuses to open the settings screen when the stored document's
 * version is older than the definition's and no `migrate` hook exists
 * ("Settings version N requires a migration"). Version 2 documents are what an
 * install from 0.2.x/0.4.x still carries, so the hook must turn one into a
 * document the current schema accepts, keeping the user's values.
 */

/** A stored document as written by the version 2 schema. */
const version2 = {
  vaultPath: ".obsidian/Main/Paseo/",
  inboxDir: "Inbox",
  outDir: "Documentation",
  rawDir: "raw",
  indexingEnabled: true,
  includeFolders: "",
  excludeGlobs: ".obsidian/**, .trash/**, .git/**, .smart-env/**",
  ftsStemming: false,
  reconcileMinutes: 10,
  maxResults: 10,
  searchBudgetChars: 8000,
  snippetChars: 600,
  readOnly: false,
  maxWriteChars: 200000,
  injectIntoAgents: true,
};

function migrate(values: unknown, fromVersion: number): unknown {
  const hook = obsidianBridgeSettings.migrate;
  expect(hook).toBeTypeOf("function");
  return hook?.(values, fromVersion);
}

describe("settings migration", () => {
  it("keeps a version 2 document's values and fills the newer keys", () => {
    const parsed = obsidianBridgeSettings.schema.parse(migrate(version2, 2));
    expect(parsed.vaultPath).toBe(".obsidian/Main/Paseo/");
    expect(parsed.injectIntoAgents).toBe(true);
    expect(parsed.maxWriteChars).toBe(200000);
    // Added in later versions; a document that never had them gets defaults.
    expect(parsed.semanticSearch).toBe(true);
    expect(parsed.embeddingModel).toBe("Xenova/multilingual-e5-small");
    expect(parsed.obsidianApiEnabled).toBe(false);
    expect(parsed.registerOpencodeMcp).toBe(true);
    expect(parsed.registerClineMcp).toBe(true);
    expect(parsed.installAgentSkill).toBe(true);
  });

  it("drops keys the current schema no longer knows", () => {
    const parsed = obsidianBridgeSettings.schema.parse(
      migrate({ ...version2, removedKey: "stale", vaultPath: "Notes" }, 3),
    );
    expect(parsed).not.toHaveProperty("removedKey");
    expect(parsed.vaultPath).toBe("Notes");
  });

  it("falls back to schema defaults when the stored values are not an object", () => {
    for (const broken of [null, "text", 42, ["a"]]) {
      const parsed = obsidianBridgeSettings.schema.parse(migrate(broken, 2));
      expect(parsed.vaultPath).toBe("");
      expect(parsed.inboxDir).toBe("Inbox");
    }
  });
});
