import { describe, expect, it } from "vitest";
import { provenanceInstruction } from "../shared/agent-instructions";

/**
 * 0.14.4 coverage: the provenance instruction appended through
 * `appendSystemPrompt` (Paseo 0.17.x). The hook wiring is covered in
 * `server-rpc.test.ts`.
 */

describe("provenanceInstruction", () => {
  it("names the command and the run", () => {
    const text = provenanceInstruction({
      commandId: "cmd_1",
      commandName: "Nightly Review",
      runId: "r_42",
    });
    expect(text).toContain("Nightly Review");
    expect(text).toContain("r_42");
    expect(text).toContain("Command Center");
  });

  it("falls back to the id when an old stamp has no name", () => {
    const text = provenanceInstruction({ commandId: "cmd_legacy", commandName: "", runId: "" });
    expect(text).toContain("cmd_legacy");
    expect(text).not.toContain("run `");
  });

  it("returns null when there is no run to describe", () => {
    expect(provenanceInstruction(null)).toBeNull();
    expect(provenanceInstruction({ commandId: "  ", commandName: "x", runId: "y" })).toBeNull();
  });
});
