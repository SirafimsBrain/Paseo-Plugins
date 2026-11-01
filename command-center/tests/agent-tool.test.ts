import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { commandCenterToolInput, createCommandCenterTool, findCommand } from "../server/agent-tool";
import { saveCommands } from "../server/store";
import type { CommandDefinition } from "../shared/commands";

const homes: string[] = [];

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "cc-agent-tool-"));
  homes.push(home);
  process.env.PASEO_HOME = home;
});

afterAll(() => {
  delete process.env.PASEO_HOME;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "Review",
    type: "prompt",
    template: "Review {{input:pr|main}}",
    variables: [],
    scope: "global",
    provider: "claude/opus-4.6",
    favorite: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

const workspace = { id: "ws_1", name: "plugins", workspaceDirectory: "/disk/plugins", projectRootPath: null };

function fakePaseo(overrides: { workspaces?: unknown[]; agentsList?: unknown[] } = {}) {
  const createdAgents: Record<string, unknown>[] = [];
  const written: { terminalId: string; text: string }[] = [];
  const paseo = {
    workspaces: { list: async () => ({ entries: overrides.workspaces ?? [] }) },
    agents: {
      list: async () => ({ entries: overrides.agentsList ?? [] }),
      create: async (request: Record<string, unknown>) => {
        const agent = { id: `agent_${createdAgents.length + 1}`, request };
        createdAgents.push(agent);
        return agent;
      },
      ref: () => ({ send: async () => ({ ok: true }) }),
    },
    terminals: {
      create: async () => {
        const id = `term_${written.length + 1}`;
        return { id, write: (text: string) => written.push({ terminalId: id, text }) };
      },
    },
  };
  return { paseo, createdAgents, written };
}

const toolContext = (paseo: unknown) => ({
  agent: {
    id: "agent_caller",
    workspaceId: "ws_1",
    parentAgentId: null,
    provider: "claude/opus-4.6",
    cwd: "/disk/plugins",
    title: "Caller",
  },
  paseo: paseo as never,
  signal: new AbortController().signal,
});

describe("command_center_run tool definition", () => {
  it("uses a host-legal tool name", () => {
    const tool = createCommandCenterTool();
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tool.name.length).toBeLessThanOrEqual(64);
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("rejects an empty command in the input schema", () => {
    expect(commandCenterToolInput.safeParse({ command: "" }).success).toBe(false);
    expect(commandCenterToolInput.safeParse({ command: "Review" }).success).toBe(true);
  });

  it("finds commands by exact id and case-insensitive name", () => {
    const commands = [command(), command({ id: "cmd_2", name: "Deploy" })];
    expect(findCommand(commands, "cmd_2")?.name).toBe("Deploy");
    expect(findCommand(commands, "deploy")?.id).toBe("cmd_2");
    expect(findCommand(commands, "missing")).toBeNull();
    expect(findCommand(commands, "   ")).toBeNull();
  });
});

describe("command_center_run execution", () => {
  it("reports an unknown command with the library listing", async () => {
    saveCommands([command()]);
    const fake = fakePaseo();
    const result = await createCommandCenterTool().execute(
      { command: "nope" },
      toolContext(fake.paseo),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown command");
    expect(result.text).toContain("Review");
  });

  it("runs a shell command in a terminal of the calling agent's workspace", async () => {
    saveCommands([
      command({ id: "cmd_shell", name: "Lint", type: "shell", template: "npm run lint -- --fix {{input:scope}}" }),
    ]);
    const fake = fakePaseo({ workspaces: [workspace] });
    const result = await createCommandCenterTool().execute(
      { command: "Lint", values: { scope: "src/" } },
      toolContext(fake.paseo),
    );
    expect(result.isError).toBeFalsy();
    expect(fake.written[0]?.text).toContain("npm run lint -- --fix src/");
    expect(result.structuredContent).toMatchObject({ kind: "terminal", workspaceId: "ws_1" });
  });

  it("creates a new agent for a prompt command with stored defaults", async () => {
    saveCommands([command()]);
    const fake = fakePaseo({ workspaces: [workspace] });
    const result = await createCommandCenterTool().execute(
      { command: "review" },
      toolContext(fake.paseo),
    );
    expect(result.isError).toBeFalsy();
    // Stored default fills the input; the calling agent is never the target.
    expect(fake.createdAgents[0]?.request).toMatchObject({
      prompt: "Review main",
      config: { provider: "claude/opus-4.6" },
      cwd: "/disk/plugins",
    });
    expect(result.structuredContent).toMatchObject({ kind: "new-agent" });
  });

  it("surfaces a dispatch failure as an error result", async () => {
    saveCommands([command({ provider: "" })]);
    const fake = fakePaseo({ workspaces: [workspace] });
    const result = await createCommandCenterTool().execute(
      { command: "Review" },
      toolContext(fake.paseo),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("failed");
    expect(fake.createdAgents).toHaveLength(0);
  });
});
