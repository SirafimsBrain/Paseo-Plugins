import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkPaseoDaemon,
  daemonPidPath,
  heartbeatPath,
  isGateDisabled,
  parsePidFile,
  PASEO_DOWN_MESSAGE,
  startDaemonHeartbeat,
  writeDaemonHeartbeat,
} from "../server/daemon-gate";

/**
 * The gate decides whether a plugin's stdio MCP server may serve an agent.
 * Every case is driven through a temporary Paseo home, so no real daemon
 * state is read and no real heartbeat is written.
 */
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-gate-"));
  fs.mkdirSync(path.join(home, "plugins", "memory-flash"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writePidFile(content: unknown): void {
  fs.writeFileSync(daemonPidPath(home), typeof content === "string" ? content : JSON.stringify(content));
}

describe("Paseo daemon gate", () => {
  it("reports unavailable on a clean home", () => {
    const result = checkPaseoDaemon({ home, env: {} });
    expect(result.available).toBe(false);
    expect(result.source).toBe("none");
    expect(result.reason).toContain(heartbeatPath(home));
  });

  it("serves while the plugin heartbeat is fresh", () => {
    expect(writeDaemonHeartbeat({ home, pid: process.pid })).toBe(heartbeatPath(home));
    const result = checkPaseoDaemon({ home, env: {} });
    expect(result.available).toBe(true);
    expect(result.source).toBe("heartbeat");
  });

  it("treats an expired heartbeat as a stopped daemon", () => {
    fs.writeFileSync(
      heartbeatPath(home),
      JSON.stringify({ pid: process.pid, updatedAt: Date.now() - 5 * 60 * 1000 }),
    );
    const result = checkPaseoDaemon({ home, env: {} });
    expect(result.available).toBe(false);
  });

  it("ignores a fresh heartbeat of a process that no longer exists", () => {
    fs.writeFileSync(heartbeatPath(home), JSON.stringify({ pid: 424242, updatedAt: Date.now() }));
    const result = checkPaseoDaemon({ home, env: {}, isProcessAlive: () => false });
    expect(result.available).toBe(false);
  });

  it("accepts a live daemon pid file without a heartbeat", () => {
    writePidFile({ pid: process.pid, listen: "127.0.0.1:6767" });
    const result = checkPaseoDaemon({ home, env: {} });
    expect(result.available).toBe(true);
    expect(result.source).toBe("pid");
    expect(result.reason).toContain(String(process.pid));
  });

  it("rejects a stale pid file whose process is gone", () => {
    writePidFile({ pid: 424242 });
    const result = checkPaseoDaemon({ home, env: {}, isProcessAlive: () => false });
    expect(result.available).toBe(false);
  });

  it("honours MEMORY_FLASH_DAEMON_GATE=off", () => {
    const env = { MEMORY_FLASH_DAEMON_GATE: "off" };
    expect(isGateDisabled(env)).toBe(true);
    const result = checkPaseoDaemon({ home, env });
    expect(result.available).toBe(true);
    expect(result.source).toBe("disabled");
    expect(isGateDisabled({ MEMORY_FLASH_DAEMON_GATE: "" })).toBe(false);
    expect(isGateDisabled({})).toBe(false);
  });

  it("starts and stops the heartbeat with the plugin server", () => {
    const stop = startDaemonHeartbeat({ home });
    expect(fs.existsSync(heartbeatPath(home))).toBe(true);
    stop();
    expect(fs.existsSync(heartbeatPath(home))).toBe(false);
  });

  it("parses JSON and bare pid files", () => {
    expect(parsePidFile('{"pid":1234}')).toBe(1234);
    expect(parsePidFile("1234\n")).toBe(1234);
    expect(parsePidFile("not a pid")).toBeNull();
    expect(parsePidFile("")).toBeNull();
  });

  it("carries the exact unavailability sentence in both languages", () => {
    expect(PASEO_DOWN_MESSAGE).toContain("Демон Paseo недоступен, MCP недоступен");
    expect(PASEO_DOWN_MESSAGE).toContain("Paseo daemon unavailable");
  });
});
