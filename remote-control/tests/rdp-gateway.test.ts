// RD Gateway (stage 0.29.11, stage E3): the `/gateway:` argv option, the
// second stdin line FreeRDP reads for a gateway password, the refusal when that
// password cannot be delivered safely, and the secret storage contract (a
// gateway password is a vault entry, never a payload field or argv).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../shared/connections";
import { validatePayload } from "../shared/protocols";
import { ConsoleHttpServer } from "../server/http-server";
import { Store } from "../server/store";
import { VaultService } from "../server/vault";
import {
  buildRdpArgs,
  gatewayNeedsSeparateCredentials,
  rdpGatewayOption,
  rdpStdinPayload,
} from "../server/protocols/freerdp";
import { launchExternalWindow } from "../server/protocols/external";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_gw",
    groupId: null,
    name: "gateway-box",
    protocol: "rdp",
    host: "10.0.0.9",
    port: 3389,
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

describe("gateway argv", () => {
  it("emits the CSV sub-options in FreeRDP's order and no password", () => {
    const conn = connection({
      payload: {
        gatewayHost: "rdp.example.com",
        gatewayPort: 443,
        gatewayUser: "gw-user",
        gatewayDomain: "CORP",
        gatewayUsageMethod: "direct",
      },
    });
    expect(rdpGatewayOption(conn)).toBe(
      "/gateway:g:rdp.example.com:443,u:gw-user,d:CORP,usage-method:direct",
    );

    const args = buildRdpArgs(conn);
    const option = args.find((arg) => arg.startsWith("/gateway:"))!;
    expect(option).toBe("/gateway:g:rdp.example.com:443,u:gw-user,d:CORP,usage-method:direct");
    // rdp-pilot's group order: security, gateway, keyboard.
    expect(args.indexOf("/cert:ignore")).toBeLessThan(args.indexOf(option));
    // No secret shape is ever emitted.
    expect(args.join(" ")).not.toContain("p:");
  });

  it("omits the option entirely when no gateway host is set", () => {
    expect(rdpGatewayOption(connection())).toBeNull();
    expect(buildRdpArgs(connection()).some((arg) => arg.startsWith("/gateway:"))).toBe(false);
  });

  it("quotes CSV values and brackets IPv6 hosts", () => {
    const conn = connection({
      payload: { gatewayHost: "fe80::1", gatewayPort: 8443, gatewayDomain: "AC ME" },
    });
    expect(rdpGatewayOption(conn)).toBe('/gateway:g:[fe80::1]:8443,d:"AC ME"');
  });

  it("detects when the gateway needs its own login", () => {
    expect(gatewayNeedsSeparateCredentials(connection({ payload: {} }))).toBe(false);
    expect(gatewayNeedsSeparateCredentials(connection({ payload: { gatewayHost: "gw" } }))).toBe(false);
    expect(
      gatewayNeedsSeparateCredentials(connection({ payload: { gatewayHost: "gw", gatewayUser: "u" } })),
    ).toBe(true);
    expect(
      gatewayNeedsSeparateCredentials(connection({ payload: { gatewayHost: "gw", gatewayDomain: "CORP" } })),
    ).toBe(true);
  });
});

describe("gateway stdin contract", () => {
  it("sends the target password first and the gateway password second", () => {
    expect(
      rdpStdinPayload({ password: "target-pass", gatewayPassword: "gw-pass", gatewaySeparate: true }),
    ).toBe("target-pass\ngw-pass\n");
  });

  it("sends one line when the gateway reuses the connection credentials", () => {
    expect(
      rdpStdinPayload({ password: "target-pass", gatewayPassword: null, gatewaySeparate: false }),
    ).toBe("target-pass\n");
  });

  it("sends nothing without a target password", () => {
    expect(rdpStdinPayload({ password: null, gatewayPassword: "gw-pass", gatewaySeparate: true })).toBeNull();
  });
});

describe("gateway schema", () => {
  it("accepts the gateway fields and rejects a bad port or usage method", () => {
    const payload = validatePayload("rdp", {
      gatewayHost: "gw",
      gatewayPort: 443,
      gatewayUser: "u",
      gatewayDomain: "D",
      gatewayUsageMethod: "detect",
    });
    expect(payload).toMatchObject({ gatewayPort: 443, gatewayUsageMethod: "detect" });

    expect(() => validatePayload("rdp", { gatewayPort: 70000 })).toThrow(/gatewayPort/);
    expect(() => validatePayload("rdp", { gatewayPort: "443" })).toThrow(/gatewayPort/);
    expect(() => validatePayload("rdp", { gatewayUsageMethod: "sideways" })).toThrow(/gatewayUsageMethod/);
  });

});

describe("gateway launch", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-gateway-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeClient(capture: string): void {
    writeFileSync(
      path.join(dir, "xfreerdp3"),
      "#!/bin/sh\n" +
        'if [ "$1" = "--version" ]; then echo "This is FreeRDP version 3.15.0 (n/a)"; exit 0; fi\n' +
        `printf '%s\\n' "$@" > "${capture}.argv"\n` +
        `cat > "${capture}.stdin.tmp" && mv "${capture}.stdin.tmp" "${capture}.stdin"\n`,
      { mode: 0o755 },
    );
  }

  it("pipes both passwords for a gateway with its own login", async () => {
    const capture = path.join(dir, "gw");
    fakeClient(capture);
    const conn = connection({
      payload: { gatewayHost: "gw.example.com:443", gatewayUser: "gw-user" },
      secretRefs: {
        passwordSecret: "connections/conn_gw/password",
        gatewayPasswordSecret: "connections/conn_gw/gateway-password",
      },
    });
    const vault = {
      get: async (name: string) => (name.endsWith("gateway-password") ? "gw-secret" : "target-secret"),
    };

    const result = await launchExternalWindow(conn, { vault, pathEnv: dir, log: () => {} });
    await waitForFile(`${capture}.stdin`);

    const stdin = readFileSync(`${capture}.stdin`, "utf8");
    expect(stdin).toBe("target-secret\ngw-secret\n");
    const argv = readFileSync(`${capture}.argv`, "utf8");
    expect(argv.split("\n")[0]).toBe("/from-stdin:force");
    expect(argv).toContain("/gateway:g:gw.example.com:443,u:gw-user");
    expect(argv).not.toContain("gw-secret");
    expect(argv).not.toContain("target-secret");
    expect(result.binary).toBe("xfreerdp3");
  });

  it("pipes one line when the gateway reuses the connection credentials", async () => {
    const capture = path.join(dir, "same");
    fakeClient(capture);
    const conn = connection({
      payload: { gatewayHost: "gw.example.com" },
      secretRefs: { passwordSecret: "connections/conn_gw/password" },
    });

    await launchExternalWindow(conn, {
      vault: { get: async () => "target-secret" },
      pathEnv: dir,
      log: () => {},
    });
    await waitForFile(`${capture}.stdin`);
    expect(readFileSync(`${capture}.stdin`, "utf8")).toBe("target-secret\n");
    expect(readFileSync(`${capture}.argv`, "utf8")).toContain("/gateway:g:gw.example.com");
  });

  it("refuses a separate gateway login without a stored gateway password", async () => {
    fakeClient(path.join(dir, "refuse"));
    const conn = connection({
      payload: { gatewayHost: "gw", gatewayUser: "gw-user" },
      secretRefs: { passwordSecret: "connections/conn_gw/password" },
    });

    await expect(
      launchExternalWindow(conn, { vault: { get: async () => "target-secret" }, pathEnv: dir }),
    ).rejects.toThrow(/no stored gateway password/);
  });

  it("refuses a gateway password that cannot follow a missing connection password", async () => {
    fakeClient(path.join(dir, "nopass"));
    const conn = connection({
      payload: { gatewayHost: "gw", gatewayUser: "gw-user" },
      secretRefs: { gatewayPasswordSecret: "connections/conn_gw/gateway-password" },
    });

    await expect(
      launchExternalWindow(conn, { vault: { get: async () => "gw-secret" }, pathEnv: dir }),
    ).rejects.toThrow(/no stored password/);
  });
});

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

const describeIfGpg = gpgAvailable ? describe : describe.skip;

// The gateway password is a second secret: stored in the vault, referenced by
// name, cleared like the connection password, and never part of the payload.
describeIfGpg("gateway password over HTTP (gpg available)", () => {
  const TOKEN = "test-token";
  let dir: string;
  let store: Store;
  let vault: VaultService;
  let server: ConsoleHttpServer;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-gw-http-"));
    store = new Store({ dbPath: path.join(dir, "rc.db") });
    vault = new VaultService({ paseoHome: path.join(dir, "home"), autoLockMs: 0, log: () => {} });
    await vault.setup("master-pass");
    await vault.unlock("master-pass");
    server = new ConsoleHttpServer({ token: TOKEN, port: 0, store, vault });
    await server.start();
    base = server.origin!;
  });

  afterAll(async () => {
    await server?.stop();
    store?.close();
    vault?.lock();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the gateway password in the vault and scrubs it from the payload", async () => {
    const res = await fetch(`${base}/api/connections?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "gated",
        protocol: "rdp",
        host: "10.0.0.11",
        username: "alice",
        password: "target-secret",
        gatewayPassword: "gateway-secret",
        payload: {
          gatewayHost: "gw.example.com",
          gatewayUser: "gw-user",
          // A client that puts the password into the payload must not get it
          // written to the database.
          gatewayPassword: "payload-leak",
        },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()).connection;

    expect(created.payload).not.toHaveProperty("gatewayPassword");
    expect(created.payload.gatewayHost).toBe("gw.example.com");
    expect(created.secretRefs.gatewayPasswordSecret).toBe(
      `connections/${created.id}/gateway-password`,
    );
    await expect(vault.get(created.secretRefs.gatewayPasswordSecret)).resolves.toBe("gateway-secret");
    expect(JSON.stringify(created)).not.toContain("gateway-secret");
    expect(JSON.stringify(created)).not.toContain("payload-leak");

    // A PATCH with an empty value clears the stored gateway password.
    const patched = await fetch(`${base}/api/connections/${created.id}?token=${TOKEN}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gatewayPassword: "" }),
    });
    expect(patched.status).toBe(200);
    const updated = (await patched.json()).connection;
    expect(updated.secretRefs.gatewayPasswordSecret).toBeUndefined();
    await expect(vault.get(`connections/${created.id}/gateway-password`)).rejects.toThrow();
  });

  it("keeps an existing gateway password when the field is absent", async () => {
    const res = await fetch(`${base}/api/connections?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "gated-2",
        protocol: "rdp",
        host: "10.0.0.12",
        password: "target-secret",
        gatewayPassword: "gateway-secret-2",
        payload: { gatewayHost: "gw2.example.com", gatewayDomain: "CORP" },
      }),
    });
    const created = (await res.json()).connection;
    const patched = await fetch(`${base}/api/connections/${created.id}?token=${TOKEN}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gated-2 renamed" }),
    });
    const updated = (await patched.json()).connection;
    expect(updated.secretRefs.gatewayPasswordSecret).toBe(created.secretRefs.gatewayPasswordSecret);
  });
});
