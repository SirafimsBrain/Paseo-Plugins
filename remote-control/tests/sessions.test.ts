// External RDP/VNC session registry (stage 0.23.10): the Sessions view lists
// windows this plugin spawned and can kill them.

import { describe, expect, it } from "vitest";
import { ExternalSessionRegistry } from "../server/sessions";

const connection = { id: "conn_1", name: "desktop", host: "10.0.0.7", port: 3389 };

describe("ExternalSessionRegistry", () => {
  it("registers a session with its kind and target", () => {
    const registry = new ExternalSessionRegistry({ now: () => 100, isAlive: () => true });
    const info = registry.register({ connection, protocol: "rdp", pid: 42, binary: "xfreerdp3", runDir: null });
    expect(info.id).toMatch(/^ext_/);
    expect(info.kind).toBe("rdp");
    expect(info.target).toBe("10.0.0.7:3389");
    expect(info.pid).toBe(42);
    expect(info.startedAt).toBe(100);
    expect(registry.list()).toEqual([info]);
  });

  it("drops sessions whose process exited and cleans their run dir", () => {
    let alive = true;
    const cleaned: string[] = [];
    const registry = new ExternalSessionRegistry({
      isAlive: () => alive,
      cleanup: (dir) => cleaned.push(dir),
    });
    const info = registry.register({ connection, protocol: "vnc", pid: 7, binary: "vncviewer", runDir: "/run/x" });
    expect(registry.list()).toHaveLength(1);
    alive = false;
    expect(registry.list()).toEqual([]);
    expect(cleaned).toEqual(["/run/x"]);
    expect(registry.get(info.id)).toBeNull();
  });

  it("kills the process group and forgets the session", () => {
    const signals: [number, NodeJS.Signals][] = [];
    const cleaned: string[] = [];
    const registry = new ExternalSessionRegistry({
      isAlive: () => true,
      signal: (pid, signal) => signals.push([pid, signal]),
      cleanup: (dir) => cleaned.push(dir),
    });
    const info = registry.register({ connection, protocol: "rdp", pid: 11, binary: "xfreerdp3", runDir: "/run/y" });
    expect(registry.kill(info.id)).toBe(true);
    expect(signals).toEqual([[11, "SIGTERM"]]);
    expect(cleaned).toEqual(["/run/y"]);
    expect(registry.list()).toEqual([]);
    expect(registry.kill(info.id)).toBe(false);
  });

  it("reports success when the process is already gone", () => {
    const registry = new ExternalSessionRegistry({
      isAlive: () => true,
      signal: () => {
        throw new Error("ESRCH");
      },
    });
    const info = registry.register({ connection, protocol: "vnc", pid: 12, binary: "vncviewer" });
    expect(registry.kill(info.id)).toBe(true);
    expect(registry.get(info.id)).toBeNull();
  });

  it("removes run dirs on dispose but keeps the windows running", () => {
    const signals: unknown[] = [];
    const cleaned: string[] = [];
    const registry = new ExternalSessionRegistry({
      isAlive: () => true,
      signal: (...args) => signals.push(args),
      cleanup: (dir) => cleaned.push(dir),
    });
    registry.register({ connection, protocol: "rdp", pid: 13, binary: "xfreerdp3", runDir: "/run/z" });
    registry.dispose();
    expect(cleaned).toEqual(["/run/z"]);
    expect(signals).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});
