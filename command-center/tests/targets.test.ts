import { describe, expect, it } from "vitest";
import { planTargets } from "../shared/targets";

describe("planTargets (per-agent fan-out)", () => {
  it("keeps the legacy best-guess target when nothing is selected", () => {
    const targets = planTargets({
      selectedWorkspaceKeys: [],
      selectedAgents: [],
      provider: "cline/claude-opus-4-6",
      newWorktree: true,
      workflow: false,
    });
    expect(targets).toEqual([
      { workspaceKey: null, provider: "cline/claude-opus-4-6", newWorktree: true },
    ]);
  });

  it("creates one new-agent target per selected workspace", () => {
    const targets = planTargets({
      selectedWorkspaceKeys: ["[\"h1\",\"w1\"]", "[\"h1\",\"w2\"]"],
      selectedAgents: [],
      provider: "cline/claude-opus-4-6",
      newWorktree: true,
      workflow: false,
    });
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => target.agentId === undefined && target.newWorktree)).toBe(true);
  });

  it("sends to a selected agent and keeps its host even when its workspace is not loaded", () => {
    const targets = planTargets({
      selectedWorkspaceKeys: [],
      selectedAgents: [{ id: "ag_2", serverId: "h2", workspaceKey: null }],
      provider: "cline/claude-opus-4-6",
      newWorktree: true,
      workflow: false,
    });
    expect(targets).toEqual([
      {
        workspaceKey: null,
        serverId: "h2",
        agentId: "ag_2",
        provider: "cline/claude-opus-4-6",
        newWorktree: false,
        activeTurnBehavior: undefined,
      },
    ]);
  });

  it("does not start a workspace again when an agent of that workspace is selected", () => {
    const key = "[\"h1\",\"w1\"]";
    const targets = planTargets({
      selectedWorkspaceKeys: [key],
      selectedAgents: [{ id: "ag_1", serverId: "h1", workspaceKey: key }],
      provider: "cline/claude-opus-4-6",
      newWorktree: true,
      workflow: false,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ workspaceKey: key, agentId: "ag_1", newWorktree: false });
  });

  it("mixes remaining workspaces with agent targets", () => {
    const key1 = "[\"h1\",\"w1\"]";
    const key2 = "[\"h1\",\"w2\"]";
    const targets = planTargets({
      selectedWorkspaceKeys: [key1, key2],
      selectedAgents: [{ id: "ag_1", serverId: "h1", workspaceKey: key1 }],
      provider: "cline/claude-opus-4-6",
      newWorktree: false,
      workflow: false,
    });
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ workspaceKey: key2 });
    expect(targets[0]!.agentId).toBeUndefined();
    expect(targets[1]).toMatchObject({ workspaceKey: key1, agentId: "ag_1" });
  });

  it("threads the busy-turn policy only into agent targets and disables worktrees", () => {
    const key = "[\"h1\",\"w1\"]";
    const targets = planTargets({
      selectedWorkspaceKeys: [key, "[\"h1\",\"w2\"]"],
      selectedAgents: [{ id: "ag_1", serverId: "h1", workspaceKey: key }],
      provider: "cline/claude-opus-4-6",
      newWorktree: true,
      workflow: true,
      activeTurnBehavior: "steer",
    });
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => target.newWorktree === false)).toBe(true);
    expect(targets[0]!.activeTurnBehavior).toBeUndefined();
    expect(targets[1]!.activeTurnBehavior).toBe("steer");
  });
});
