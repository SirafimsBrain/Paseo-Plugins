import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "../server/executor";
import { loadHistory, paseoHome } from "../server/store";
import type { CommandDefinition } from "../shared/commands";

function fakePaseo(overrides: {
  workspaces?: unknown[];
  agents?: unknown[];
  agentsListFails?: boolean;
} = {}) {
  const sent: string[] = [];
  const createdAgents: Record<string, unknown>[] = [];
  const written: { terminalId: string; text: string }[] = [];
  const terminals: Record<string, unknown>[] = [];

  const paseo = {
    workspaces: {
      list: async () => ({ entries: overrides.workspaces ?? [] }),
    },
    agents: {
      list: async () => {
        if (overrides.agentsListFails) throw new Error("rpc down");
        return { entries: overrides.agents ?? [] };
      },
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
      create: async (request: Record<string, unknown>) => {
        const terminal = { id: `term_${terminals.length + 1}`, request };
        terminals.push(terminal);
        return {
          id: terminal.id,
          write: (text: string) => {
            written.push({ terminalId: terminal.id, text });
          },
        };
      },
    },
  };

  return { paseo, sent, createdAgents, written, terminals };
}

function promptCommand(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "Say hi",
    type: "prompt",
    template: "Hi {{input:who}} in {{workspace.name}} on {{date}}",
    variables: [],
    scope: "global",
    provider: "claude/opus-4.6",
    favorite: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

const fixedNow = () => new Date("2026-09-22T12:30:00.000Z");
const workspace = {
  id: "ws_1",
  name: "paseo-plugins",
  workspaceDirectory: "/disk/paseo-plugins",
  projectRootPath: null,
};

const homes: string[] = [];
let currentHome = "";

beforeEach(() => {
  currentHome = mkdtempSync(path.join(tmpdir(), "cc-executor-"));
  homes.push(currentHome);
  process.env.PASEO_HOME = currentHome;
});

afterEach(() => {
  delete process.env.PASEO_HOME;
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("executeCommand", () => {
  it("creates a new agent with the rendered prompt and provider", async () => {
    const fake = fakePaseo({ workspaces: [workspace] });
    const result = await executeCommand(
      promptCommand(),
      { values: { who: "team" }, newWorktree: false },
      { paseo: fake.paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("new-agent");
    expect(result.agentId).toBe("agent_1");
    expect(fake.createdAgents[0]!.request).toMatchObject({
      config: { provider: "claude/opus-4.6" },
      prompt: "Hi team in paseo-plugins on 2026-09-22",
      title: "Say hi",
    });
  });

  it("sends to an existing, non-archived agent", async () => {
    const fake = fakePaseo({
      workspaces: [workspace],
      agents: [{ id: "ag_1", archivedAt: null }],
    });
    const result = await executeCommand(
      promptCommand(),
      { values: { who: "again" }, agentId: "ag_1", newWorktree: false },
      { paseo: fake.paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("existing-agent");
    expect(fake.sent).toEqual(["Hi again in paseo-plugins on 2026-09-22"]);
  });

  it("refuses to send to an archived agent", async () => {
    const fake = fakePaseo({
      workspaces: [workspace],
      agents: [{ id: "ag_1", archivedAt: "2026-09-01T00:00:00.000Z" }],
    });
    const result = await executeCommand(
      promptCommand(),
      { values: {}, agentId: "ag_1", newWorktree: false },
      { paseo: fake.paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("archived");
    expect(fake.sent).toEqual([]);
  });

  it("returns a failure when no workspace exists for a shell command", async () => {
    const fake = fakePaseo({ workspaces: [] });
    const result = await executeCommand(
      promptCommand({ type: "shell", template: "git status", terminalName: "Git" }),
      { values: {}, newWorktree: false },
      { paseo: fake.paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("terminal");
    expect(result.error).toContain("No workspace");
    expect(fake.written).toEqual([]);
  });

  it("writes a rendered shell line into a new terminal", async () => {
    const fake = fakePaseo({ workspaces: [workspace] });
    const result = await executeCommand(
      promptCommand({ type: "shell", template: "git log --oneline -{{input:n|5}}" }),
      { values: {}, workspaceId: "ws_1", newWorktree: false },
      { paseo: fake.paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("terminal");
    expect(result.terminalId).toBe("term_1");
    expect(fake.written.map((entry) => entry.text)).toEqual(["git log --oneline -5", "\n"]);
  });

  it("records a history entry after a successful run", async () => {
    const fake = fakePaseo({ workspaces: [workspace] });
    await executeCommand(
      promptCommand(),
      { values: { who: "history" }, newWorktree: false },
      { paseo: fake.paseo as never, now: fixedNow },
    );

    const history = loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      commandId: "cmd_1",
      kind: "new-agent",
      ok: true,
      rendered: "Hi history in paseo-plugins on 2026-09-22",
    });
    expect(paseoHome()).toBe(currentHome);
  });

  it("maps unexpected errors to a failed RunResult instead of throwing", async () => {
    const fake = fakePaseo({ agentsListFails: true });
    const result = await executeCommand(
      promptCommand({ type: "shell", template: "ls" }),
      { values: {}, newWorktree: false },
      { paseo: fake.paseo as never, now: fixedNow },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
