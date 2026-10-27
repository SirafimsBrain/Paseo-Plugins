// Connection passwords over HTTP: the value goes into the pass vault, the
// database only ever holds the secret name (stage D-vault wiring).

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

async function post(base: string, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}?token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function patch(base: string, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}?token=${TOKEN}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(base: string, route: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}?token=${TOKEN}`);
  return { status: res.status, body: await res.json() };
}

describeIf("connection passwords via the vault (gpg available)", () => {
  let dir: string;
  let store: Store;
  let vault: VaultService;
  let server: ConsoleHttpServer;
  let base: string;
  /** Server whose vault was never set up, for the rejection paths. */
  let freshServer: ConsoleHttpServer;
  let freshBase: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-connpass-"));
    store = new Store({ dbPath: path.join(dir, "rc.db") });
    vault = new VaultService({ paseoHome: path.join(dir, "home"), autoLockMs: 0, log: () => {} });
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

  async function createWithPassword(base: string, password = "s3cret") {
    return post(base, "/api/connections", {
      name: "web",
      protocol: "ssh",
      host: "example.com",
      username: "alice",
      port: 2222,
      password,
      masterPassword: "master-pass",
    });
  }

  it("stores a password given with a new connection", async () => {
    const created = await createWithPassword(base);
    expect(created.status).toBe(201);
    const connection = created.body.connection;
    const secretName = `connections/${connection.id}/password`;
    expect(connection.secretRefs.passwordSecret).toBe(secretName);
    // The API response (and the database row behind it) never carries the value.
    expect(JSON.stringify(created.body)).not.toContain("s3cret");

    const stored = await get(base, `/api/secrets/${encodeURIComponent(secretName)}`);
    expect(stored.status).toBe(200);
    expect(stored.body.value).toBe("s3cret");
  });

  it("rejects a password when an uninitialized vault gets no master password", async () => {
    const created = await post(freshBase, "/api/connections", {
      name: "db",
      protocol: "rdp",
      host: "10.0.0.5",
      password: "nope",
    });
    expect(created.status).toBe(400);
    expect(String(created.body.error)).toMatch(/not initialized/);
    // The failed write must not leave a half-created connection behind.
    const list = await get(freshBase, "/api/connections");
    expect(list.body.connections).toHaveLength(0);
  });

  it("rejects a wrong master password and keeps the vault locked", async () => {
    vault.lock();
    const created = await post(base, "/api/connections", {
      name: "x",
      protocol: "ssh",
      host: "h",
      password: "p",
      masterPassword: "wrong",
    });
    expect(created.status).toBe(400);
    expect(String(created.body.error)).toMatch(/wrong master password/);
    expect(vault.isUnlocked()).toBe(false);
    await vault.unlock("master-pass");
    expect(vault.isUnlocked()).toBe(true);
  });

  it("updates the stored password and the login through PATCH", async () => {
    const created = await createWithPassword(base, "old-pass");
    const id = created.body.connection.id;

    const updated = await patch(base, `/api/connections/${id}`, {
      username: "bob",
      password: "new-pass",
      masterPassword: "master-pass",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.connection.username).toBe("bob");
    expect(updated.body.connection.secretRefs.passwordSecret).toBe(`connections/${id}/password`);
    expect(JSON.stringify(updated.body)).not.toContain("new-pass");

    const stored = await get(base, `/api/secrets/${encodeURIComponent(`connections/${id}/password`)}`);
    expect(stored.body.value).toBe("new-pass");
  });

  it("keeps the stored password when PATCH does not mention it", async () => {
    const created = await createWithPassword(base, "keep-me");
    const id = created.body.connection.id;

    const updated = await patch(base, `/api/connections/${id}`, { name: "renamed" });
    expect(updated.status).toBe(200);
    expect(updated.body.connection.name).toBe("renamed");
    expect(updated.body.connection.secretRefs.passwordSecret).toBeTruthy();

    const stored = await get(base, `/api/secrets/${encodeURIComponent(`connections/${id}/password`)}`);
    expect(stored.body.value).toBe("keep-me");
  });

  it("clears the stored password when PATCHed with an empty password", async () => {
    const created = await createWithPassword(base, "gone");
    const id = created.body.connection.id;

    const updated = await patch(base, `/api/connections/${id}`, { password: "" });
    expect(updated.status).toBe(200);
    expect(updated.body.connection.secretRefs.passwordSecret).toBeUndefined();

    const stored = await get(base, `/api/secrets/${encodeURIComponent(`connections/${id}/password`)}`);
    expect(stored.status).toBe(400);
    expect(String(stored.body.error)).toMatch(/not found/);
  });
});
