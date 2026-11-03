import { describe, expect, it } from "vitest";
import {
  OPEN_CODE_SERVICE_URL_ENV,
  opencodeServiceDiscoveryPath,
  parseOpenCodeServiceDocument,
  probeOpenCodeService,
} from "../server/opencode-service";

/**
 * The 0.15.0 shared-service guard (`__doc.md` §10.11 item 1).
 *
 * Every row here is a real decision the hooks make before they touch an
 * agent's configuration: a `2.x` discovery document (or an explicit
 * `PASEO_OPENCODE_SERVER_URL`) means the host will not accept custom MCP
 * servers, so the plugin must contribute nothing over MCP and attach the
 * native tool instead. The fail-safe direction matters as much as the happy
 * path: an unreadable document must *not* disable MCP for every agent, while
 * a readable `2.x` document keeps the guard on even when its URL field is
 * spelled in a way this plugin does not know.
 */

const DOC = (body: Record<string, unknown>): string => JSON.stringify(body);

describe("parseOpenCodeServiceDocument", () => {
  it("marks a 2.x document with a loopback URL as a shared service", () => {
    const verdict = parseOpenCodeServiceDocument(
      DOC({ version: "2.2.5", url: "http://127.0.0.1:37999" }),
    );
    expect(verdict.shared).toBe(true);
    expect(verdict.version).toBe("2.2.5");
    expect(verdict.why).toContain("http://127.0.0.1:37999");
  });

  it("accepts the common URL spellings and the nested `service` object", () => {
    expect(
      parseOpenCodeServiceDocument(DOC({ version: "2.0.1", baseUrl: "http://localhost:9000" }))
        .shared,
    ).toBe(true);
    expect(
      parseOpenCodeServiceDocument(
        DOC({ version: "2.3.0", service: { url: "http://[::1]:9000" } }),
      ).shared,
    ).toBe(true);
    expect(
      parseOpenCodeServiceDocument(DOC({ serviceVersion: 2, endpoint: "http://127.0.0.1:1" }))
        .shared,
    ).toBe(true);
  });

  it("keeps the guard on when the document is 2.x but names no URL", () => {
    const verdict = parseOpenCodeServiceDocument(DOC({ version: "2.1.0" }));
    expect(verdict.shared).toBe(true);
    expect(verdict.why).toContain("OpenCode 2.1.0");
  });

  it("does not treat a 1.x document as shared", () => {
    const verdict = parseOpenCodeServiceDocument(
      DOC({ version: "1.9.0", url: "http://127.0.0.1:37999" }),
    );
    expect(verdict.shared).toBe(false);
    expect(verdict.version).toBe("1.9.0");
    expect(verdict.why).toContain("not 2.x");
  });

  it("does not treat a remote service as the local sharing case", () => {
    const verdict = parseOpenCodeServiceDocument(
      DOC({ version: "2.2.5", url: "https://opencode.example.com" }),
    );
    expect(verdict.shared).toBe(false);
    expect(verdict.why).toContain("not local");
  });

  it("fails safe on documents it cannot read", () => {
    for (const text of ["", "not json", "[]", "{}", DOC({ version: "" })]) {
      const verdict = parseOpenCodeServiceDocument(text);
      expect(verdict.shared).toBe(false);
      expect(verdict.version).toBeNull();
    }
  });
});

describe("opencodeServiceDiscoveryPath", () => {
  it("follows XDG_STATE_HOME", () => {
    expect(
      opencodeServiceDiscoveryPath({ XDG_STATE_HOME: "/state" }, "/home/u"),
    ).toBe("/state/opencode/service.json");
  });

  it("falls back to ~/.local/state", () => {
    expect(opencodeServiceDiscoveryPath({}, "/home/u")).toBe(
      "/home/u/.local/state/opencode/service.json",
    );
  });

  it("ignores a blank XDG_STATE_HOME", () => {
    expect(opencodeServiceDiscoveryPath({ XDG_STATE_HOME: "   " }, "/home/u")).toBe(
      "/home/u/.local/state/opencode/service.json",
    );
  });
});

describe("probeOpenCodeService", () => {
  it("answers immediately for every provider but opencode", () => {
    const probe = probeOpenCodeService({
      provider: "codex",
      env: { [OPEN_CODE_SERVICE_URL_ENV]: "http://127.0.0.1:1234" },
      readFile: () => {
        throw new Error("the probe must not read a discovery file for codex");
      },
    });
    expect(probe.shared).toBe(false);
    expect(probe.path).toBeNull();
  });

  it("treats an explicit PASEO_OPENCODE_SERVER_URL as shared", () => {
    const probe = probeOpenCodeService({
      provider: "opencode",
      env: { [OPEN_CODE_SERVICE_URL_ENV]: "http://127.0.0.1:37999" },
      readFile: () => null,
    });
    expect(probe.shared).toBe(true);
    expect(probe.why).toContain(OPEN_CODE_SERVICE_URL_ENV);
  });

  it("reports a missing discovery file as not shared", () => {
    const probe = probeOpenCodeService({
      provider: "opencode",
      env: { XDG_STATE_HOME: "/state" },
      readFile: () => null,
    });
    expect(probe.shared).toBe(false);
    expect(probe.path).toBe("/state/opencode/service.json");
    expect(probe.why).toContain("no OpenCode service discovery");
  });

  it("reads the discovered document through the injected reader", () => {
    const probed: string[] = [];
    const probe = probeOpenCodeService({
      provider: "opencode",
      env: { XDG_STATE_HOME: "/state" },
      readFile: (path) => {
        probed.push(path);
        return DOC({ version: "2.2.5", url: "http://127.0.0.1:37999" });
      },
    });
    expect(probed).toEqual(["/state/opencode/service.json"]);
    expect(probe.shared).toBe(true);
    expect(probe.version).toBe("2.2.5");
  });

  it("does not let an unreadable document disable MCP everywhere", () => {
    const probe = probeOpenCodeService({
      provider: "opencode",
      env: {},
      readFile: () => "{ broken",
    });
    expect(probe.shared).toBe(false);
  });
});
