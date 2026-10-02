import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../server/store";

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-api-keys-"));
  store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
});

/** Test-only access to the underlying connection. */
function db(): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

describe("API keys", () => {
  it("generates unique keys with secret, prefix and scopes", () => {
    const first = store.generateApiKey({ label: "laptop" });
    const second = store.generateApiKey({ label: "builder" });
    expect(first.record.id).toMatch(/^mfk_/);
    expect(second.record.id).toMatch(/^mfk_/);
    expect(first.record.id).not.toBe(second.record.id);
    expect(first.secret).toMatch(/^mf_live_/);
    expect(first.secret).not.toBe(second.secret);
    expect(first.record.prefix).toBe(first.secret.slice(0, 12));
    expect(first.record.scopes).toEqual(["read_write"]);
    expect(first.record.expiresAt).toBeNull();
    expect(first.record.revokedAt).toBeNull();
    expect(first.record.lastUsedAt).toBeNull();
    expect(first.record.label).toBe("laptop");
  });

  it("honors the read scope", () => {
    const { record } = store.generateApiKey({ label: "reader", scope: "read" });
    expect(record.scopes).toEqual(["read"]);
  });

  it("sets expiresAt from ttlDays", () => {
    const { record } = store.generateApiKey({ label: "temp", ttlDays: 2 });
    expect(record.expiresAt).not.toBeNull();
    const expires = new Date(record.expiresAt!).getTime();
    const now = Date.now();
    expect(expires).toBeGreaterThan(now + 86_399_000);
    expect(expires).toBeLessThan(now + 2 * 86_400_000 + 60_000);
  });

  it("authenticates the generated secret and touches last_used_at", async () => {
    const { record, secret } = store.generateApiKey({ label: "laptop" });
    const authenticated = store.authenticateApiKey(secret);
    expect(authenticated).not.toBeNull();
    expect(authenticated!.id).toBe(record.id);
    expect(authenticated!.label).toBe("laptop");
    expect(authenticated!.lastUsedAt).not.toBeNull();
    // A second use refreshes the audit timestamp.
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.authenticateApiKey(secret);
    const again = store.listApiKeys().find((key) => key.id === record.id);
    expect(new Date(again!.lastUsedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(authenticated!.lastUsedAt!).getTime(),
    );
  });

  it("rejects wrong and unknown secrets", () => {
    const { secret } = store.generateApiKey({ label: "laptop" });
    expect(store.authenticateApiKey(`${secret}x`)).toBeNull();
    expect(store.authenticateApiKey("mf_live_nope")).toBeNull();
    expect(store.authenticateApiKey("")).toBeNull();
  });

  it("rejects revoked secrets", () => {
    const { record, secret } = store.generateApiKey({ label: "laptop" });
    expect(store.revokeApiKey(record.id)).toBe(true);
    expect(store.authenticateApiKey(secret)).toBeNull();
  });

  it("rejects expired keys", () => {
    const { record, secret } = store.generateApiKey({ label: "temp", ttlDays: 1 });
    db()
      .prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", record.id);
    expect(store.authenticateApiKey(secret)).toBeNull();
  });

  it("revokes by id and counts active keys", () => {
    const first = store.generateApiKey({ label: "a" });
    const second = store.generateApiKey({ label: "b" });
    expect(store.activeKeyCount()).toBe(2);
    expect(store.revokeApiKey(first.record.id)).toBe(true);
    expect(store.activeKeyCount()).toBe(1);
    expect(store.revokeApiKey("mfk_unknown")).toBe(false);
    expect(store.activeKeyCount()).toBe(1);
    expect(second.record.revokedAt).toBeNull();
  });

  it("lists keys without exposing the secret", () => {
    const { secret } = store.generateApiKey({ label: "a" });
    store.generateApiKey({ label: "b" });
    const keys = store.listApiKeys();
    expect(keys.length).toBe(2);
    for (const key of keys) {
      // Only the hash is stored; the hash must not contain the secret.
      expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(key.keyHash).not.toContain(secret.slice("mf_live_".length));
      expect(key.prefix).toMatch(/^mf_live_/);
    }
  });

  it("secrets are unique across generations", () => {
    const secrets = new Set(
      Array.from({ length: 5 }, () => store.generateApiKey({ label: "x" }).secret),
    );
    expect(secrets.size).toBe(5);
  });
});
