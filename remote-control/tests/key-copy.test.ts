// Stage 0.25.11 (H3): "Copy key to server" — public-key resolution, the
// ssh-copy-id command shape, idempotency and secret hygiene.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../shared/connections";
import type { VaultService } from "../server/vault";
import { copyPublicKey, publicKeyFingerprint } from "../server/key-copy";
import type { SshExec, SshExecOptions, SshExecResult } from "../server/key-copy";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@host";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "remote-control-key-copy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    groupId: null,
    name: "work",
    protocol: "ssh",
    host: "work.example.com",
    port: 2222,
    username: "alice",
    payload: {},
    secretRefs: {},
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  } as Connection;
}

interface Call {
  argv: string[];
  options: SshExecOptions;
}

/** One canned outcome per call, in order. */
function recorder(outcomes: SshExecResult[]): { exec: SshExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: SshExec = async (argv, options) => {
    calls.push({ argv, options });
    return outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
  };
  return { exec, calls };
}

const okAdded: SshExecResult = {
  code: 0,
  stdout: "REMOTE_CONTROL_ADDED\n",
  stderr: "",
  timedOut: false,
  spawnError: null,
};

function writePublicKey(): string {
  const file = path.join(dir, "id_test.pub");
  writeFileSync(file, `${KEY}\n`);
  return file;
}

describe("public key resolution", () => {
  it("uses payload.publicKeyPath and deploys it over ssh", async () => {
    const publicKeyPath = writePublicKey();
    const { exec, calls } = recorder([okAdded]);

    const result = await copyPublicKey(
      connection({ payload: { publicKeyPath } }),
      { exec, runDirBase: dir, sshDir: path.join(dir, "no-keys") },
    );

    expect(result.ok).toBe(true);
    expect(result.added).toBe(true);
    expect(result.keyType).toBe("ssh-ed25519");
    expect(result.source).toBe(publicKeyPath);
    expect(result.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    expect(calls).toHaveLength(1);
    const argv = calls[0]!.argv;
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-p");
    expect(argv).toContain("2222");
    expect(argv).toContain("alice@work.example.com");
    // No stored password: ssh must not hang waiting for a prompt.
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    // The remote command is the last argument and only appends when absent.
    const script = argv[argv.length - 1]!;
    expect(script).toContain("grep -qxF \"$key\"");
    expect(script).toContain("REMOTE_CONTROL_PRESENT");
    expect(script).toContain(">> \"$HOME/.ssh/authorized_keys\"");
    expect(calls[0]!.options.input).toBe(`${KEY}\n`);
  });

  it("reports an already-present key without adding it", async () => {
    const { exec } = recorder([
      { code: 0, stdout: "REMOTE_CONTROL_PRESENT\n", stderr: "", timedOut: false, spawnError: null },
    ]);
    const result = await copyPublicKey(
      connection({ payload: { publicKeyPath: writePublicKey() } }),
      { exec, runDirBase: dir, sshDir: path.join(dir, "no-keys") },
    );
    expect(result.ok).toBe(true);
    expect(result.added).toBe(false);
    expect(result.message).toMatch(/already in authorized_keys/);
  });

  it("falls back to the default ~/.ssh keys", async () => {
    writeFileSync(path.join(dir, "id_ed25519.pub"), `${KEY}\n`);
    const { exec } = recorder([okAdded]);
    const result = await copyPublicKey(connection(), { exec, runDirBase: dir, sshDir: dir });
    expect(result.ok).toBe(true);
    expect(result.source).toBe(path.join(dir, "id_ed25519.pub"));
  });

  it("derives the public half of a stored identity", async () => {
    const { exec, calls } = recorder([
      { code: 0, stdout: `${KEY}\n`, stderr: "", timedOut: false, spawnError: null },
      okAdded,
    ]);
    const vault = {
      isUnlocked: () => true,
      get: async () => "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
    } as unknown as VaultService;

    const result = await copyPublicKey(
      connection({ secretRefs: { identitySecret: "connections/conn_1/identity" } }),
      { exec, vault, runDirBase: dir, sshDir: path.join(dir, "no-keys") },
    );

    expect(result.ok).toBe(true);
    expect(result.source).toMatch(/identity stored in the secret storage/);
    expect(calls[0]!.argv[0]).toBe("ssh-keygen");
    expect(calls[0]!.argv).toEqual(["ssh-keygen", "-y", "-f", expect.any(String)]);
    expect(calls[1]!.argv).toContain("-i");
    expect(calls[1]!.argv).toContain("IdentitiesOnly=yes");
  });

  it("explains what to do when no key exists", async () => {
    const { exec, calls } = recorder([okAdded]);
    const result = await copyPublicKey(connection(), {
      exec,
      runDirBase: dir,
      sshDir: path.join(dir, "empty"),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no public key found/);
    expect(calls).toHaveLength(0);
  });
});

describe("credentials", () => {
  it("uses the stored password through askpass and keeps it out of argv", async () => {
    const { exec, calls } = recorder([okAdded]);
    const vault = {
      isUnlocked: () => true,
      get: async () => "s3cr3t-pass",
    } as unknown as VaultService;

    const result = await copyPublicKey(
      connection({ payload: { publicKeyPath: writePublicKey() }, secretRefs: { passwordSecret: "connections/conn_1/password" } }),
      { exec, vault, runDirBase: dir, sshDir: path.join(dir, "no-keys") },
    );

    expect(result.ok).toBe(true);
    const call = calls[0]!;
    expect(call.options.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(call.options.env.SSH_ASKPASS).toMatch(/askpass\.sh$/);
    expect(call.argv).toContain("NumberOfPasswordPrompts=1");
    expect(call.argv).not.toContain("BatchMode=yes");
    expect(JSON.stringify(call.argv)).not.toContain("s3cr3t-pass");
    expect(call.options.input).not.toContain("s3cr3t-pass");
  });

  it("refuses a locked vault's password but still tries agent keys", async () => {
    const { exec, calls } = recorder([okAdded]);
    const vault = {
      isUnlocked: () => false,
      get: async () => {
        throw new Error("vault is locked");
      },
    } as unknown as VaultService;

    await copyPublicKey(
      connection({ payload: { publicKeyPath: writePublicKey() }, secretRefs: { passwordSecret: "x" } }),
      { exec, vault, runDirBase: dir, sshDir: path.join(dir, "no-keys") },
    );
    expect(calls[0]!.argv).toContain("BatchMode=yes");
    expect(calls[0]!.options.env.SSH_ASKPASS).toBeUndefined();
  });
});

describe("failures", () => {
  it("returns the last stderr line", async () => {
    const { exec } = recorder([
      {
        code: 255,
        stdout: "",
        stderr: "Warning: Permanently added\nPermission denied (publickey).\n",
        timedOut: false,
        spawnError: null,
      },
    ]);
    const result = await copyPublicKey(
      connection({ payload: { publicKeyPath: writePublicKey() } }),
      { exec, runDirBase: dir, sshDir: path.join(dir, "no-keys") },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Permission denied (publickey).");
  });

  it("rejects non-ssh connections", async () => {
    const result = await copyPublicKey(connection({ protocol: "rdp" }), { exec: recorder([okAdded]).exec });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ssh connections only/);
  });
});

describe("fingerprint", () => {
  it("is stable, well-formed and key-specific", () => {
    const first = publicKeyFingerprint(KEY);
    expect(first).toBe(publicKeyFingerprint(KEY));
    expect(first).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const other = publicKeyFingerprint(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2r6G1kZ1oQ0h9m7yXk1m8b7V0c3d4e5f6g7h8i9j0k other@host",
    );
    expect(other).not.toBe(first);
    expect(publicKeyFingerprint("not-a-key")).toBeNull();
  });
});
