import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { Connection } from "../shared/connections";
import type { Store } from "../server/store";
import type { VaultService } from "../server/vault";
import { TerminalService, buildSshCommand } from "../server/terminals";

interface FakePaseoOptions {
  workspaces?: string[];
  entries?: Array<{ id: string; workspaceId: string; cwd: string; name: string }>;
  killFails?: boolean;
}

interface FakePaseo {
  api: PaseoApi;
  created: Array<Record<string, any>>;
}

function fakePaseo(options: FakePaseoOptions = {}): FakePaseo {
  const created: Array<Record<string, any>> = [];
  const api = {
    terminals: {
      create: async (input: Record<string, any>) => {
        created.push(input);
        const id = `term_${created.length}`;
        return {
          id,
          current: () => ({
            id,
            workspaceId: input.workspaceId,
            cwd: input.cwd ?? "/workspace/dir",
            name: input.name ?? "shell",
          }),
        };
      },
      list: async () => ({
        entries: (options.entries ?? []).map((entry) => ({ ...entry })),
        requestId: "req",
      }),
      ref: (id: string) => ({
        kill: async () => {
          if (options.killFails) throw new Error(`Failed to kill terminal ${id}`);
        },
      }),
    },
    workspaces: {
      list: async () => ({ entries: (options.workspaces ?? []).map((id) => ({ id })) }),
    },
  };
  return { api: api as unknown as PaseoApi, created };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    groupId: null,
    name: "bastion",
    protocol: "ssh",
    host: "example.com",
    port: 2222,
    username: "alice",
    payload: {},
    secretRefs: {},
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

/** Run directory an ssh launch put into its wrapper script. */
function runDirOf(script: string): string {
  const match = /rm -rf -- '([^']+)'/.exec(script);
  expect(match).not.toBeNull();
  return match![1];
}

describe("buildSshCommand", () => {
  it("exports only the environment values the launch changed", () => {
    const { command, args } = buildSshCommand(
      { argv: ["ssh", "alice@example.com"], env: { ...process.env, PATH: process.env.PATH ?? "" } },
      "/run/x",
    );
    expect(command).toBe("/bin/sh");
    expect(args[0]).toBe("-c");
    expect(args[1]).not.toContain("export PATH=");
  });

  it("exports askpass variables and keeps credentials out of argv", () => {
    const { args } = buildSshCommand(
      {
        argv: ["ssh", "alice@example.com"],
        env: { ...process.env, SSH_ASKPASS: "/run/x/askpass.sh", SSH_ASKPASS_REQUIRE: "force" },
      },
      "/run/x",
    );
    const script = args[1];
    expect(script).toContain("export SSH_ASKPASS='/run/x/askpass.sh'");
    expect(script).toContain("export SSH_ASKPASS_REQUIRE='force'");
    expect(script).toContain("'ssh' 'alice@example.com'");
    expect(script).not.toContain("password");
  });

  it("removes the run directory after ssh exits and propagates its status", () => {
    const { args } = buildSshCommand({ argv: ["ssh", "host"] }, "/run/x");
    const lines = args[1].split("\n");
    const commandLine = lines.findIndex((line) => line.includes("'ssh' 'host'"));
    expect(commandLine).toBeGreaterThanOrEqual(0);
    expect(lines[commandLine + 1]).toBe("rc=$?");
    expect(lines[commandLine + 2]).toBe("rm -rf -- '/run/x'");
    expect(lines[commandLine + 3]).toBe("exit $rc");
  });

  it("quotes argv entries that contain shell metacharacters", () => {
    const { args } = buildSshCommand(
      { argv: ["ssh", "-o", "ProxyCommand=ssh user@h echo $HOME", "host"] },
      "/run/x",
    );
    expect(args[1]).toContain("'ProxyCommand=ssh user@h echo $HOME'");
  });
});

describe("TerminalService", () => {
  let runDirBase: string;

  beforeEach(() => {
    runDirBase = mkdtempSync(path.join(tmpdir(), "remote-control-terminals-"));
  });

  afterEach(() => {
    rmSync(runDirBase, { recursive: true, force: true });
  });

  function service(api: PaseoApi, extra: { store?: Store; vault?: VaultService } = {}) {
    return new TerminalService({
      paseo: () => api,
      store: extra.store ?? null,
      vault: extra.vault ?? null,
      runDirBase,
    });
  }

  function sshHarness() {
    const conn = connection({ secretRefs: { identitySecret: "remote-control/conn_1/identity" } });
    const store = { getConnection: (id: string) => (id === conn.id ? conn : null) } as unknown as Store;
    const vault = { get: async () => "-----BEGIN PRIVATE KEY-----\nkey material\n" } as unknown as VaultService;
    return { conn, store, vault };
  }

  it("refuses to work before the first plugin RPC", async () => {
    const svc = service(null as unknown as PaseoApi);
    await expect(svc.open({})).rejects.toThrow(/Paseo API is not ready/);
  });

  it("resolves the requested workspace first", async () => {
    const { api } = fakePaseo({ workspaces: ["ws_a", "ws_b"] });
    await expect(service(api).resolveWorkspaceId("ws_b")).resolves.toBe("ws_b");
  });

  it("auto-picks the only workspace and refuses ambiguity", async () => {
    const single = fakePaseo({ workspaces: ["ws_a"] });
    await expect(service(single.api).resolveWorkspaceId(null)).resolves.toBe("ws_a");

    const many = fakePaseo({ workspaces: ["ws_a", "ws_b"] });
    await expect(service(many.api).resolveWorkspaceId(null)).rejects.toThrow(/workspaceId is required/);

    const none = fakePaseo({ workspaces: [] });
    await expect(service(none.api).resolveWorkspaceId(null)).rejects.toThrow(/No Paseo workspaces/);
  });

  it("opens a local terminal in the workspace", async () => {
    const { api, created } = fakePaseo({ workspaces: ["ws_a"] });
    const info = await service(api).open({ workspaceId: "ws_a" });
    expect(created).toHaveLength(1);
    expect(created[0].workspaceId).toBe("ws_a");
    expect(created[0].command).toBeUndefined();
    expect(info.kind).toBe("local");
    expect(info.id).toBe("term_1");
  });

  it("launches ssh through the shell wrapper with the vault identity file", async () => {
    const { api, created } = fakePaseo({ workspaces: ["ws_a"] });
    const { conn, store, vault } = sshHarness();
    const svc = service(api, { store, vault });

    const info = await svc.open({ workspaceId: "ws_a", connectionId: conn.id });

    expect(created).toHaveLength(1);
    expect(created[0].command).toBe("/bin/sh");
    expect(created[0].args[0]).toBe("-c");
    const script: string = created[0].args[1];
    expect(script).toContain("'ssh' '-p' '2222'");
    expect(script).toContain("'alice@example.com'");
    expect(script).toContain("IdentitiesOnly=yes");
    expect(info.kind).toBe("ssh");
    expect(info.connectionId).toBe(conn.id);
    expect(info.name).toBe("bastion");

    const identityFile = path.join(runDirOf(script), "id");
    expect(existsSync(identityFile)).toBe(true);

    await expect(svc.kill(info.id)).resolves.toBe(true);
    expect(existsSync(path.dirname(identityFile))).toBe(false);
  });

  it("rejects connections whose protocol cannot be launched", async () => {
    const { api, created } = fakePaseo({ workspaces: ["ws_a"] });
    const conn = connection({ id: "conn_rdp", protocol: "rdp", host: "10.0.0.1", port: 3389, username: "" });
    const store = { getConnection: () => conn } as unknown as Store;
    await expect(
      service(api, { store }).open({ workspaceId: "ws_a", connectionId: "conn_rdp" }),
    ).rejects.toThrow(/not launchable/);
    expect(created).toHaveLength(0);
  });

  it("cleans the run directory of terminals that ended on their own", async () => {
    const { api, created } = fakePaseo({ workspaces: ["ws_a"], entries: [] });
    const { conn, store, vault } = sshHarness();
    const svc = service(api, { store, vault });

    await svc.open({ workspaceId: "ws_a", connectionId: conn.id });
    const runDir = runDirOf(created[0].args[1]);
    expect(existsSync(runDir)).toBe(true);

    // A listing scoped to another workspace proves nothing about this one.
    await expect(svc.list("ws_b")).resolves.toHaveLength(0);
    expect(existsSync(runDir)).toBe(true);

    // The daemon no longer reports the terminal: the next refresh cleans up.
    await expect(svc.list("ws_a")).resolves.toHaveLength(0);
    expect(existsSync(runDir)).toBe(false);
  });

  it("reports a failed kill as false", async () => {
    const { api } = fakePaseo({ workspaces: ["ws_a"], killFails: true });
    await expect(service(api).kill("term_x")).resolves.toBe(false);
  });
});
