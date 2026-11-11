import { describe, expect, it } from "vitest";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";
import { dashboardSummary } from "../shared/dashboard";
import { parseScreenParams, screenParams, toOpenScreenParams } from "../shared/screen-params";

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "Deploy staging",
    type: "prompt",
    template: "Deploy {{input:service}}",
    variables: [{ name: "service", prompt: "Service", kind: "text" }],
    steps: [],
    scope: "global",
    provider: "cline/claude-opus-4-6",
    category: "ops",
    favorite: true,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    useCount: 4,
    ...overrides,
  };
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h_1",
    commandId: "cmd_1",
    commandName: "Deploy staging",
    rendered: "Deploy api",
    targetWorkspaceId: "w1",
    targetAgentId: null,
    kind: "new-agent",
    ok: true,
    error: null,
    at: "2026-11-11T10:00:00.000Z",
    ...overrides,
  };
}

describe("dashboardSummary", () => {
  it("counts commands, sums the run counters and reports recent failures", () => {
    const summary = dashboardSummary(
      [command({ useCount: 4 }), command({ id: "cmd_2", name: "Lint", useCount: 2 })],
      [entry(), entry({ id: "h_2", ok: false, error: "daemon refused" })],
    );
    expect(summary.commandCount).toBe(2);
    expect(summary.totalRuns).toBe(6);
    expect(summary.failedRuns).toBe(1);
    expect(summary.recent).toHaveLength(2);
    expect(summary.mostUsed.map((entryCommand) => entryCommand.name)).toEqual([
      "Deploy staging",
      "Lint",
    ]);
  });

  it("caps the recent list and the most-used list independently", () => {
    const summary = dashboardSummary(
      [command({ useCount: 3 }), command({ id: "cmd_2", name: "Lint", useCount: 1 })],
      [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })],
      { recentLimit: 2, mostUsedLimit: 1 },
    );
    expect(summary.recent.map((item) => item.id)).toEqual(["a", "b"]);
    expect(summary.mostUsed.map((item) => item.name)).toEqual(["Deploy staging"]);
  });

  it("handles an empty store", () => {
    const summary = dashboardSummary([], []);
    expect(summary).toMatchObject({ commandCount: 0, totalRuns: 0, failedRuns: 0 });
    expect(summary.recent).toEqual([]);
    expect(summary.mostUsed).toEqual([]);
  });

  it("treats a negative limit as zero instead of slicing from the end", () => {
    const summary = dashboardSummary([command()], [entry()], { recentLimit: -5, mostUsedLimit: -1 });
    expect(summary.recent).toEqual([]);
    expect(summary.mostUsed).toEqual([]);
  });
});

describe("dashboard deep link", () => {
  it("parses view=dashboard and round-trips it", () => {
    expect(parseScreenParams({ view: "dashboard" }).view).toBe("dashboard");
    expect(toOpenScreenParams(screenParams("dashboard"))).toEqual({ view: "dashboard" });
  });

  it("still degrades an unknown view to the library", () => {
    expect(parseScreenParams({ view: "nope" }).view).toBe("library");
  });
});
