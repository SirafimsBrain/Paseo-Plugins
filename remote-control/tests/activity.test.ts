import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activitySnapshot,
  clearActivity,
  publishActivity,
  setActivityProvider,
  subscribeActivity,
} from "../server/activity";
import {
  activitySnapshotSchema,
  activityStream,
  type ActivitySnapshot,
} from "../shared/activity";

function snapshot(reason: ActivitySnapshot["reason"] = "snapshot"): ActivitySnapshot {
  return {
    at: "2026-11-16T10:00:00.000Z",
    reason,
    listening: true,
    consoleUrl: "http://127.0.0.1:4123/?token=rc_1",
    vault: { initialized: true, unlocked: false, entries: 2 },
    terminals: [
      {
        id: "ter_1",
        workspaceId: "w1",
        name: "prod",
        connectionId: "conn_1",
        kind: "ssh",
        startedAt: 1,
      },
    ],
    sessions: [
      {
        id: "ext_1",
        kind: "rdp",
        name: "desktop",
        connectionId: "conn_2",
        workspaceId: "w1",
        target: "10.0.0.5:3389",
        state: "running",
        exitCode: null,
        startedAt: 2,
        exitedAt: null,
      },
    ],
  };
}

describe("activity hub", () => {
  beforeEach(() => {
    clearActivity();
  });

  it("does nothing without a provider", () => {
    const listener = vi.fn();
    subscribeActivity(listener);
    expect(activitySnapshot("snapshot")).toBeNull();
    publishActivity("vault");
    expect(listener).not.toHaveBeenCalled();
  });

  it("pushes the provider's snapshot to every subscriber with the reason", () => {
    setActivityProvider((reason) => snapshot(reason));
    const first = vi.fn();
    const second = vi.fn();
    subscribeActivity(first);
    subscribeActivity(second);
    publishActivity("terminals");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]![0].reason).toBe("terminals");
  });

  it("stops after unsubscribe", () => {
    setActivityProvider((reason) => snapshot(reason));
    const listener = vi.fn();
    const off = subscribeActivity(listener);
    off();
    publishActivity("sessions");
    expect(listener).not.toHaveBeenCalled();
  });

  it("survives a broken provider and a broken subscriber", () => {
    const listener = vi.fn();
    subscribeActivity(listener);
    setActivityProvider(() => {
      throw new Error("boom");
    });
    expect(() => publishActivity("state")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();

    setActivityProvider((reason) => snapshot(reason));
    subscribeActivity(() => {
      throw new Error("subscriber boom");
    });
    expect(() => publishActivity("state")).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forgets everything on clear", () => {
    setActivityProvider((reason) => snapshot(reason));
    const listener = vi.fn();
    subscribeActivity(listener);
    clearActivity();
    publishActivity("vault");
    expect(listener).not.toHaveBeenCalled();
    expect(activitySnapshot("snapshot")).toBeNull();
  });

  it("matches the contract the client subscribes to", () => {
    expect(activityStream.name).toBe("remote-control.activity");
    expect(activityStream.input.parse({})).toEqual({});
    expect(() => activitySnapshotSchema.parse(snapshot())).not.toThrow();
  });
});
