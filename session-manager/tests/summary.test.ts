import { describe, expect, it } from "vitest";
import type { AgentSession, ProviderStatus } from "../shared/session-manager";
import {
  formatBytes,
  isOldEnough,
  needsForce,
  summarizeSessions,
} from "../shared/session-summary";

/**
 * The sidebar status row (0.5.0) and the panel share these helpers, so the
 * "due for cleanup" meaning is defined once. The cases below pin the definition
 * the panel has always used: an unknown timestamp counts as old, a running
 * session or one owned by a non-archived Paseo agent is risky and never counted
 * as due, and `cleanupDays: 0` switches the hint off.
 */

const DAY = 86_400_000;
const isoDaysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    provider: "qwen-code",
    id: "s1",
    title: "session",
    cwd: "/tmp/x",
    createdAt: isoDaysAgo(60),
    updatedAt: isoDaysAgo(45),
    sizeBytes: 1024,
    running: false,
    paseoAgent: null,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: "qwen-code",
    label: "Qwen Code",
    detected: true,
    deletable: true,
    detail: "/tmp/store",
    count: 0,
    storeBytes: 4096,
    error: null,
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("returns null for unknown or empty sizes instead of 0 B", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(0)).toBeNull();
  });

  it("scales to the largest unit and keeps one decimal below 10", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(743_960_576)).toBe("709 MB");
  });
});

describe("isOldEnough", () => {
  it("treats an unknown updatedAt as old enough", () => {
    expect(isOldEnough(session({ updatedAt: null }), 30)).toBe(true);
  });

  it("compares against the threshold in days", () => {
    expect(isOldEnough(session({ updatedAt: isoDaysAgo(45) }), 30)).toBe(true);
    expect(isOldEnough(session({ updatedAt: isoDaysAgo(2) }), 30)).toBe(false);
    expect(isOldEnough(session({ updatedAt: isoDaysAgo(2) }), 0)).toBe(true);
  });
});

describe("needsForce", () => {
  it("flags running sessions and sessions owned by an open Paseo agent", () => {
    expect(needsForce(session({ running: true }))).toBe(true);
    expect(
      needsForce(session({ paseoAgent: { id: "a1", title: null, archived: false } })),
    ).toBe(true);
  });

  it("allows archived Paseo agents without force", () => {
    expect(
      needsForce(session({ paseoAgent: { id: "a1", title: null, archived: true } })),
    ).toBe(false);
  });
});

describe("summarizeSessions", () => {
  const sessions: AgentSession[] = [
    session({ id: "old", provider: "qwen-code", sizeBytes: 1024 }),
    session({ id: "fresh", provider: "qwen-code", updatedAt: isoDaysAgo(1), sizeBytes: null }),
    session({ id: "running", provider: "kimi", running: true }),
    session({ id: "orphan", provider: "kimi", updatedAt: null, sizeBytes: 2048 }),
  ];

  it("counts due sessions, risky sessions and known bytes", () => {
    const summary = summarizeSessions(
      sessions,
      [provider(), provider({ id: "kimi", label: "Kimi Code", storeBytes: 15_200_113 })],
      30,
    );
    expect(summary.total).toBe(4);
    // "fresh" is too new, "running" needs force.
    expect(summary.due).toBe(2);
    expect(summary.risky).toBe(1);
    expect(summary.knownBytes).toBe(1024 + 1024 + 2048);
    expect(summary.providers.map((entry) => [entry.id, entry.count, entry.due])).toEqual([
      ["qwen-code", 2, 1],
      ["kimi", 2, 1],
    ]);
  });

  it("switches the due count off when the cleanup hint is off", () => {
    const summary = summarizeSessions(sessions, [provider()], 0);
    expect(summary.due).toBe(0);
    expect(summary.providers[0].due).toBe(0);
  });

  it("reports unknown bytes rather than zero when no session knows its size", () => {
    const summary = summarizeSessions([session({ sizeBytes: null })], [provider()], 30);
    expect(summary.knownBytes).toBeNull();
  });
});
