import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVISIONING_LOG_LIMIT,
  PROVISIONING_METADATA_KEY,
  clearProvisioningLog,
  provisioningMarker,
  readProvisioningMarker,
  recentProvisioning,
  recordProvisioning,
  subscribeProvisioning,
  withProvisioningMarker,
} from "../server/provisioning";
import type { ProvisioningEvent } from "../shared/contracts";

/**
 * 0.7.5: the agent marker the hooks write into `metadata`, and the bounded event
 * log the live status stream reads.
 */

function event(agentId: string, mode: ProvisioningEvent["mode"] = "mcp"): ProvisioningEvent {
  return {
    agentId,
    provider: "opencode",
    mode,
    reason: "test",
    background: false,
    at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  clearProvisioningLog();
});

describe("provisioning marker", () => {
  it("round-trips through metadata and leaves other plugins' keys alone", () => {
    const metadata = withProvisioningMarker(
      { "other-plugin": { mode: "whatever" }, flag: true },
      provisioningMarker("tool", "shared OpenCode service"),
    );
    expect(metadata["other-plugin"]).toEqual({ mode: "whatever" });
    expect(metadata.flag).toBe(true);
    expect(readProvisioningMarker(metadata)).toMatchObject({
      mode: "tool",
      reason: "shared OpenCode service",
    });
  });

  it("replaces a previous marker instead of duplicating it", () => {
    const first = withProvisioningMarker({}, provisioningMarker("skipped", "gate"));
    const second = withProvisioningMarker(first, provisioningMarker("mcp", "injected"));
    expect(Object.keys(second)).toEqual([PROVISIONING_METADATA_KEY]);
    expect(readProvisioningMarker(second)?.mode).toBe("mcp");
  });

  it("claims nothing for a missing, foreign or malformed value", () => {
    expect(readProvisioningMarker(null)).toBeNull();
    expect(readProvisioningMarker({})).toBeNull();
    expect(readProvisioningMarker({ [PROVISIONING_METADATA_KEY]: "mcp" })).toBeNull();
    expect(readProvisioningMarker({ [PROVISIONING_METADATA_KEY]: { mode: "advanced" } })).toBeNull();
    expect(
      readProvisioningMarker({ [PROVISIONING_METADATA_KEY]: { mode: "mcp", reason: 1, at: null } }),
    ).toEqual({ mode: "mcp", reason: "", at: "" });
  });

  it("drops the key when asked, keeping the rest", () => {
    const metadata = withProvisioningMarker({ keep: 1 }, null);
    expect(metadata).toEqual({ keep: 1 });
  });
});

describe("provisioning log", () => {
  it("keeps the newest first and stays bounded", () => {
    for (let index = 0; index < PROVISIONING_LOG_LIMIT + 5; index += 1) {
      recordProvisioning(event(`agent-${index}`));
    }
    const recent = recentProvisioning();
    expect(recent).toHaveLength(PROVISIONING_LOG_LIMIT);
    expect(recent[0]?.agentId).toBe(`agent-${PROVISIONING_LOG_LIMIT + 4}`);
    expect(recentProvisioning(2)).toHaveLength(2);
  });

  it("notifies subscribers with the decision, and with null for a status change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProvisioning(listener);
    recordProvisioning(event("agent-1"));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent-1" }));
    clearProvisioningLog();
    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
    recordProvisioning(event("agent-2"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
