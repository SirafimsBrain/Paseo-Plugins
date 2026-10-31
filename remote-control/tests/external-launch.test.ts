// External-window launchers (RDP/VNC): binary resolution, argument building
// and the promise that credentials travel outside argv.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../shared/connections";
import {
  buildRdpArgs,
  buildVncArgs,
  findExecutable,
  launchExternalWindow,
  rdpTarget,
} from "../server/protocols/external";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    groupId: null,
    name: "desktop",
    protocol: "rdp",
    host: "10.0.0.7",
    port: null,
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file: string): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(file)) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForRemoval(target: string): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (!existsSync(target)) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${target} to be removed`);
}

describe("findExecutable", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-ext-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when nothing matches", () => {
    expect(findExecutable(["xfreerdp3"], dir)).toBeNull();
  });

  it("prefers earlier names even when a later one exists", () => {
    writeFileSync(path.join(dir, "xfreerdp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(dir, "xfreerdp3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(findExecutable(["xfreerdp3", "xfreerdp"], dir)).toBe(path.join(dir, "xfreerdp3"));
  });

  it("falls back to a later name and skips non-executable files", () => {
    writeFileSync(path.join(dir, "xfreerdp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(dir, "vncviewer"), "not executable", { mode: 0o644 });
    expect(findExecutable(["xfreerdp3", "xfreerdp"], dir)).toBe(path.join(dir, "xfreerdp"));
    expect(findExecutable(["vncviewer"], dir)).toBeNull();
  });
});

describe("buildRdpArgs", () => {
  it("uses the default port and ignores certificates for detached launches", () => {
    const args = buildRdpArgs(connection());
    expect(rdpTarget(connection())).toBe("10.0.0.7:3389");
    expect(args).toContain("/v:10.0.0.7:3389");
    expect(args).toContain("/u:alice");
    expect(args).toContain("/cert:ignore");
    expect(args).not.toContain("/from-stdin:force");
  });

  it("adds /from-stdin:force only when a password will be piped", () => {
    const withPassword = buildRdpArgs(connection(), { withPassword: true });
    expect(withPassword[0]).toBe("/from-stdin:force");
    expect(buildRdpArgs(connection(), { withPassword: false })).not.toContain("/from-stdin:force");
  });

  it("honors the configured port, payload cert and extra args", () => {
    const args = buildRdpArgs(
      connection({ port: 3390, payload: { cert: "tofu", extraArgs: ["/dynamic-resolution"] } }),
    );
    expect(args).toContain("/v:10.0.0.7:3390");
    expect(args).toContain("/cert:tofu");
    expect(args[args.length - 1]).toBe("/dynamic-resolution");
  });
});

describe("buildVncArgs", () => {
  it("uses the raw-port form with the default port", () => {
    const args = buildVncArgs(connection({ protocol: "vnc", username: "" }));
    expect(args[0]).toBe("10.0.0.7::5900");
    expect(args).not.toContain("-passwd");
  });

  it("carries the configured port and the password file", () => {
    const args = buildVncArgs(connection({ protocol: "vnc", port: 5901 }), {
      passwdFile: "/run/x/vnc.passwd",
    });
    expect(args[0]).toBe("10.0.0.7::5901");
    expect(args).toContain("-passwd");
    expect(args[args.indexOf("-passwd") + 1]).toBe("/run/x/vnc.passwd");
  });
});

describe("launchExternalWindow", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-launch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a missing client binary", async () => {
    await expect(
      launchExternalWindow(connection(), { pathEnv: dir, log: () => {} }),
    ).rejects.toThrow(/RDP client not found/);
    await expect(
      launchExternalWindow(connection({ protocol: "vnc" }), { pathEnv: dir, log: () => {} }),
    ).rejects.toThrow(/No VNC client was found/);
  });

  it("refuses protocols that have no external window", async () => {
    await expect(
      launchExternalWindow(connection({ protocol: "ssh" }), { pathEnv: dir }),
    ).rejects.toThrow(/does not open an external window/);
  });

  it("pipes the RDP password on stdin and keeps it out of argv", async () => {
    const capture = path.join(dir, "rdp-capture");
    writeFileSync(
      path.join(dir, "xfreerdp3"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}.argv"\ncat > "${capture}.stdin"\n`,
      { mode: 0o755 },
    );
    const conn = connection({
      port: 3390,
      secretRefs: { passwordSecret: "connections/conn_1/password" },
    });

    const result = await launchExternalWindow(conn, {
      vault: { get: async () => "hunter2" },
      pathEnv: dir,
      runDirBase: dir,
      log: () => {},
    });

    expect(result.protocol).toBe("rdp");
    expect(result.binary).toBe("xfreerdp3");
    expect(result.pid).toBeGreaterThan(0);

    await waitForFile(`${capture}.stdin`);
    const argv = readFileSync(`${capture}.argv`, "utf8");
    expect(argv).toContain("/v:10.0.0.7:3390");
    expect(argv).toContain("/from-stdin:force");
    expect(argv).not.toContain("hunter2");
    expect(readFileSync(`${capture}.stdin`, "utf8").trim()).toBe("hunter2");
  });

  it("gives FreeRDP no password pipe when the connection has none", async () => {
    const capture = path.join(dir, "rdp-nopass");
    writeFileSync(
      path.join(dir, "xfreerdp3"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}.argv"\nprintf '' > "${capture}.stdin"\n`,
      { mode: 0o755 },
    );

    await launchExternalWindow(connection(), { pathEnv: dir, runDirBase: dir, log: () => {} });
    await waitForFile(`${capture}.argv`);
    const argv = readFileSync(`${capture}.argv`, "utf8");
    expect(argv).not.toContain("/from-stdin:force");
  });

  it("passes the VNC password as a vncpasswd file and removes it with the run dir", async () => {
    const capture = path.join(dir, "vnc-capture");
    // vncpasswd -f: password on stdin, obfuscated bytes on stdout.
    writeFileSync(path.join(dir, "vncpasswd"), "#!/bin/sh\ncat", { mode: 0o755 });
    // The shared `vncviewer` name is fingerprinted by its version output, so
    // the fake answers the probe and records the real launch argv otherwise.
    writeFileSync(
      path.join(dir, "vncviewer"),
      `#!/bin/sh\ncase "$1" in\n  --version|-version|-v) echo "TigerVNC Viewer 1.13.90"; exit 0;;\nesac\nprintf '%s\\n' "$@" > "${capture}.argv"\n`,
      { mode: 0o755 },
    );
    const conn = connection({
      protocol: "vnc",
      port: 5901,
      secretRefs: { passwordSecret: "connections/conn_1/password" },
    });

    const result = await launchExternalWindow(conn, {
      vault: { get: async () => "vnc-pass" },
      pathEnv: dir,
      runDirBase: dir,
      log: () => {},
    });

    expect(result.binary).toBe("vncviewer");
    await waitForFile(`${capture}.argv`);
    const argv = readFileSync(`${capture}.argv`, "utf8").split("\n");
    expect(argv[0]).toBe("10.0.0.7::5901");
    const passwdFlag = argv.indexOf("-passwd");
    expect(passwdFlag).toBeGreaterThan(0);
    const passwdFile = argv[passwdFlag + 1];
    // The password itself never appears in argv…
    expect(argv.join("\n")).not.toContain("vnc-pass");
    // …and the run directory (with the passwd file) is removed once the
    // window exits.
    await waitForRemoval(path.dirname(passwdFile));
    expect(existsSync(passwdFile)).toBe(false);
  });
});
