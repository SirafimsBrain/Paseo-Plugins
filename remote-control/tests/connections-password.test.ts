// Connection passwords over HTTP under the 0.19.10 contract: the value goes
// into the secret storage, the database only ever holds the secret name, and
// the storage must already be open (first run / unlock live in the panel) —
// the connection API itself has no master-password parameter and no
// manually managed secrets.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsoleHttpServer } from "../server/http-server";
import { Store } from "../server/store";
import { VaultService } from "../server/vault";

const gpgAvailable = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require("node:child_process");
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const describeIf = gpgAvailable ? describe : describe.skip;
const TOKEN = "test-token";

interface Reply {
  status: number;
  body: any;
}

async function post(base: string, route: string, body: unknown): Promise<Reply> {
  const res = await fetch(`${base}${route}?token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function patch(base: string, route: string, body: unknown): Promise<Reply> {
  const res = await fetch(`${base}${route}?token=${TOKEN}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(base: string, route: string): Promise<Reply> {
  const res = await fetch(`${base}${route}?token=${TOKEN}`);
  return { status: res.status, body: await res.json() };
}

describeIf("connection passwords via the secret storage (gpg available)", () => {
  let dir: string;
  let store: Store;
  let vault: VaultService;
  let server: ConsoleHttpServer;
  let base: string;
  /** Server whose storage was never set up: the first-run state. */
  let freshServer: ConsoleHttpServer;
  let freshBase: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-connpass-"));
    store = new Store({ dbPath: path.join(dir, "rc.db") });
    vault = new VaultService({ paseoHome: path.join(dir, "home"), autoLockMs: 0, log: () => {} });
    // First run happened in the panel: setup + unlock with the master password.
    await vault.setup("master-pass");
    await vault.unlock("master-pass");
    server = new ConsoleHttpServer({ token: TOKEN, port: 0, store, vault });
    await server.start();
    base = server.origin!;

    freshServer = new ConsoleHttpServer({
      token: TOKEN,
      port: 0,
      store: new Store({ dbPath: path.join(dir, "fresh.db") }),
      vault: new VaultService({ paseoHome: path.join(dir, "fresh-home"), autoLockMs: 0, log: () => {} }),
    });
    await freshServer.start();
    freshBase = freshServer.origin!;
  }, 60_000);

  afterAll(async () => {
    await server.stop();
    await freshServer.stop();
    try {
      vault.lock();
    } catch {
      // ignore
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function createWithPassword(targetBase: string, password = "s3cret") {
    return post(targetBase, "/api/connections", {
      name: "web",
      protocol: "ssh",
      host: "example.com",
      username: "alice",
      port: 2222,
      password,
    });
  }

  it("stores a password given with a new connection while the storage is open", async () => {
    const created = await createWithPassword(base);
    expect(created.status).toBe(201);
    const connection = created.body.connection;
    const secretName = `connections/${connection.id}/password`;
    expect(connection.secretRefs.passwordSecret).toBe(secretName);
    // The API response (and the database row behind it) never carries the value.
    expect(JSON.stringify(created.body)).not.toContain("s3cret");

    expect(await vault.get(secretName)).toBe("s3cret");
  });

  it("rejects a password on a first-run (not initialized) storage with panel guidance", async () => {
    const created = await post(freshBase, "/api/connections", {
      name: "db",
      protocol: "rdp",
      host: "10.0.0.5",
      password: "nope",
    });
    expect(created.status).toBe(400);
    expect(String(created.body.error)).toMatch(/not initialized.*Remote Control panel/);
    // The failed write must not leave a half-created connection behind.
    const list = await get(freshBase, "/api/connections");
    expect(list.body.connections).toHaveLength(0);
  });

  it("rejects a password while the storage is locked and accepts one without it", async () => {
    vault.lock();
    try {
      const refused = await createWithPassword(base, "locked-pass");
      expect(refused.status).toBe(400);
      expect(String(refused.body.error)).toMatch(/vault is locked.*Remote Control panel/);

      // A connection without a password needs no storage at all.
      const plain = await post(base, "/api/connections", {
        name: "no-secret",
        protocol: "ssh",
        host: "plain.example.com",
      });
      expect(plain.status).toBe(201);
      expect(plain.body.connection.secretRefs).toEqual({});
      const del = await fetch(`${base}/api/connections/${plain.body.connection.id}?token=${TOKEN}`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);
    } finally {
      await vault.unlock("master-pass");
    }
    expect(vault.isUnlocked()).toBe(true);
  });

  it("updates the stored password and the login through PATCH", async () => {
    const created = await createWithPassword(base, "old-pass");
    const id = created.body.connection.id;

    const updated = await patch(base, `/api/connections/${id}`, {
      username: "bob",
      password: "new-pass",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.connection.username).toBe("bob");
    expect(updated.body.connection.secretRefs.passwordSecret).toBe(`connections/${id}/password`);
    expect(JSON.stringify(updated.body)).not.toContain("new-pass");

    expect(await vault.get(`connections/${id}/password`)).toBe("new-pass");
  });

  it("keeps the stored password when PATCH does not mention it", async () => {
    const created = await createWithPassword(base, "keep-me");
    const id = created.body.connection.id;

    const updated = await patch(base, `/api/connections/${id}`, { name: "renamed" });
    expect(updated.status).toBe(200);
    expect(updated.body.connection.name).toBe("renamed");
    expect(updated.body.connection.secretRefs.passwordSecret).toBeTruthy();

    expect(await vault.get(`connections/${id}/password`)).toBe("keep-me");
  });

  it("clears the stored password when PATCHed with an empty password", async () => {
    const created = await createWithPassword(base, "gone");
    const id = created.body.connection.id;

    const updated = await patch(base, `/api/connections/${id}`, { password: "" });
    expect(updated.status).toBe(200);
    expect(updated.body.connection.secretRefs.passwordSecret).toBeUndefined();

    await expect(vault.get(`connections/${id}/password`)).rejects.toThrow(/not found/);
  });

  it("keeps manual secret management out of the API", async () => {
    const list = await get(base, "/api/secrets");
    expect(list.status).toBe(404);
    const setup = await post(base, "/api/vault/setup", { password: "x" });
    expect(setup.status).toBe(404);
    const unlock = await post(base, "/api/vault/unlock", { password: "x" });
    expect(unlock.status).toBe(404);
    const lock = await post(base, "/api/vault/lock", {});
    expect(lock.status).toBe(404);
    // Status stays: the Settings screen reads it.
    const status = await get(base, "/api/vault/status");
    expect(status.status).toBe(200);
    expect(status.body.unlocked).toBe(true);
  });
});
