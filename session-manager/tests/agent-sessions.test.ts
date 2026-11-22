import { describe, expect, it } from "vitest";
import { sessionsForAgent } from "../shared/agent-sessions";
import type { AgentSession } from "../shared/session-manager";

/**
 * 0.7.0: the per-agent panel is a filter over the existing listing, so the
 * definition of "this agent's session" lives here and is pinned by tests.
 */

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    provider: "qwen-code",
    id: "s1",
    title: "session",
    cwd: "/tmp/x",
    createdAt: null,
    updatedAt: null,
    sizeBytes: null,
    running: false,
    paseoAgent: null,
    ...overrides,
  };
}

describe("sessionsForAgent", () => {
  it("keeps only the sessions the agent references", () => {
    const rows = sessionsForAgent(
      [
        session({ id: "a", paseoAgent: { id: "agent-1", title: "A", archived: false } }),
        session({ id: "b", paseoAgent: { id: "agent-2", title: "B", archived: false } }),
        session({ id: "c" }),
      ],
      "agent-1",
    );
    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });

  it("includes an archived agent's session — the panel still has to clean it up", () => {
    const rows = sessionsForAgent(
      [session({ id: "a", paseoAgent: { id: "agent-1", title: null, archived: true } })],
      "agent-1",
    );
    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });

  it("returns nothing for an empty id instead of every unlinked session", () => {
    expect(sessionsForAgent([session()], "   ")).toEqual([]);
  });
});
