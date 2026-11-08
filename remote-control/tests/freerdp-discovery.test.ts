// FreeRDP discovery (stage 0.27.11, E1): binary resolution order, the
// FreeRDP 3 gate and the version-probe cache. Fake clients in a temp PATH keep
// the tests independent of what the developer machine has installed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RDP_BINARY_ENV,
  clearRdpDiscoveryCache,
  discoverRdpClient,
  freerdpMajor,
  rdpBinaryCandidates,
} from "../server/protocols/freerdp";

/** Writes a fake client that answers `--version` and otherwise exits 0. */
function fakeClient(dir: string, name: string, version: string | null): string {
  const body =
    version === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexit 0\n`;
  const file = path.join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  return file;
}

describe("rdpBinaryCandidates", () => {
  it("prefers the Wayland client when a Wayland display is in play", () => {
    expect(rdpBinaryCandidates({})).toEqual(["xfreerdp3", "wlfreerdp3", "xfreerdp"]);
    expect(rdpBinaryCandidates({ WAYLAND_DISPLAY: "wayland-0" })).toEqual([
      "wlfreerdp3",
      "xfreerdp3",
      "xfreerdp",
    ]);
  });
});

describe("freerdpMajor", () => {
  it("reads the major version and returns null when unknown", () => {
    expect(freerdpMajor("This is FreeRDP version 3.15.0 (n/a)")).toBe(3);
    expect(freerdpMajor("This is FreeRDP version 2.11.7")).toBe(2);
    expect(freerdpMajor("some wrapper")).toBeNull();
    expect(freerdpMajor(null)).toBeNull();
  });
});

describe("discoverRdpClient", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-freerdp-"));
    clearRdpDiscoveryCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("picks the display-server candidate from PATH", () => {
    fakeClient(dir, "xfreerdp3", "This is FreeRDP version 3.15.0 (n/a)");
    fakeClient(dir, "wlfreerdp3", "This is FreeRDP version 3.15.0 (n/a)");

    expect(discoverRdpClient({ pathEnv: dir, env: {} }).binary).toBe(path.join(dir, "xfreerdp3"));
    expect(discoverRdpClient({ pathEnv: dir, env: { WAYLAND_DISPLAY: "wayland-0" } }).binary).toBe(
      path.join(dir, "wlfreerdp3"),
    );
  });

  it(`honours ${RDP_BINARY_ENV} over PATH discovery`, () => {
    fakeClient(dir, "xfreerdp3", "This is FreeRDP version 3.15.0 (n/a)");
    const explicit = fakeClient(dir, "custom-client", "This is FreeRDP version 3.9.0 (n/a)");

    const found = discoverRdpClient({
      pathEnv: dir,
      env: { [RDP_BINARY_ENV]: explicit },
    });
    expect(found.binary).toBe(explicit);
    expect(found.source).toBe("env");
  });

  it("lets the explicit plugin setting win over the environment", () => {
    fakeClient(dir, "xfreerdp3", "This is FreeRDP version 3.15.0 (n/a)");
    const fromEnv = fakeClient(dir, "env-client", "This is FreeRDP version 3.15.0 (n/a)");
    const fromSettings = fakeClient(dir, "settings-client", "This is FreeRDP version 3.14.0 (n/a)");

    const found = discoverRdpClient({
      pathEnv: dir,
      env: { [RDP_BINARY_ENV]: fromEnv },
      binary: fromSettings,
    });
    expect(found.binary).toBe(fromSettings);
    expect(found.source).toBe("settings");
  });

  it("refuses an override that is not executable", () => {
    expect(() =>
      discoverRdpClient({ pathEnv: "", env: { [RDP_BINARY_ENV]: path.join(dir, "missing") } }),
    ).toThrow(/not executable/);
  });

  it("refuses a FreeRDP 2 client with an actionable message", () => {
    fakeClient(dir, "xfreerdp", "This is FreeRDP version 2.11.7");

    expect(() => discoverRdpClient({ pathEnv: dir, env: {} })).toThrow(/FreeRDP 2/);
    expect(() => discoverRdpClient({ pathEnv: dir, env: {} })).toThrow(new RegExp(RDP_BINARY_ENV));
  });

  it("skips a v2 name when a genuine FreeRDP 3 client exists", () => {
    fakeClient(dir, "xfreerdp", "This is FreeRDP version 2.11.7");
    fakeClient(dir, "xfreerdp3", "This is FreeRDP version 3.15.0 (n/a)");

    expect(discoverRdpClient({ pathEnv: dir, env: {} }).binary).toBe(path.join(dir, "xfreerdp3"));
  });

  it("accepts an unprobeable client whose name carries the 3 suffix", () => {
    fakeClient(dir, "xfreerdp3", null);

    const found = discoverRdpClient({ pathEnv: dir, env: {} });
    expect(found.binary).toBe(path.join(dir, "xfreerdp3"));
    expect(found.version).toBeNull();
  });

  it("lists the candidates when nothing is installed", () => {
    expect(() => discoverRdpClient({ pathEnv: dir, env: {} })).toThrow(/RDP client not found/);
    expect(() => discoverRdpClient({ pathEnv: dir, env: {} })).toThrow(/wlfreerdp3/);
  });

  it("caches the version probe for the TTL", () => {
    fakeClient(dir, "xfreerdp3", "This is FreeRDP version 3.15.0 (n/a)");
    let probes = 0;
    const probe = (): string => {
      probes += 1;
      return "This is FreeRDP version 3.15.0 (n/a)";
    };

    discoverRdpClient({ pathEnv: dir, env: {}, probe });
    discoverRdpClient({ pathEnv: dir, env: {}, probe });
    expect(probes).toBe(1);

    discoverRdpClient({ pathEnv: dir, env: {}, probe, useCache: false });
    expect(probes).toBe(2);
  });
});
