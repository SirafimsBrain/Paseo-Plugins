import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Conflict check and identity tests. `PASEO_HOME` points at a temp
 * directory; the check reads `$PASEO_HOME/config.json` and the
 * `$PASEO_HOME/plugins` directory.
 */

let tempHome: string;
const previousHome = process.env.PASEO_HOME;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mfc-conflict-"));
  process.env.PASEO_HOME = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  fs.writeFileSync(path.join(tempHome, "config.json"), JSON.stringify(value), "utf-8");
}

function makePluginDir(id: string): void {
  fs.mkdirSync(path.join(tempHome, "plugins", id), { recursive: true });
}

describe("checkConflict", () => {
  it("reports memory-flash as absent on a clean host", async () => {
    const { checkConflict } = await import("../server/conflict");
    const result = checkConflict();
    expect(result.memoryFlashInstalled).toBe(false);
    expect(result.conflict).toBe(false);
    expect(result.singleMemoryHost).toBe(true);
    expect(result.note).toContain("not installed");
  });

  it("detects memory-flash registered in the Paseo config", async () => {
    writeConfig({
      version: 1,
      plugins: { "memory-flash": { source: "directory", path: "/opt/memory-flash", enabled: true } },
    });
    const { checkConflict } = await import("../server/conflict");
    const result = checkConflict();
    expect(result.memoryFlashInstalled).toBe(true);
    expect(result.conflict).toBe(false);
    expect(result.note).toContain("allowed");
  });

  it("ignores a disabled memory-flash entry in the config", async () => {
    writeConfig({ plugins: { "memory-flash": { enabled: false } } });
    const { checkConflict } = await import("../server/conflict");
    expect(checkConflict().memoryFlashInstalled).toBe(false);
  });

  it("detects memory-flash from its data directory alone", async () => {
    makePluginDir("memory-flash");
    const { checkConflict } = await import("../server/conflict");
    expect(checkConflict().memoryFlashInstalled).toBe(true);
  });

  it("survives a missing or corrupted config file", async () => {
    const { checkConflict } = await import("../server/conflict");
    expect(checkConflict().memoryFlashInstalled).toBe(false);
    fs.writeFileSync(path.join(tempHome, "config.json"), "{broken", "utf-8");
    expect(checkConflict().memoryFlashInstalled).toBe(false);
  });

  it("treats the two plugins on one host as coexistence, not a conflict", async () => {
    writeConfig({
      plugins: {
        "memory-flash": { enabled: true },
        "memory-flash-client": { enabled: true },
      },
    });
    makePluginDir("memory-flash");
    const { checkConflict } = await import("../server/conflict");
    const result = checkConflict();
    expect(result.memoryFlashInstalled).toBe(true);
    // The whole point: allowed, and reported as such.
    expect(result.conflict).toBe(false);
    expect(result.note).toContain("memory-flash-client run on this host");
  });
});

describe("identity helpers", () => {
  it("generates a v4 uuid and validates it", async () => {
    const { generateClientId, isValidClientId } = await import("../server/identity");
    const id = generateClientId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isValidClientId(id)).toBe(true);
    expect(isValidClientId("short")).toBe(false);
    expect(isValidClientId("")).toBe(false);
    // Two generations must differ — the id identifies one client.
    expect(generateClientId()).not.toBe(id);
  });

  it("prefers the settings hostname over the OS hostname", async () => {
    const { resolveIdentityHost } = await import("../server/identity");
    expect(resolveIdentityHost("studio-laptop")).toBe("studio-laptop");
    expect(resolveIdentityHost("  ")).toBe(os.hostname());
    expect(resolveIdentityHost("")).toBe(os.hostname());
  });
});
