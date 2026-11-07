// Stage 0.25.11: the new HTTP surface — settings, /api/state, ssh config sync,
// public-key deployment, the lock route, SSE pushes, and the ghostty Apply
// route regression (the console used to POST /api/ghostty/import/apply → 404).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleHttpServer } from "../server/http-server";
import type { ConsoleSettings } from "../server/settings";
import { Store } from "../server/store";
import type { VaultService } from "../server/vault";
import type { SshExecResult } from "../server/key-copy";

const TOKEN = "test-token";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@host";

let dir: string;
let server: ConsoleHttpServer;
let base: string;
let store: Store;
let settings: ConsoleSettings;
let applied: unknown[];

function url(pathname: string): string {
  return `${base}${pathname}${pathname.includes("?") ? "&" : "?"}token=${TOKEN}`;
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url(pathname));
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function sendJson(pathname: string, method: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url(pathname), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "remote-control-h3-http-"));
  store = new Store({ dbPath: path.join(dir, "store.db") });
  applied = [];
  settings = {
    consolePort: 0,
    autoLockMinutes: 0,
    storeDir: path.join(dir, "pass-store"),
    rdpBinary: "",
    vncBinary: "",
  };
  const vault = {
    status: () => ({
      initialized: true,
      unlocked: false,
      entries: ["connections/x/password"],
      storeDir: settings.storeDir,
      gnupgHome: path.join(dir, "gnupg"),
      keyId: "KEY",
      autoLockMs: 0,
    }),
    lock: () => {
      applied.push("lock");
    },
  } as unknown as VaultService;

  server = new ConsoleHttpServer({
    token: TOKEN,
    port: 0,
    store,
    vault,
    sshConfigPath: path.join(dir, "config"),
    settings: {
      load: () => settings,
      save: (patch) => {
        applied.push(patch);
        const next = patch as Partial<ConsoleSettings>;
        const restart = next.consolePort !== undefined && next.consolePort !== settings.consolePort;
        settings = { ...settings, ...next };
        return { settings, restart };
      },
    },
    endpointStatus: () => ({ listening: true, boundPort: 41234, portFallback: false, sseSubscribers: 0 }),
    sshExec: async (): Promise<SshExecResult> => ({
      code: 0,
      stdout: "REMOTE_CONTROL_ADDED\n",
      stderr: "",
      timedOut: false,
      spawnError: null,
    }),
  });
  await server.start();
  base = server.origin!;
});

afterEach(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("/api/state and /api/settings", () => {
  it("reports the console, vault and settings in one document", async () => {
    const { status, body } = await getJson("/api/state");
    expect(status).toBe(200);
    expect(body.console).toMatchObject({ boundPort: 41234 });
    expect(body.vault).toMatchObject({ storeDir: settings.storeDir, unlocked: false });
    expect(body.settings.consolePort).toBe(0);
    expect(body.sshConfigPath).toBe(path.join(dir, "config"));
  });

  it("reads and patches settings, reporting a port restart", async () => {
    const read = await getJson("/api/settings");
    expect(read.body.settings.autoLockMinutes).toBe(0);

    const patched = await sendJson("/api/settings", "PATCH", { consolePort: 7788, autoLockMinutes: 10 });
    expect(patched.status).toBe(200);
    expect(patched.body.restart).toBe(true);
    expect(patched.body.settings).toMatchObject({ consolePort: 7788, autoLockMinutes: 10 });

    const again = await sendJson("/api/settings", "PATCH", { autoLockMinutes: 20 });
    expect(again.body.restart).toBe(false);
    expect(again.body.settings.consolePort).toBe(7788);
  });

  it("rejects an invalid patch through the bridge", async () => {
    settings = { ...settings };
    const failing = new ConsoleHttpServer({
      token: TOKEN,
      port: 0,
      settings: {
        load: () => settings,
        save: () => {
          throw new Error("consolePort must be an integer between 0 and 65535");
        },
      },
    });
    await failing.start();
    try {
      const res = await fetch(
        `${failing.origin}/api/settings?token=${TOKEN}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consolePort: 90000 }) },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/consolePort/);
    } finally {
      await failing.stop();
    }
  });

  it("locks the vault but keeps setup/unlock out of the API", async () => {
    const lock = await sendJson("/api/vault/lock", "POST", {});
    expect(lock.status).toBe(200);
    expect(applied).toContain("lock");

    expect((await sendJson("/api/vault/unlock", "POST", { password: "x" })).status).toBe(404);
    expect((await sendJson("/api/vault/setup", "POST", { password: "x" })).status).toBe(404);
  });
});

describe("/api/ssh-config", () => {
  it("parses the configured file and syncs one connection", async () => {
    writeFileSync(
      path.join(dir, "config"),
      "# hand-written\nHost existing\n  HostName existing.example.com\n  ForwardAgent yes\n",
    );
    const created = store.createConnection({
      id: "conn_ssh",
      groupId: null,
      name: "Work box",
      protocol: "ssh",
      host: "work.example.com",
      port: 2222,
      username: "alice",
      payload: {},
      secretRefs: {},
    });

    const before = await getJson("/api/ssh-config");
    expect(before.status).toBe(200);
    expect(before.body.config.hosts.map((host: any) => host.alias)).toEqual(["existing"]);

    const synced = await sendJson("/api/ssh-config/sync", "POST", { connectionId: created.id });
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ ok: true, alias: "work-box", action: "created" });

    const text = readFileSync(path.join(dir, "config"), "utf8");
    expect(text).toContain("Host existing\n  HostName existing.example.com\n  ForwardAgent yes");
    expect(text).toContain("# remote-control: conn_ssh\nHost work-box\n  HostName work.example.com\n  User alice\n  Port 2222");

    const after = await getJson("/api/ssh-config");
    const managed = after.body.config.hosts.find((host: any) => host.alias === "work-box");
    expect(managed.managedConnectionId).toBe("conn_ssh");
  });

  it("fails the sync for an unknown connection", async () => {
    const res = await sendJson("/api/ssh-config/sync", "POST", { connectionId: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connection not found/);
  });
});

describe("/api/connections/:id/copy-key", () => {
  it("deploys the key through the injected runner", async () => {
    const publicKeyPath = path.join(dir, "id_test.pub");
    writeFileSync(publicKeyPath, `${KEY}\n`);
    const created = store.createConnection({
      id: "conn_ssh",
      groupId: null,
      name: "Work box",
      protocol: "ssh",
      host: "work.example.com",
      port: null,
      username: "alice",
      payload: { publicKeyPath },
      secretRefs: {},
    });

    const res = await sendJson(`/api/connections/${created.id}/copy-key`, "POST", {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.added).toBe(true);
    expect(res.body.fingerprint).toMatch(/^SHA256:/);
  });

  it("answers 404 for an unknown connection", async () => {
    const res = await sendJson("/api/connections/missing/copy-key", "POST", {});
    expect(res.status).toBe(404);
  });
});

describe("live sessions", () => {
  it("pushes an SSE event to an open console", async () => {
    const received = new Promise<string>((resolve, reject) => {
      const request = http.get(`${base}/api/events?token=${TOKEN}`, (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (chunk.includes("event: sessions")) {
            response.destroy();
            resolve(chunk);
          }
        });
      });
      request.on("error", reject);
      setTimeout(() => {
        request.destroy();
        reject(new Error("no SSE event received"));
      }, 3000);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    server.broadcastSse("sessions", { sessions: [] });
    expect(await received).toContain('event: sessions');
  });
});

describe("ghostty Apply regression", () => {
  it("serves the route the console calls and nothing else", () => {
    const source = readFileSync(path.join(__dirname, "..", "console", "src", "main.ts"), "utf8");
    expect(source).not.toContain("/api/ghostty/import/apply");
    expect(source).toContain('api("/api/ghostty/import", {');
  });

  it("answers 404 on the removed /apply path", async () => {
    const res = await sendJson("/api/ghostty/import/apply", "POST", { settings: {} });
    expect(res.status).toBe(404);
  });
});
