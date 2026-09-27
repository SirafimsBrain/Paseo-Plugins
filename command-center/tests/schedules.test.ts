import { describe, expect, it } from "vitest";
import { CADENCE_PRESETS, describeCadence, looksLikeCron, schedulePromptFor } from "../shared/schedules";
import type { ScheduleView } from "../shared/schedules";
import type { DaemonSchedule } from "../server/schedules-mapping";
import { toScheduleView } from "../server/schedules-mapping";

function daemonSchedule(overrides: Partial<DaemonSchedule> = {}): DaemonSchedule {
  return {
    id: "sch_1",
    name: "Nightly review",
    status: "active",
    cadence: { type: "cron", expression: "0 9 * * *" },
    target: {
      type: "new-agent",
      config: {
        provider: "opencode/opencode/mimo-v2.6-flash-free",
        cwd: "/disk/repo",
        isolation: "local",
        archiveOnFinish: true,
      },
    },
    prompt: "Review the repo",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    nextRunAt: "2026-09-25T09:00:00.000Z",
    lastRunAt: null,
    maxRuns: null,
    ...overrides,
  };
}

describe("schedule mapping", () => {
  it("maps a new-agent schedule to a linked view", () => {
    const view = toScheduleView(daemonSchedule(), [], [
      { scheduleId: "sch_1", commandId: "cmd_1", commandName: "Review" },
    ]);
    expect(view.commandId).toBe("cmd_1");
    expect(view.commandName).toBe("Review");
    expect(view.provider).toBe("opencode/opencode/mimo-v2.6-flash-free");
    expect(view.isolation).toBe("local");
    expect(view.archiveOnFinish).toBe(true);
    expect(view.targetKind).toBe("new-agent");
  });

  it("keeps schedules without a plugin link but fills commandName when the command still exists", () => {
    const command = { id: "cmd_1", name: "Review" } as never;
    const view = toScheduleView(daemonSchedule(), [command], []);
    expect(view.commandId).toBeNull();
    expect(view.commandName).toBeNull();
  });

  it("maps agent-target schedules without config fields", () => {
    const view = toScheduleView(
      daemonSchedule({ target: { type: "agent", agentId: "ag_1" } }),
      [],
      [],
    );
    expect(view.targetKind).toBe("agent");
    expect(view.provider).toBeNull();
    expect(view.cwd).toBeNull();
  });

  it("preserves every-cadence and timezone", () => {
    const view = toScheduleView(
      daemonSchedule({ cadence: { type: "every", everyMs: 60000 } }),
      [],
      [],
    );
    expect(view.cadence).toEqual({ type: "every", everyMs: 60000 });
  });
});

describe("describeCadence", () => {
  it("describes hourly and daily cron shapes", () => {
    expect(describeCadence({ type: "cron", expression: "0 * * * *" })).toBe("Hourly at :00");
    expect(describeCadence({ type: "cron", expression: "30 * * * *" })).toBe("Hourly at :30");
    expect(describeCadence({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00");
  });

  it("describes weekday and interval presets", () => {
    expect(describeCadence({ type: "cron", expression: "0 9 * * 1" })).toBe("Mondays at 09:00");
    expect(describeCadence({ type: "cron", expression: "*/15 * * * *" })).toBe("Every 15 min");
  });

  it("appends a timezone when present and falls back to the raw expression", () => {
    expect(describeCadence({ type: "cron", expression: "0 9 * * *", timezone: "UTC" })).toBe("Daily at 09:00 (UTC)");
    expect(describeCadence({ type: "cron", expression: "5 4 1 1 0" })).toBe("5 4 1 1 0");
  });

  it("humanizes every-Ms cadences", () => {
    expect(describeCadence({ type: "every", everyMs: 3_600_000 })).toBe("Every 1 hour");
    expect(describeCadence({ type: "every", everyMs: 86_400_000 })).toBe("Every 1 day");
    expect(describeCadence({ type: "every", everyMs: 900_000 })).toBe("Every 15 min");
  });
});

describe("looksLikeCron", () => {
  it("requires five fields", () => {
    expect(looksLikeCron("0 9 * * *")).toBe(true);
    expect(looksLikeCron("*/15 * * *")).toBe(false);
    expect(looksLikeCron("0 9 * * * ")).toBe(true);
    expect(looksLikeCron("")).toBe(false);
  });
});

describe("CADENCE_PRESETS", () => {
  it("uses five-field crons only", () => {
    for (const preset of CADENCE_PRESETS) expect(looksLikeCron(preset.cron)).toBe(true);
  });
});

describe("schedulePromptFor", () => {
  it("passes prompt commands through untouched", () => {
    expect(schedulePromptFor("prompt", "Review the repo")).toBe("Review the repo");
  });

  it("wraps a shell line into an agent instruction with a fenced command", () => {
    const prompt = schedulePromptFor("shell", "npm test");
    expect(prompt.startsWith("Run this shell command")).toBe(true);
    expect(prompt).toContain("```sh\nnpm test\n```");
  });

  it("trims stray whitespace around the shell line", () => {
    expect(schedulePromptFor("shell", "  git status  ")).toContain("```sh\ngit status\n```");
  });
});

describe("schedule view shape", () => {
  it("view fields stay client-safe primitives", () => {
    const view: ScheduleView = toScheduleView(daemonSchedule(), [], []);
    expect(Object.values(view).every((value) => value === null || ["string", "boolean", "number", "object"].includes(typeof value))).toBe(true);
  });
});
