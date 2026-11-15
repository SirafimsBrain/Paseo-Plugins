import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectSharedOpenCodeService,
  isCompatibleOpenCodeServiceVersion,
  openCodeServiceFile,
  sharedOpenCodeMcpBlock,
} from "../server/opencode-service";
import {
  decideSessionOpen,
  needsCapabilityProbe,
  type SessionOpenInput,
} from "../server/session-open";

/**
 * 0.6.3: the host's shared OpenCode v2 selection, reproduced locally so the MCP
 * server can be withheld instead of failing the open (#7435). The rule itself is
 * Paseo's (`v2/service-selection.js`); these tests pin the parts of it that
 * decide whether injection is safe.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-opencode-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeService(info: unknown, name = "service.json"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof info === "string" ? info : JSON.stringify(info));
  return file;
}

const alive = () => true;

describe("openCodeServiceFile", () => {
  it("honours XDG_STATE_HOME and falls back to ~/.local/state", () => {
    expect(openCodeServiceFile({ XDG_STATE_HOME: "/tmp/state" } as NodeJS.ProcessEnv)).toBe(
      path.join("/tmp/state", "opencode", "service.json"),
    );
    expect(openCodeServiceFile({} as NodeJS.ProcessEnv)).toBe(
      path.join(os.homedir(), ".local", "state", "opencode", "service.json"),
    );
  });
});

describe("isCompatibleOpenCodeServiceVersion", () => {
  it("accepts 2.x from 2.0.10 upwards, including pre-releases", () => {
    for (const version of ["2.0.10", "2.2.5", "2.1.0-beta.1", "2.10.0"]) {
      expect(isCompatibleOpenCodeServiceVersion(version), version).toBe(true);
    }
  });

  it("rejects older majors, older 2.x and unparseable versions", () => {
    for (const version of ["1.9.9", "2.0.9", "3.0.0", "", "2"]) {
      expect(isCompatibleOpenCodeServiceVersion(version), version).toBe(false);
    }
  });
});

describe("detectSharedOpenCodeService", () => {
  it("reports no shared service when nothing is configured", () => {
    const result = detectSharedOpenCodeService({
      env: {} as NodeJS.ProcessEnv,
      file: path.join(dir, "absent.json"),
    });
    expect(result.shared).toBe(false);
    expect(result.detail).toContain("no OpenCode service file");
  });

  it("treats PASEO_OPENCODE_SERVER_URL as an explicit shared service", () => {
    const result = detectSharedOpenCodeService({
      env: { PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096" } as NodeJS.ProcessEnv,
      file: null,
    });
    expect(result.shared).toBe(true);
    expect(result.detail).toContain("PASEO_OPENCODE_SERVER_URL");
  });

  it("detects a compatible local 2.x service from the discovery file", () => {
    const file = writeService({ version: "2.2.5", url: "http://127.0.0.1:37999", pid: 4242 });
    const result = detectSharedOpenCodeService({
      env: {} as NodeJS.ProcessEnv,
      file,
      isProcessAlive: alive,
    });
    expect(result.shared).toBe(true);
    expect(result.detail).toContain("2.2.5");
    expect(result.path).toBe(file);
  });

  it("ignores an incompatible version, a remote host and a dead pid", () => {
    const stale = writeService({ version: "2.0.9", url: "http://127.0.0.1:1", pid: 1 }, "old.json");
    expect(
      detectSharedOpenCodeService({ env: {} as NodeJS.ProcessEnv, file: stale, isProcessAlive: alive })
        .shared,
    ).toBe(false);

    const remote = writeService({ version: "2.2.5", url: "http://203.0.113.9:4096", pid: 1 }, "remote.json");
    expect(
      detectSharedOpenCodeService({ env: {} as NodeJS.ProcessEnv, file: remote, isProcessAlive: alive })
        .shared,
    ).toBe(false);

    const dead = writeService({ version: "2.2.5", url: "http://127.0.0.1:37999", pid: 999999 }, "dead.json");
    const deadResult = detectSharedOpenCodeService({
      env: {} as NodeJS.ProcessEnv,
      file: dead,
      isProcessAlive: () => false,
    });
    expect(deadResult.shared).toBe(false);
    expect(deadResult.detail).toContain("stale");
  });

  it("never throws on a corrupt file", () => {
    const file = writeService("{not json", "broken.json");
    const result = detectSharedOpenCodeService({ env: {} as NodeJS.ProcessEnv, file });
    expect(result.shared).toBe(false);
    expect(result.detail).toContain("unreadable");
  });

  it("reads the file derived from XDG_STATE_HOME", () => {
    fs.mkdirSync(path.join(dir, "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "opencode", "service.json"),
      JSON.stringify({ version: "2.2.5", url: "http://127.0.0.1:37999", pid: 4242 }),
    );
    const result = detectSharedOpenCodeService({
      env: { XDG_STATE_HOME: dir } as NodeJS.ProcessEnv,
      isProcessAlive: alive,
    });
    expect(result.shared).toBe(true);
    expect(result.path).toBe(path.join(dir, "opencode", "service.json"));
  });
});

describe("sharedOpenCodeMcpBlock", () => {
  it("blocks only the opencode provider, and only on a shared service", () => {
    const shared = { shared: true, detail: "OpenCode 2.2.5", path: "/tmp/service.json" };
    const owned = { shared: false, detail: "no service", path: null };

    expect(sharedOpenCodeMcpBlock("opencode", shared)).toContain("#7435");
    expect(sharedOpenCodeMcpBlock("cline", shared)).toBeNull();
    expect(sharedOpenCodeMcpBlock("opencode", owned)).toBeNull();
  });
});

describe("decideSessionOpen with a shared OpenCode service", () => {
  function input(overrides: Partial<SessionOpenInput> = {}): SessionOpenInput {
    return {
      reason: "resume",
      purpose: "interactive",
      provider: "opencode",
      labels: {},
      injectIntoAgents: true,
      serverName: "bunny-search",
      labelGateKey: "",
      skipProviders: "",
      lookup: { status: "found", savedServers: [] },
      supportsMcpServers: true,
      openCodeMcpBlock: null,
      ...overrides,
    };
  }

  const block = () =>
    sharedOpenCodeMcpBlock("opencode", {
      shared: true,
      detail: "OpenCode 2.2.5 service at http://127.0.0.1:37999",
      path: "/tmp/service.json",
    });

  it("withholds the server and attaches bunny_web_search instead", () => {
    const decision = decideSessionOpen(input({ openCodeMcpBlock: block() }));
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(true);
    expect(decision.why).toContain("#7435");
  });

  it("does not spend a daemon round trip on the capability probe", () => {
    expect(needsCapabilityProbe(input({ openCodeMcpBlock: block() }))).toBe(false);
    expect(needsCapabilityProbe(input())).toBe(true);
  });
});
