import { describe, expect, it } from "vitest";
import {
  PROVISIONING_METADATA_KEY,
  RUN_METADATA_KEY,
  WORKSPACE_METADATA_KEY,
  provisioningMarker,
  readProvisioningMarker,
  readRunStamp,
  readWorkspaceStamp,
  runStamp,
  withProvisioningMarker,
  workspaceStamp,
} from "../server/metadata";

const AT = "2026-11-16T10:00:00.000Z";

describe("plugin metadata", () => {
  it("round-trips the run stamp", () => {
    const stamp = runStamp({ commandId: "cmd_1", commandName: "Review", runId: "r1", at: AT });
    const metadata = { [RUN_METADATA_KEY]: stamp };
    expect(readRunStamp(metadata)).toEqual({
      commandId: "cmd_1",
      commandName: "Review",
      runId: "r1",
      at: AT,
    });
  });

  it("treats missing or malformed stamps as no claim", () => {
    expect(readRunStamp(null)).toBeNull();
    expect(readRunStamp({})).toBeNull();
    expect(readRunStamp({ [RUN_METADATA_KEY]: "cmd_1" })).toBeNull();
    expect(readRunStamp({ [RUN_METADATA_KEY]: { commandName: "no id" } })).toBeNull();
    // Unknown fields of a foreign producer never throw.
    expect(readRunStamp({ [RUN_METADATA_KEY]: { commandId: "cmd_2", extra: [1, 2] } })).toEqual({
      commandId: "cmd_2",
      commandName: "",
      runId: "",
      at: "",
    });
  });

  it("round-trips the provisioning marker", () => {
    const metadata = withProvisioningMarker({}, provisioningMarker("mcp", "contributed 2 servers", AT));
    expect(readProvisioningMarker(metadata)).toEqual({
      mode: "mcp",
      reason: "contributed 2 servers",
      at: AT,
    });
  });

  it("keeps every foreign key and the run stamp when marking", () => {
    const metadata = withProvisioningMarker(
      {
        "other-plugin": { keep: true },
        [RUN_METADATA_KEY]: runStamp({ commandId: "c", commandName: "n", runId: "r", at: AT }),
      },
      provisioningMarker("tool", "agent tool only", AT),
    );
    expect(metadata["other-plugin"]).toEqual({ keep: true });
    expect(readRunStamp(metadata)?.commandId).toBe("c");
    expect(readProvisioningMarker(metadata)?.mode).toBe("tool");
  });

  it("rejects an unknown mode instead of guessing", () => {
    expect(
      readProvisioningMarker({ [PROVISIONING_METADATA_KEY]: { mode: "both", reason: "", at: AT } }),
    ).toBeNull();
    expect(readProvisioningMarker({ [PROVISIONING_METADATA_KEY]: 7 })).toBeNull();
  });

  it("clears the marker without touching other keys", () => {
    const metadata = withProvisioningMarker(
      { [PROVISIONING_METADATA_KEY]: { mode: "skipped", reason: "", at: AT }, other: "x" },
      null,
    );
    expect(metadata[PROVISIONING_METADATA_KEY]).toBeUndefined();
    expect(metadata["other"]).toBe("x");
  });

  it("round-trips the workspace bootstrap stamp", () => {
    const stamp = workspaceStamp({ commandId: "cmd_9", commandName: "Init", bootstrappedAt: AT });
    expect(readWorkspaceStamp({ [WORKSPACE_METADATA_KEY]: stamp })).toEqual({
      commandId: "cmd_9",
      commandName: "Init",
      bootstrappedAt: AT,
    });
    expect(readWorkspaceStamp({})).toBeNull();
    expect(readWorkspaceStamp({ [WORKSPACE_METADATA_KEY]: { commandId: "cmd_9" } })).toBeNull();
  });
});
