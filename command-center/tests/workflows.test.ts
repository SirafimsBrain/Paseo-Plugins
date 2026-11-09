import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "../server/executor";
import { loadHistory, saveCommands } from "../server/store";
import type { CommandDefinition, WorkflowStep } from "../shared/commands";

/**
 * Workflows (0.7.0): one command type that chains saved prompt/shell commands
 * with a per-step condition. These tests pin the execution contract — order,
 * conditions relative to the previous step, one history entry per workflow,
 * and the pre-flight validation that keeps a half-missing chain from running.
 */

function fakePaseo() {
  const sent: string[] = [];
  const createdAgents: Record<string, unknown>[] = [];
  const written: { terminalId: string; text: string }[] = [];

  const paseo = {
    workspaces: {
      list: async () => ({
        entries: [
          {
            id: "ws_1",
            name: "paseo-plugins",
            workspaceDirectory: "/disk/paseo-plugins",
            projectRootPath: null,
          },
        ],
      }),
    },
    agents: {
      list: async () => ({ entries: [] }),
      create: async (request: Record<string, unknown>) => {
        const agent = { id: `agent_${createdAgents.length + 1}`, request };
        createdAgents.push(agent);
        return agent;
      },
      ref: (agentId: string) => ({
        send: async (text: string) => {
          sent.push(text);
          return { ok: true };
        },
      }),
    },
    terminals: {
      create: async () => {
        const id = `term_${written.length + 1}`;
        return {
          id,
          write: (text: string) => {
            written.push({ terminalId: id, text });
          },
        };
      },
    },
  };

  return { paseo, sent, createdAgents, written };
}

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "One",
    type: "prompt",
    template: "Do it",
    variables: [],
    steps: [],
    scope: "global",
    provider: "claude/opus-4.6",
    favorite: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

function workflow(steps: WorkflowStep[], overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return command({
    id: "wf",
    name: "Nightly",
    type: "workflow",
    template: "",
    provider: undefined,
    steps,
    ...overrides,
  });
}

const homes: string[] = [];

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "cc-workflow-"));
  homes.push(home);
  process.env.PASEO_HOME = home;
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-11-09T10:00:00.000Z");

describe("workflow execution", () => {
  it("runs steps in order and records one history entry with a step summary", async () => {
    const shell = command({ id: "step_shell", name: "Build", type: "shell", template: "npm run build", provider: undefined });
    const prompt = command({ id: "step_prompt", name: "Review", template: "Review the build" });
    saveCommands([shell, prompt]);

    const { paseo, sent, createdAgents, written } = fakePaseo();
    const result = await executeCommand(
      workflow([
        { commandId: "step_shell", condition: "always" },
        { commandId: "step_prompt", condition: "on-success" },
      ]),
      { values: {}, workspaceId: "ws_1", newWorktree: false },
      { paseo: paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("workflow");
    // Shell step: the rendered line plus a newline. Prompt step: one new agent.
    expect(written.map((entry) => entry.text)).toEqual(["npm run build", "\n"]);
    expect(createdAgents).toHaveLength(1);
    expect(sent).toHaveLength(0);

    const history = loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      commandId: "wf",
      kind: "workflow",
      ok: true,
      error: null,
      targetWorkspaceId: "ws_1",
    });
    expect(history[0]!.steps).toEqual([
      {
        commandId: "step_shell",
        commandName: "Build",
        condition: "always",
        kind: "terminal",
        ok: true,
        error: null,
        skipped: false,
      },
      {
        commandId: "step_prompt",
        commandName: "Review",
        condition: "on-success",
        kind: "new-agent",
        ok: true,
        error: null,
        skipped: false,
      },
    ]);
    // The whole chain is one entry: the prompt step must not append its own.
    expect(history.filter((entry) => entry.commandId === "step_prompt")).toHaveLength(0);
  });

  it("evaluates conditions against the previous step and keeps going after a failure", async () => {
    // A prompt command without a provider fails at dispatch; the shell steps
    // around it prove that `always` still runs and `on-success` is skipped.
    const broken = command({ id: "broken", name: "Broken", provider: undefined });
    const cleanup = command({ id: "cleanup", name: "Cleanup", type: "shell", template: "rm -rf dist", provider: undefined });
    const notify = command({ id: "notify", name: "Notify", type: "shell", template: "echo done", provider: undefined });
    saveCommands([broken, cleanup, notify]);

    const { paseo, written } = fakePaseo();
    const result = await executeCommand(
      workflow([
        { commandId: "broken", condition: "always" },
        { commandId: "cleanup", condition: "on-failure" },
        { commandId: "notify", condition: "on-success" },
      ]),
      { values: {}, workspaceId: "ws_1", newWorktree: false },
      { paseo: paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no provider configured");
    // Only the on-failure step ran after the failing one.
    expect(written.map((entry) => entry.text)).toEqual(["rm -rf dist", "\n"]);

    const entry = loadHistory()[0]!;
    expect(entry.ok).toBe(false);
    expect(entry.steps!.map((step) => [step.commandName, step.skipped, step.ok])).toEqual([
      ["Broken", false, false],
      ["Cleanup", false, true],
      ["Notify", true, false],
    ]);
  });

  it("refuses to run when a step command no longer exists", async () => {
    saveCommands([command({ id: "kept", name: "Kept" })]);
    const { paseo, createdAgents, written } = fakePaseo();

    const result = await executeCommand(
      workflow([
        { commandId: "kept", condition: "always" },
        { commandId: "deleted", condition: "always" },
      ]),
      { values: {}, workspaceId: "ws_1", newWorktree: false },
      { paseo: paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer exists");
    // Pre-flight validation: nothing was dispatched.
    expect(createdAgents).toHaveLength(0);
    expect(written).toHaveLength(0);
    const entry = loadHistory()[0]!;
    expect(entry.ok).toBe(false);
    expect(entry.steps).toEqual([]);
  });

  it("rejects nested workflows", async () => {
    const inner = workflow([{ commandId: "leaf", condition: "always" }], { id: "inner", name: "Inner" });
    const leaf = command({ id: "leaf", name: "Leaf" });
    saveCommands([inner, leaf]);
    const { paseo } = fakePaseo();

    const result = await executeCommand(
      workflow([{ commandId: "inner", condition: "always" }]),
      { values: {}, workspaceId: "ws_1", newWorktree: false },
      { paseo: paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be nested");
  });

  it("reports a workflow whose conditions kept every step from running", async () => {
    saveCommands([command({ id: "only", name: "Only", type: "shell", template: "echo hi", provider: undefined })]);
    const { paseo, written } = fakePaseo();

    const result = await executeCommand(
      workflow([{ commandId: "only", condition: "on-success" }]),
      { values: {}, workspaceId: "ws_1", newWorktree: false },
      { paseo: paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No step ran");
    expect(written).toHaveLength(0);
    expect(loadHistory()[0]!.steps!.map((step) => step.skipped)).toEqual([true]);
  });

  it("passes workflow values through to step templates", async () => {
    const greet = command({ id: "greet", name: "Greet", template: "Hello {{input:who|world}}" });
    saveCommands([greet]);
    const { paseo, createdAgents } = fakePaseo();

    const result = await executeCommand(
      workflow([{ commandId: "greet", condition: "always" }]),
      { values: { who: "Paseo" }, workspaceId: "ws_1", newWorktree: false },
      { paseo: paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(true);
    expect(createdAgents[0]!.request).toMatchObject({ prompt: "Hello Paseo" });
  });
});
