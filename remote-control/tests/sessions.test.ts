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

// Stage 0.25.11 (G1): the console's Sessions view is pushed over SSE, so the
// registry reports every change instead of being polled only.
describe("change notifications", () => {
  const connection = { id: "conn_1", name: "desktop", host: "10.0.0.7", port: 3389 };

  it("reports a registration, a kill and a pruned window", () => {
    let alive = true;
    const counts: number[] = [];
    const registry = new ExternalSessionRegistry({
      isAlive: () => alive,
      signal: () => {},
      onChange: (sessions) => counts.push(sessions.length),
    });

    const info = registry.register({ connection, protocol: "rdp", pid: 21, binary: "xfreerdp3" });
    expect(counts).toEqual([1]);

    expect(registry.kill(info.id)).toBe(true);
    expect(counts).toEqual([1, 0]);

    // A window that died on its own disappears on the next listing, and that
    // too is a change the console should hear about.
    registry.register({ connection, protocol: "vnc", pid: 22, binary: "vncviewer" });
    alive = false;
    expect(registry.list()).toEqual([]);
    expect(counts).toEqual([1, 0, 1, 0]);
  });

  it("survives a throwing listener", () => {
    const registry = new ExternalSessionRegistry({
      isAlive: () => true,
      onChange: () => {
        throw new Error("listener boom");
      },
    });
    expect(() =>
      registry.register({ connection, protocol: "rdp", pid: 23, binary: "xfreerdp3" }),
    ).not.toThrow();
    expect(registry.list()).toHaveLength(1);
  });
});
