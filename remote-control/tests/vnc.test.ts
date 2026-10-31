// VNC launcher (stage 0.23.10) — the port of vnc-pilot's discovery, per-viewer
// argv builders, target formatting and password file handling.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../shared/connections";
import {
  buildVncClientArgs,
  discoverVncClients,
  resetVncDiscoveryCache,
  resolveVncClient,
  splitExtraArgs,
  splitHostPort,
  truncateVncPassword,
  validateVncHost,
  vncPort,
  vncTarget,
  vncUri,
  writeVncPasswdFile,
} from "../server/protocols/vnc";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    groupId: null,
    name: "desktop",
    protocol: "vnc",
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

const TIGER = { clientId: "tigervnc" as const, binary: "/usr/bin/vncviewer", displayName: "TigerVNC" };
const TURBO = { clientId: "turbovnc" as const, binary: "/usr/bin/vncviewer", displayName: "TurboVNC" };
const REMMINA = { clientId: "remmina" as const, binary: "/usr/bin/remmina", displayName: "Remmina" };

describe("vnc target formatting", () => {
  it("defaults to the raw-port form on 5900", () => {
    expect(vncPort(connection())).toBe(5900);
    expect(vncTarget(connection())).toBe("10.0.0.7::5900");
    expect(vncUri(connection())).toBe("vnc://10.0.0.7:5900");
  });

  it("uses the connection port and strips an embedded host:port", () => {
    expect(vncTarget(connection({ port: 5901 }))).toBe("10.0.0.7::5901");
    const embedded = connection({ host: "10.0.0.7:5905", port: 5901 });
    expect(splitHostPort(embedded.host)).toEqual(["10.0.0.7", 5905]);
    expect(vncPort(embedded)).toBe(5905);
    // The embedded port must not be repeated twice in the target.
    expect(vncTarget(embedded)).toBe("10.0.0.7::5905");
  });

  it("lets a display number win over every port source", () => {
    const conn = connection({ host: "10.0.0.7:5905", port: 5901, payload: { display: 2 } });
    expect(vncPort(conn)).toBe(5902);
    expect(vncTarget(conn)).toBe("10.0.0.7:2");
    expect(vncUri(conn)).toBe("vnc://10.0.0.7:5902");
  });

  it("brackets IPv6 literals", () => {
    const conn = connection({ host: "fd00::7", port: 5901 });
    expect(vncTarget(conn)).toBe("[fd00::7]::5901");
    const bracketed = connection({ host: "[fd00::7]:5902" });
    expect(vncTarget(bracketed)).toBe("[fd00::7]::5902");
  });

  it("validates hosts the way vnc-pilot does", () => {
    expect(validateVncHost("")).toMatch(/required/);
    expect(validateVncHost("-host")).toMatch(/must not start with/);
    expect(validateVncHost("two words")).toMatch(/whitespace/);
    expect(validateVncHost("10.0.0.7")).toBeNull();
  });
});

describe("splitExtraArgs", () => {
  it("splits with quotes and escapes, and passes arrays through", () => {
    expect(splitExtraArgs("-via user@gateway -FullScreen")).toEqual(["-via", "user@gateway", "-FullScreen"]);
    expect(splitExtraArgs('a "b c" d')).toEqual(["a", "b c", "d"]);
    expect(splitExtraArgs(["x", "y"])).toEqual(["x", "y"]);
    expect(splitExtraArgs(null)).toEqual([]);
  });
});

describe("VNC discovery", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-vnc-"));
    resetVncDiscoveryCache();
  });

  afterEach(() => {
    resetVncDiscoveryCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const fake = (name: string, version: string): void => {
    writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\ncase "$1" in\n  --version|-version|-help|-v) echo "${version}"; exit 0;;\nesac\nexit 0\n`,
      { mode: 0o755 },
    );
  };

  it("fingerprints the shared vncviewer name", async () => {
    fake("vncviewer", "TigerVNC Viewer 1.13.90");
    const clients = await discoverVncClients({ pathEnv: dir, useCache: false });
    expect(clients.map((c) => c.clientId)).toEqual(["tigervnc"]);
  });

  it("recognises TurboVNC through the same binary name", async () => {
    fake("vncviewer", "TurboVNC Viewer 3.1");
    const clients = await discoverVncClients({ pathEnv: dir, useCache: false });
    expect(clients.map((c) => c.clientId)).toEqual(["turbovnc"]);
  });

  it("refuses an un-fingerprinted shared binary", async () => {
    fake("vncviewer", "some unknown viewer");
    expect(await discoverVncClients({ pathEnv: dir, useCache: false })).toEqual([]);
  });

  it("discovers dedicated binaries without a version scan", async () => {
    fake("remmina", "Remmina 1.4.35");
    fake("krdc", "");
    const clients = await discoverVncClients({ pathEnv: dir, useCache: false });
    expect(clients.map((c) => c.clientId)).toEqual(["remmina", "krdc"]);
  });

  it("keeps the preference order regardless of PATH order", async () => {
    fake("remmina", "Remmina 1.4.35");
    fake("vncviewer", "TightVNC Viewer 1.3.10");
    const clients = await discoverVncClients({ pathEnv: dir, useCache: false });
    expect(clients.map((c) => c.clientId)).toEqual(["tightvnc", "remmina"]);
  });

  it("resolves a custom binary path and reports a bad one", async () => {
    fake("myviewer", "no markers needed");
    const ok = await resolveVncClient(
      connection({ payload: { customBinary: path.join(dir, "myviewer") } }),
      { pathEnv: dir, useCache: false },
    );
    expect(ok.clientId).toBe("custom");
    expect(ok.binary).toBe(path.join(dir, "myviewer"));
    await expect(
      resolveVncClient(connection({ payload: { customBinary: path.join(dir, "missing") } }), {
        pathEnv: dir,
        useCache: false,
      }),
    ).rejects.toThrow(/does not exist or is not executable/);
  });

  it("reports a client the user picked but that is not installed", async () => {
    fake("vncviewer", "TigerVNC Viewer 1.13.90");
    await expect(
      resolveVncClient(connection({ payload: { vncClient: "realvnc" } }), { pathEnv: dir, useCache: false }),
    ).rejects.toThrow(/is not installed/);
  });
});

describe("buildVncClientArgs", () => {
  it("builds TigerVNC flags including the password file", () => {
    const args = buildVncClientArgs(
      TIGER,
      connection({
        port: 5901,
        payload: {
          viewOnly: true,
          fullscreen: true,
          encoding: "Tight",
          quality: "7",
          compress: "2",
          colorDepth: "24",
          tigervncGeometry: "1280x720",
          acceptClipboard: false,
          sendClipboard: false,
          extraArgs: ["-via", "user@gateway"],
        },
      }),
      { passwordFile: "/run/x/vnc.passwd" },
    );
    expect(args[0]).toBe("10.0.0.7::5901");
    for (const flag of ["-ViewOnly", "-FullScreen", "-Shared", "-PreferredEncoding", "-QualityLevel", "-CompressLevel", "-FullColor", "-geometry", "-AcceptClipboard=0", "-SendClipboard=0", "-passwd"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("-PreferredEncoding") + 1]).toBe("Tight");
    expect(args[args.indexOf("-via") + 1]).toBe("user@gateway");
    expect(args[args.indexOf("-passwd") + 1]).toBe("/run/x/vnc.passwd");
  });

  it("maps TurboVNC JPEG quality and colour counts", () => {
    const args = buildVncClientArgs(
      TURBO,
      connection({ payload: { quality: "8", encoding: "Tight", colorDepth: "16", turbovncJpeg: true, turbovncLocal: false } }),
    );
    expect(args).toContain("-Encoding");
    expect(args[args.indexOf("-Quality") + 1]).toBe("85");
    expect(args[args.indexOf("-Colors") + 1]).toBe("65536");
    expect(args).toContain("-JPEG=1");
    expect(args).toContain("-LocalCursor=0");
  });

  it("builds Remmina argv from a temporary profile", () => {
    expect(buildVncClientArgs(REMMINA, connection(), { profileFile: "/run/x/p.remmina" })).toEqual([
      "--connect",
      "/run/x/p.remmina",
    ]);
    expect(buildVncClientArgs(REMMINA, connection({ port: 5902 }))).toEqual(["-c", "vnc://10.0.0.7:5902"]);
  });

  it("builds URI-based and raw clients", () => {
    const krdc = { clientId: "krdc" as const, binary: "/usr/bin/krdc", displayName: "KRDC" };
    expect(buildVncClientArgs(krdc, connection({ payload: { fullscreen: true } }))).toEqual([
      "vnc://10.0.0.7:5900",
      "-f",
    ]);
    const gvnc = { clientId: "gvncviewer" as const, binary: "/usr/bin/gvncviewer", displayName: "gvncviewer" };
    expect(buildVncClientArgs(gvnc, connection())).toEqual(["10.0.0.7::5900"]);
  });
});

describe("VNC password material", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-vncpw-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("truncates to the protocol's 8 characters", () => {
    expect(truncateVncPassword("short")).toBe("short");
    expect(truncateVncPassword("1234567890")).toBe("12345678");
  });

  it("writes the vncpasswd output as a 0600 file", async () => {
    const vncpasswd = path.join(dir, "vncpasswd");
    writeFileSync(vncpasswd, "#!/bin/sh\ncat", { mode: 0o755 });
    chmodSync(vncpasswd, 0o755);
    const runDir = path.join(dir, "run");
    const file = await writeVncPasswdFile(vncpasswd, "1234567890", runDir);
    expect(file).toBe(path.join(runDir, "vnc.passwd"));
    expect(readFileSync(file, "utf8")).toBe("12345678\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(true);
  });

  it("fails when vncpasswd fails instead of writing a bogus file", async () => {
    const vncpasswd = path.join(dir, "vncpasswd");
    writeFileSync(vncpasswd, "#!/bin/sh\necho boom >&2\nexit 1\n", { mode: 0o755 });
    await expect(writeVncPasswdFile(vncpasswd, "secret", path.join(dir, "run"))).rejects.toThrow(/boom/);
  });
});
