// RDP connection creation (stage 0.22.10): the payload schema the REST layer
// validates against and the FreeRDP 3 argv that payload produces.
//
// - schema: the full rdp-pilot option set accepted, unknown keys
//   (`payload.auth` written by the connection test) preserved, out-of-range
//   choices rejected with the offending field named,
// - argv: group order and per-option syntax ported from rdp-pilot's
//   tests/test_rdp_pilot.py; a legacy row without payload keeps its old
//   argv, so creation support cannot break pre-existing connections,
// - FreeRDP 2 conversion branches must not exist at all (plan E1),
// - REST: POST/PATCH reject a bad payload with 400 and store nothing.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "../shared/connections";
import { RDP_PAYLOAD_DEFAULTS } from "../shared/rdp-fields";
import { validatePayload } from "../shared/protocols";
import { buildRdpArgs, rdpCsvValue, rdpTarget } from "../server/protocols/external";
import { ConsoleHttpServer } from "../server/http-server";
import { Store } from "../server/store";

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

describe("rdp payload schema", () => {
  it("accepts the full option set and preserves unknown keys", () => {
    const payload = validatePayload("rdp", {
      ...RDP_PAYLOAD_DEFAULTS,
      domain: "CORP",
      workarea: true,
      multimon: true,
      gdi: "sw",
      serial: "/dev/ttyUSB0",
      sec: "tls",
      certIgnore: true,
      certName: "srv01.corp",
      kbdLayout: "0x409",
      kbdType: "8",
      network: "lan",
      jpegQuality: "75",
      extraArgs: ["/dynamic-resolution"],
      auth: "password", // written by the connection test — must survive
    });
    expect(payload.sec).toBe("tls");
    expect(payload.kbdType).toBe("8");
    expect(payload.jpegQuality).toBe("75");
    expect(payload.auth).toBe("password");
    expect(payload.extraArgs).toEqual(["/dynamic-resolution"]);
  });

  it("rejects out-of-range choices naming the field", () => {
    expect(() => validatePayload("rdp", { bpp: "64" })).toThrow(/bpp/);
    expect(() => validatePayload("rdp", { sec: "wide-open" })).toThrow(/sec/);
    expect(() => validatePayload("rdp", { jpegQuality: "101" })).toThrow(/jpegQuality/);
    expect(() => validatePayload("rdp", { sound: "3" })).toThrow(/sound/);
    expect(() => validatePayload("rdp", { width: 12.5 })).toThrow(/width/);
    expect(() => validatePayload("rdp", "not an object")).toThrow(/payload must be an object/);
    expect(() => validatePayload("smtp", {})).toThrow(/unknown protocol/);
  });

  it("keeps the ssh auth flag (loose schemas)", () => {
    expect(validatePayload("ssh", { auth: "key" })).toEqual({ auth: "key" });
    expect(validatePayload("rdp", {})).toEqual({});
  });
});

describe("buildRdpArgs — full FreeRDP 3 option set", () => {
  it("emits every group in the rdp-pilot order", () => {
    const args = buildRdpArgs(
      connection({
        payload: {
          domain: "CORP",
          width: 1920,
          height: 1080,
          fullscreen: false,
          dynamicResolution: true,
          bpp: "24",
          workarea: true,
          multimon: true,
          fonts: true,
          aero: true,
          windowDrag: true,
          menuAnims: true,
          themes: true,
          wallpaper: false,
          gdi: "sw",
          clipboard: true,
          drives: true,
          homeDrive: true,
          printers: true,
          smartcards: true,
          serial: "/dev/ttyUSB0",
          sound: "0",
          microphone: true,
          sec: "tls",
          certIgnore: true,
          certName: "srv01.corp",
          kbdLayout: "0x409",
          kbdType: "8",
          network: "lan",
          compression: false,
          rfx: true,
          nsc: true,
          jpeg: true,
          jpegQuality: "75",
        },
      }),
    );
    expect(args).toEqual([
      "/v:10.0.0.7:3389",
      "/u:alice",
      "/t:desktop",
      "/d:CORP",
      "+dynamic-resolution",
      "/size:1920x1080",
      "/bpp:24",
      "/workarea",
      "/multimon",
      "+fonts",
      "+aero",
      "+window-drag",
      "+menu-anims",
      "+themes",
      "-wallpaper",
      "/gdi:sw",
      "+clipboard",
      "+drives",
      "+home-drive",
      "/printer",
      "/smartcard",
      "/serial:/dev/ttyUSB0",
      "/sound",
      "/audio-mode:0",
      "/microphone",
      "/sec:tls",
      "/cert:ignore",
      "/cert:name:srv01.corp",
      "/kbd:layout:0x409,type:8",
      "/network:lan",
      "-compression",
      "/rfx",
      "/nsc",
      "/jpeg",
      "/jpeg-quality:75",
    ]);
  });

  it("keeps a legacy row (empty payload) on its previous argv", () => {
    const args = buildRdpArgs(connection());
    expect(args).toEqual(["/v:10.0.0.7:3389", "/u:alice", "/t:desktop", "/cert:ignore"]);
  });

  it("brackets IPv6 literals in the target", () => {
    const conn = connection({ host: "fe80::1" });
    expect(rdpTarget(conn)).toBe("[fe80::1]:3389");
    expect(buildRdpArgs(conn)[0]).toBe("/v:[fe80::1]:3389");
    expect(rdpTarget(connection({ host: "10.0.0.7" }))).toBe("10.0.0.7:3389");
  });

  it("honours an explicit cert, and skips /cert:ignore when the user opts out", () => {
    expect(buildRdpArgs(connection({ payload: { cert: "tofu" } }))).toContain("/cert:tofu");
    expect(buildRdpArgs(connection({ payload: { cert: "tofu" } }))).not.toContain("/cert:ignore");
    const strict = buildRdpArgs(connection({ payload: { certIgnore: false } }));
    expect(strict).not.toContain("/cert:ignore");
  });

  it("quotes only the CSV-parsed /kbd: values", () => {
    expect(rdpCsvValue("US")).toBe("US");
    expect(rdpCsvValue("0x409")).toBe("0x409");
    expect(rdpCsvValue("a b")).toBe('"a b"');
    expect(rdpCsvValue('say "hi"')).toBe('"say \\"hi\\""');
    const args = buildRdpArgs(connection({ payload: { kbdLayout: "US Dvorak" } }));
    expect(args).toContain('/kbd:layout:"US Dvorak"');
    // plain scalar options stay verbatim — quotes would become part of them
    expect(buildRdpArgs(connection({ payload: { domain: "C ORP" } }))).toContain("/d:C ORP");
  });

  it("omits /sound for audio-mode 2 and prefixes piped passwords", () => {
    const muted = buildRdpArgs(connection({ payload: { sound: "2" } }));
    expect(muted).not.toContain("/sound");
    expect(muted).toContain("/audio-mode:2");
    const piped = buildRdpArgs(connection(), { withPassword: true });
    expect(piped[0]).toBe("/from-stdin:force");
    expect(piped.join(" ")).not.toContain("/p:");
  });
});

describe("FreeRDP 2 conversion branches are absent", () => {
  it("contains only FreeRDP 3 option syntax", () => {
    const source = readFileSync(
      new URL("../server/protocols/external.ts", import.meta.url),
      "utf8",
    );
    // v2 forms rdp-pilot converts to when it detects FreeRDP 2 (plan E1:
    // the port is FreeRDP 3 only, so no branch may survive).
    for (const v2 of ["/cert-ignore", "/cert-name:", "/kbd-type:", "/gu:", "/gp:", "flatpak-spawn"]) {
      expect(source).not.toContain(v2);
    }
    for (const v3 of ["/cert:ignore", "/cert:name:", "/kbd:", "/audio-mode:"]) {
      expect(source).toContain(v3);
    }
  });
});

describe("REST payload validation", () => {
  const TOKEN = "test-token";
  let dir: string;
  let store: Store;
  let server: ConsoleHttpServer;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-control-rdp-"));
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

  async function request(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${route}?token=${TOKEN}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it("creates an RDP connection with its options and rejects bad ones", async () => {
    const created = await request("POST", "/api/connections", {
      name: "win10",
      protocol: "rdp",
      host: "10.0.0.7",
      port: 3389,
      username: "alice",
      payload: { ...RDP_PAYLOAD_DEFAULTS, domain: "CORP", sec: "nla" },
    });
    expect(created.status).toBe(201);
    expect(created.body.connection.payload.sec).toBe("nla");
    expect(created.body.connection.payload.domain).toBe("CORP");

    const bad = await request("POST", "/api/connections", {
      name: "broken",
      protocol: "rdp",
      host: "10.0.0.8",
      payload: { bpp: "64" },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/bpp/);
    // the rejected create must not leave a row behind
    const list = await request("GET", "/api/connections");
    expect(list.body.connections).toHaveLength(1);

    const badPatch = await request("PATCH", `/api/connections/${created.body.connection.id}`, {
      payload: { sec: "wide-open" },
    });
    expect(badPatch.status).toBe(400);
    const after = await request("GET", `/api/connections/${created.body.connection.id}`);
    expect(after.body.connection.payload.sec).toBe("nla");
  });

  it("keeps the ssh auth flag through a payload patch", async () => {
    const created = await request("POST", "/api/connections", {
      name: "router",
      protocol: "ssh",
      host: "omnirouter",
      port: 2222,
      username: "root",
    });
    expect(created.status).toBe(201);
    const patched = await request("PATCH", `/api/connections/${created.body.connection.id}`, {
      payload: { auth: "key" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.connection.payload.auth).toBe("key");
  });
});
