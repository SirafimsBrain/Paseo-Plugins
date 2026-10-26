import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultService, VaultLockedError, VaultNotInitializedError } from "../server/vault";

const gpgAvailable = (() => {
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let tmp: string;
let vault: VaultService;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vault-"));
  vault = new VaultService({
    paseoHome: tmp,
    autoLockMs: 0,
    log: () => {},
  });
});

afterEach(() => {
  try {
    vault.lock();
  } catch {
    // ignore
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const describeIf = gpgAvailable ? describe : describe.skip;

describeIf("vault service (gpg available)", () => {
  it("reports not initialized initially", () => {
    const status = vault.status();
    expect(status.initialized).toBe(false);
    expect(status.unlocked).toBe(false);
    expect(status.entries).toEqual([]);
  });

  it("setup generates a key and a probe", async () => {
    const result = await vault.setup("correct horse battery staple");
    expect(result.generated).toBe(true);
    expect(vault.status().initialized).toBe(true);
    expect(vault.status().keyId).toBeTruthy();
  });

  it("unlock with the right password succeeds and caches it", async () => {
    await vault.setup("secret123");
    const result = await vault.unlock("secret123");
    expect(result.ok).toBe(true);
    expect(vault.isUnlocked()).toBe(true);
  });

  it("unlock with a wrong password fails and does not cache", async () => {
    await vault.setup("secret123");
    const result = await vault.unlock("wrong");
    expect(result.ok).toBe(false);
    expect(vault.isUnlocked()).toBe(false);
  });

  it("reads and writes secrets without re-prompting while unlocked", async () => {
    await vault.setup("secret123");
    await vault.unlock("secret123");
    await vault.set("demo/password", "hunter2");
    // Multiple consecutive reads work without re-unlocking.
    expect(await vault.get("demo/password")).toBe("hunter2");
    expect(await vault.get("demo/password")).toBe("hunter2");
    expect(vault.listEntries()).toContain("demo/password");
  });

  it("throws VaultLockedError when locked", async () => {
    await vault.setup("secret123");
    await vault.unlock("secret123");
    await vault.set("x", "y");
    vault.lock();
    await expect(vault.get("x")).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("lock zeroes the passphrase buffer", async () => {
    await vault.setup("secret123");
    await vault.unlock("secret123");
    const buffer = vault.passphraseBuffer();
    expect(buffer).not.toBeNull();
    const captured = buffer!;
    vault.lock();
    // The same buffer object must have been zeroed.
    expect(Array.from(captured).every((b) => b === 0)).toBe(true);
    expect(vault.passphraseBuffer()).toBeNull();
  });

  it("auto-locks after the configured inactivity window", async () => {
    const v = new VaultService({ paseoHome: tmp, autoLockMs: 50, log: () => {} });
    await v.setup("secret123");
    await v.unlock("secret123");
    await v.set("x", "y");
    expect(v.isUnlocked()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(v.isUnlocked()).toBe(false);
    v.lock();
  }, 5000);

  it("supports a foreign store directory (PASSWORD_STORE_DIR override)", async () => {
    const foreign = path.join(tmp, "foreign-store");
    const v = new VaultService({ paseoHome: tmp, storeDir: foreign, log: () => {} });
    await v.setup("pw");
    await v.unlock("pw");
    await v.set("a", "b");
    expect(await v.get("a")).toBe("b");
    expect(v.status().storeDir).toBe(foreign);
    v.lock();
  });

  it("idempotent setup does not regenerate the key", async () => {
    const first = await vault.setup("secret123");
    expect(first.generated).toBe(true);
    const keyId = vault.status().keyId;
    const second = await vault.setup("secret123");
    expect(second.generated).toBe(false);
    expect(vault.status().keyId).toBe(keyId);
  });

  it("delete removes the secret", async () => {
    await vault.setup("secret123");
    await vault.unlock("secret123");
    await vault.set("tmp", "v");
    expect(await vault.delete("tmp")).toBe(true);
    await expect(vault.get("tmp")).rejects.toThrow();
  });
});

describe("vault service (no gpg)", () => {
  it("VaultService constructs without throwing even when gpg is missing", () => {
    const v = new VaultService({ paseoHome: tmp, log: () => {} });
    expect(v.status().initialized).toBe(false);
  });
});