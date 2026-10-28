// Service layer (stage 0.21.10): grouped duplication of connections, the
// connection test and the auth flag it maintains.
//
// - copy naming: `base` → `base_copy` → `base_copy1` → `base_copy2`…
// - duplicate over HTTP: every field and every stored secret follows the new
//   id, the modal's computed name is only a suggestion (the server computes
//   one too when the body has none).
// - the test route: key-first probe, `payload.auth` recorded on success only,
//   a changed target resets it to unknown. The probe itself is injectable so
//   the route contract is testable without a live host; the real probe gets a
//   closed-port run below.

import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "../shared/connections";
import { ConsoleHttpServer } from "../server/http-server";
import { Store } from "../server/store";
import { testSshConnection } from "../server/probe";
import { nextCopyName } from "../shared/naming";

const sshAvailable = (() => {
  try {
    execFileSync("ssh", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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

describe("copy names", () => {
  it("appends _copy once and then increments", () => {
    expect(nextCopyName("omnirouter_root", [])).toBe("omnirouter_root_copy");
    expect(nextCopyName("omnirouter_root", ["omnirouter_root_copy"])).toBe(
      "omnirouter_root_copy1",
    );
    expect(
      nextCopyName("omnirouter_root", [
        "omnirouter_root_copy",
        "omnirouter_root_copy1",
        "omnirouter_root_copy2",
      ]),
    ).toBe("omnirouter_root_copy3");
  });

  it("chains off the original when the source is itself a copy", () => {
    expect(nextCopyName("omnirouter_root_copy", ["omnirouter_root_copy"])).toBe(
      "omnirouter_root_copy1",
    );
    expect(
      nextCopyName("omnirouter_root_copy", [
        "omnirouter_root_copy",
        "omnirouter_root_copy1",
      ]),
    ).toBe("omnirouter_root_copy2");
  });

  it("never returns a name already in use", () => {
    const taken = ["a_copy", "a_copy1", "a_copy2"];
    expect(nextCopyName("a", taken)).toBe("a_copy3");
    expect(taken).not.toContain(nextCopyName("a", taken));
  });
});

describe("duplicate connection over HTTP", () => {
  let dir: string;
  let store: Store;
  let server: ConsoleHttpServer;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-dup-"));
    store = new Store({ dbPath: path.join(dir, "rc.db") });
    server = new ConsoleHttpServer({ token: TOKEN, port: 0, store });
    await server.start();
    base = server.origin!;
  });

  afterAll(async () => {
    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedConnection() {
    const group = await post(base, "/api/groups", { name: "OMNIROUTER" });
    expect(group.status).toBe(201);
    const created = await post(base, "/api/connections", {
      groupId: group.body.group.id,
      name: "omnirouter_root",
      protocol: "ssh",
      host: "omnirouter",
      port: 2222,
      username: "root",
    });
    expect(created.status).toBe(201);
    const id = created.body.connection.id;
    await patch(base, `/api/connections/${id}`, { payload: { auth: "key" } });
    return { groupId: group.body.group.id as string, id };
  }

  it("copies every field, the group and the auth flag under the next _copy name", async () => {
    const { groupId, id } = await seedConnection();

    const dup = await post(base, "/api/connections", { duplicateOf: id });
    expect(dup.status).toBe(201);
    const copy = dup.body.connection;
    expect(copy.id).not.toBe(id);
    expect(copy.name).toBe("omnirouter_root_copy");
    expect(copy.groupId).toBe(groupId);
    expect(copy.protocol).toBe("ssh");
    expect(copy.host).toBe("omnirouter");
    expect(copy.port).toBe(2222);
    expect(copy.username).toBe("root");
    expect(copy.payload.auth).toBe("key");

    const dup2 = await post(base, "/api/connections", { duplicateOf: id });
    expect(dup2.status).toBe(201);
    expect(dup2.body.connection.name).toBe("omnirouter_root_copy1");

    const named = await post(base, "/api/connections", {
      duplicateOf: id,
      name: "custom name",
    });
    expect(named.status).toBe(201);
    expect(named.body.connection.name).toBe("custom name");
  });

  it("lets the body override individual fields of the copy", async () => {
    const { id } = await seedConnection();
    const dup = await post(base, "/api/connections", {
      duplicateOf: id,
      host: "other-router",
      username: "sirafim",
      port: null,
    });
    expect(dup.status).toBe(201);
    expect(dup.body.connection.host).toBe("other-router");
    expect(dup.body.connection.username).toBe("sirafim");
    expect(dup.body.connection.port).toBeNull();
    expect(dup.body.connection.name).toBe("omnirouter_root_copy2");
  });

  it("rejects an unknown source connection", async () => {
    const dup = await post(base, "/api/connections", { duplicateOf: "conn_missing" });
    expect(dup.status).toBe(404);
    expect(String(dup.body.error)).toMatch(/source connection not found/);
  });

  it("resets the auth flag when the target changes, keeps it on rename", async () => {
    const { id } = await seedConnection();

    const renamed = await patch(base, `/api/connections/${id}`, { name: "renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.connection.payload.auth).toBe("key");

    const moved = await patch(base, `/api/connections/${id}`, { host: "elsewhere" });
    expect(moved.status).toBe(200);
    expect(moved.body.connection.payload.auth).toBeUndefined();

    // back to a known state, then a login change invalidates it as well
    await patch(base, `/api/connections/${id}`, { payload: { auth: "password" } });
    const relog = await patch(base, `/api/connections/${id}`, { username: "other" });
    expect(relog.body.connection.payload.auth).toBeUndefined();
  });
});

describe("connection test route (injected probe)", () => {
  let dir: string;
  let store: Store;
  let server: ConsoleHttpServer;
  let base: string;
  const calls = new Map<string, number>();

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-probe-"));
    store = new Store({ dbPath: path.join(dir, "rc.db") });
    server = new ConsoleHttpServer({
      token: TOKEN,
      port: 0,
      store,
      sshProbe: async (connection: Connection) => {
        const n = calls.get(connection.id) ?? 0;
        calls.set(connection.id, n + 1);
        if (connection.name.startsWith("fail")) {
          return { ok: false, auth: "unknown", message: "ssh: connect to host: Connection refused" };
        }
        // first call proves the key, later calls fail (transient outage)
        if (n === 0) {
          return { ok: true, auth: "key", message: "the host accepted the public key" };
        }
        return { ok: false, auth: "unknown", message: "connection timed out after 6s" };
      },
    });
    await server.start();
    base = server.origin!;
  });

  afterAll(async () => {
    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function create(name: string, protocol = "ssh") {
    const created = await post(base, "/api/connections", {
      name,
      protocol,
      host: `${name}.example.com`,
      username: "alice",
    });
    expect(created.status).toBe(201);
    return created.body.connection.id as string;
  }

  it("records payload.auth on a successful probe", async () => {
    const id = await create("by-key");
    const tested = await post(base, `/api/connections/${id}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.auth).toBe("key");
    expect(tested.body.message).toBe("the host accepted the public key");

    const fetched = await get(base, `/api/connections/${id}`);
    expect(fetched.body.connection.payload.auth).toBe("key");
  });

  it("leaves the flag untouched when a later probe fails", async () => {
    const id = await create("flaky");
    await post(base, `/api/connections/${id}/test`, {}); // ok → key
    const again = await post(base, `/api/connections/${id}/test`, {});
    expect(again.body.ok).toBe(false);
    expect(again.body.auth).toBe("unknown");

    const fetched = await get(base, `/api/connections/${id}`);
    expect(fetched.body.connection.payload.auth).toBe("key");
  });

  it("leaves a fresh connection at unknown after a failed probe", async () => {
    const id = await create("fail-host");
    const tested = await post(base, `/api/connections/${id}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(false);
    expect(tested.body.message).toMatch(/Connection refused/);

    const fetched = await get(base, `/api/connections/${id}`);
    expect(fetched.body.connection.payload.auth).toBeUndefined();
  });

  it("refuses non-ssh protocols and unknown ids", async () => {
    const rdpId = await create("winbox", "rdp");
    const tested = await post(base, `/api/connections/${rdpId}/test`, {});
    expect(tested.status).toBe(400);
    expect(String(tested.body.error)).toMatch(/supports ssh only/);

    const missing = await post(base, "/api/connections/conn_missing/test", {});
    expect(missing.status).toBe(404);
  });
});

const describeIfSsh = sshAvailable ? describe : describe.skip;

describeIfSsh("real ssh probe (no live host needed)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-probe-real-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails fast against a closed port and reports the ssh error", async () => {
    const store = new Store({ dbPath: path.join(dir, "rc.db") });
    const connection = store.createConnection({
      id: "conn_probe_closed",
      groupId: null,
      name: "closed",
      protocol: "ssh",
      host: "127.0.0.1",
      port: 1,
      username: "nobody",
    });
    try {
      const result = await testSshConnection(connection, {
        runDirBase: path.join(dir, "run"),
        connectTimeoutSec: 3,
        attemptTimeoutMs: 8_000,
      });
      expect(result.ok).toBe(false);
      expect(result.auth).toBe("unknown");
      expect(result.message).toMatch(/refused|timed out|closed/i);
    } finally {
      store.close();
    }
  }, 20_000);

  it("rejects a non-ssh connection without spawning anything", async () => {
    const store = new Store({ dbPath: path.join(dir, "rc-nonssh.db") });
    const connection = store.createConnection({
      id: "conn_probe_vnc",
      groupId: null,
      name: "vnc",
      protocol: "vnc",
      host: "127.0.0.1",
      port: 5900,
      username: "",
    });
    try {
      const result = await testSshConnection(connection, { runDirBase: path.join(dir, "run") });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/supports ssh only/);
    } finally {
      store.close();
    }
  });
});
