import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import contribute from "../index.server";
import { rememberAgentMcp } from "../server/agent-mcp";
import { clearHistoryStore, loadCommands, loadHistory } from "../server/store";
import type { CommandDefinition } from "../shared/commands";

const homes: string[] = [];
let currentHome = "";

beforeEach(() => {
  currentHome = mkdtempSync(path.join(tmpdir(), "cc-rpc-"));
  homes.push(currentHome);
  process.env.PASEO_HOME = currentHome;
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

type Handler = (input: never, ctx: { paseo: unknown }) => unknown;
const handlers = new Map<string, Handler>();
/** `addHook` registrations, keyed by the 0.15.0 hook name. */
const hooks = new Map<string, Handler>();

function fakeServer(): never {
  return {
    handle(rpc: { name: string }, handler: Handler) {
      handlers.set(rpc.name, handler);
    },
    registerSettings() {
      const listeners = new Set<(state: { status: string }) => void>();
      return {
        read: async () => ({
          status: "ready",
          revision: "r1",
          values: { historyLimit: 50, defaultProvider: "", autoRunCommandOnTurnEnd: "", bootstrapCommand: "" },
        }),
        subscribe: (listener: (state: { status: string }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
    addHook(name: string, handler: Handler) {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
  } as never;
}

function call(name: string, input: unknown, paseo: unknown = {}): unknown {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler registered for ${name}`);
  return handler(input as never, { paseo });
}

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "Review",
    type: "prompt",
    template: "Review {{input:pr}}",
    variables: [],
    steps: [],
    scope: "global",
    provider: "claude/opus-4.6",
    favorite: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    useCount: 3,
    ...overrides,
  };
}

describe("command-center RPC handlers", () => {
  beforeEach(() => {
    handlers.clear();
    hooks.clear();
    contribute(fakeServer());
  });

  it("list returns an empty library on a fresh home", () => {
    expect(call("command-center.list", {})).toEqual({ commands: [] });
  });

  it("save creates, lists and sorts by name", () => {
    call("command-center.save", { command: command({ id: "b", name: "Beta" }) });
    call("command-center.save", { command: command({ id: "a", name: "Alpha" }) });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(loadCommands()).toHaveLength(2);
  });

  it("save preserves the server-side useCount of an existing command", () => {
    call("command-center.save", { command: command() });
    call("command-center.save", { command: command({ useCount: 999 }) });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.find((entry) => entry.id === "cmd_1")?.useCount).toBe(3);
  });

  it("run increments the stored useCount of the command", async () => {
    call("command-center.save", { command: command() });
    const paseo = {
      workspaces: { list: async () => ({ entries: [] }) },
      agents: {
        list: async () => ({ entries: [] }),
        create: async () => ({ id: "ag_count" }),
      },
    };
    await call("command-center.run", { commandId: "cmd_1", values: { pr: "#1" }, newWorktree: false }, paseo);
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.find((entry) => entry.id === "cmd_1")?.useCount).toBe(4);
  });

  it("save reports validation failures instead of writing a bad record", () => {
    const result = call("command-center.save", {
      command: command({ template: "" }),
    }) as { saved: boolean; error: string | null };
    expect(result.saved).toBe(false);
    expect(result.error).toBeTruthy();
    expect(loadCommands()).toEqual([]);
  });

  it("save supports delete+save in one atomic-ish call", () => {
    call("command-center.save", { command: command() });
    call("command-center.save", {
      command: command({ id: "cmd_2", name: "Deploy" }),
      deleteId: "cmd_1",
    });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.map((entry) => entry.id)).toEqual(["cmd_2"]);
  });

  it("delete removes only the targeted command", () => {
    call("command-center.save", { command: command() });
    call("command-center.save", { command: command({ id: "cmd_2" }) });
    call("command-center.delete", { id: "cmd_1" });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.map((entry) => entry.id)).toEqual(["cmd_2"]);
  });

  it("favorite toggles an existing command and reports unknown ids", () => {
    call("command-center.save", { command: command() });
    expect(call("command-center.favorite", { id: "cmd_1", favorite: true })).toEqual({ ok: true });
    expect(call("command-center.favorite", { id: "nope", favorite: true })).toEqual({ ok: false });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands[0]?.favorite).toBe(true);
  });

  it("history list/clear round-trips through the store", () => {
    clearHistoryStore();
    const listed = call("command-center.history", {}) as { entries: unknown[] };
    expect(listed.entries).toEqual([]);
  });

  it("run reports unknown commands as a failed run", async () => {
    const result = (await call("command-center.run", {
      commandId: "missing",
      values: {},
    })) as { ok: boolean; error: string | null };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown command");
  });

  it("run executes a prompt against the paseo api", async () => {
    call("command-center.save", { command: command() });
    const created: Record<string, unknown>[] = [];
    const paseo = {
      workspaces: { list: async () => ({ entries: [] }) },
      agents: {
        list: async () => ({ entries: [] }),
        create: async (request: Record<string, unknown>) => {
          created.push(request);
          return { id: "ag_new" };
        },
      },
    };
    const result = (await call(
      "command-center.run",
      { commandId: "cmd_1", values: { pr: "#7" }, newWorktree: false },
      paseo,
    )) as { ok: boolean; agentId: string | null };
    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("ag_new");
    expect(created[0]).toMatchObject({ prompt: "Review #7" });
  });

  it("run-batch fans out to several targets and counts every success", async () => {
    call("command-center.save", { command: command() });
    const created: Record<string, unknown>[] = [];
    const paseo = {
      workspaces: {
        list: async () => ({
          entries: [
            { id: "ws_1", name: "dev", workspaceDirectory: "/disk/dev", projectRootPath: null },
            { id: "ws_2", name: "prod", workspaceDirectory: "/disk/prod", projectRootPath: null },
          ],
        }),
      },
      agents: {
        list: async () => ({ entries: [] }),
        create: async (request: Record<string, unknown>) => {
          created.push(request);
          return { id: `ag_${created.length}` };
        },
      },
    };
    const result = (await call(
      "command-center.run-batch",
      {
        commandId: "cmd_1",
        values: { pr: "#9" },
        targets: [{ workspaceId: "ws_1" }, { workspaceId: "ws_2", provider: "other/model" }],
      },
      paseo,
    )) as { results: { ok: boolean; workspaceId: string | null }[] };
    expect(result.results).toHaveLength(2);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(result.results.map((entry) => entry.workspaceId)).toEqual(["ws_1", "ws_2"]);
    expect(created[1]).toMatchObject({ config: { provider: "other/model" } });
    const listed = call("command-center.list", {}) as { commands: CommandDefinition[] };
    expect(listed.commands.find((entry) => entry.id === "cmd_1")?.useCount).toBe(5);
    expect(loadHistory()).toHaveLength(2);
  });

  it("run-batch reports unknown commands per target", async () => {
    const result = (await call(
      "command-center.run-batch",
      { commandId: "missing", values: {}, targets: [{}, {}] },
      {},
    )) as { results: { ok: boolean; error: string | null }[] };
    expect(result.results).toHaveLength(2);
    expect(result.results.every((entry) => !entry.ok)).toBe(true);
  });

  it("history-append stores a remote run with a stamped id", () => {
    const result = call("command-center.history-append", {
      entry: {
        commandId: "cmd_1",
        commandName: "Review",
        rendered: "Review #remote",
        targetWorkspaceId: "ws_remote",
        targetAgentId: "ag_remote",
        kind: "new-agent",
        ok: true,
        error: null,
      },
    }) as { ok: boolean; id: string | null };
    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();
    const listed = call("command-center.history", {}) as {
      entries: { id: string; rendered: string; at: string }[];
    };
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({ id: result.id, rendered: "Review #remote" });
    expect(typeof listed.entries[0]!.at).toBe("string");
  });

  it("run passes the command mcpServers into the created agent config", async () => {
    call("command-center.save", {
      command: command({
        mcpServers: { github: { type: "http", url: "https://api.github.com/mcp" } },
      }),
    });
    const created: unknown[] = [];
    const paseo = {
      workspaces: { list: async () => ({ entries: [] }) },
      agents: {
        list: async () => ({ entries: [] }),
        create: async (input: unknown) => {
          created.push(input);
          return { id: "ag_mcp" };
        },
      },
    };
    const result = (await call("command-center.run", {
      commandId: "cmd_1",
      values: { pr: "#1" },
      newWorktree: false,
    }, paseo)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      config: { mcpServers: { github: { type: "http", url: "https://api.github.com/mcp" } } },
    });
  });

  it("attachment-search finds commands by name and returns picker-ready items", () => {
    call("command-center.save", { command: command({ name: "Nightly Review" }) });
    call("command-center.save", {
      command: command({ id: "cmd_2", name: "Deploy", template: "deploy to prod" }),
    });
    const result = call("command-center.attachment-search", { query: "review" }) as {
      items: { id: string; title: string; text: string; url: string; resourceType: string }[];
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "cmd_1",
      title: "Nightly Review",
      text: "Review {{input:pr}}",
      resourceType: "prompt-command",
    });
    expect(result.items[0]!.url.startsWith("command-center://command/")).toBe(true);
  });

  it("attachment-search returns everything for an empty query", () => {
    call("command-center.save", { command: command() });
    const result = call("command-center.attachment-search", { query: "" }) as {
      items: unknown[];
    };
    expect(result.items).toHaveLength(1);
  });
});

describe("0.6.0: session-open hook and the agent-reload RPC", () => {
  beforeEach(() => {
    handlers.clear();
    hooks.clear();
    contribute(fakeServer());
  });

  function hookPaseo(supportsMcpServers = true) {
    return {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { capabilities: { supportsMcpServers } } }),
          reload: async () => ({ agent: { title: "Refurbed" } }),
        }),
      },
    };
  }

  function sessionOpenRequest(overrides: Record<string, unknown> = {}) {
    return {
      agentId: "ag_hook",
      workspaceId: "ws_1",
      provider: "claude/opus-4.6",
      cwd: "/disk/plugins",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      env: {},
      mcpServers: {},
      ...overrides,
    } as never;
  }

  async function runHook(request: unknown, paseo: unknown) {
    const hook = hooks.get("agent.open.before");
    if (!hook) throw new Error("agent.open.before hook not registered");
    return (await hook({ request } as never, { paseo } as never)) as {
      tools: { name: string }[];
      mcpServers: Record<string, unknown>;
    };
  }

  function writeAgentRecord(agentId: string, mcpServers: unknown): void {
    mkdirSync(`${process.env.PASEO_HOME}/agents/ws-slug`, { recursive: true });
    writeFileSync(
      `${process.env.PASEO_HOME}/agents/ws-slug/${agentId}.json`,
      JSON.stringify({ config: { mcpServers } }),
      "utf-8",
    );
  }

  it("registers all four lifecycle hooks under their 0.15.0 names", () => {
    expect(hooks.has("agent.open.before")).toBe(true);
    expect(hooks.has("agent.archive.after")).toBe(true);
    expect(hooks.has("agent.turn.after")).toBe(true);
    expect(hooks.has("workspace.create.after")).toBe(true);
  });

  it("attaches the command_center_run tool on interactive opens", async () => {
    const result = await runHook(sessionOpenRequest(), hookPaseo());
    expect(result.tools.map((tool) => tool.name)).toEqual(["command_center_run"]);
    expect(result.mcpServers).toEqual({});
  });

  it("adds no tool and no servers for purpose history", async () => {
    writeAgentRecord("ag_hook", {});
    rememberAgentMcp("ag_hook", { github: { type: "http", url: "https://api.github.com/mcp" } }, "Review");
    const result = await runHook(sessionOpenRequest({ purpose: "history" }), hookPaseo());
    expect(result.tools).toEqual([]);
    expect(result.mcpServers).toEqual({});
  });

  it("contributes registry servers the saved config lacks", async () => {
    writeAgentRecord("ag_hook", {});
    rememberAgentMcp("ag_hook", { github: { type: "http", url: "https://api.github.com/mcp" } }, "Review");
    const result = await runHook(sessionOpenRequest(), hookPaseo());
    expect(result.mcpServers).toEqual({ github: { type: "http", url: "https://api.github.com/mcp" } });
    expect(result.tools.map((tool) => tool.name)).toEqual(["command_center_run"]);
  });

  it("skips a name the saved configuration already carries", async () => {
    writeAgentRecord("ag_hook", { github: { type: "http", url: "https://api.github.com/mcp" } });
    rememberAgentMcp("ag_hook", { github: { type: "http", url: "https://api.github.com/mcp" } }, "Review");
    const result = await runHook(sessionOpenRequest(), hookPaseo());
    expect(result.mcpServers).toEqual({});
  });

  it("fails safe to skip when the provider cannot do MCP", async () => {
    writeAgentRecord("ag_hook", {});
    rememberAgentMcp("ag_hook", { github: { type: "http", url: "https://api.github.com/mcp" } }, "Review");
    const result = await runHook(sessionOpenRequest(), hookPaseo(false));
    expect(result.mcpServers).toEqual({});
    // The tool survives — it cannot collide with anything.
    expect(result.tools.map((tool) => tool.name)).toEqual(["command_center_run"]);
  });

  it("agent-reload reopens the session through agents.ref(id).reload()", async () => {
    const result = (await call("command-center.agent-reload", { agentId: "ag_1" }, hookPaseo())) as {
      ok: boolean;
      title: string | null;
      error: string | null;
    };
    expect(result).toEqual({ ok: true, title: "Refurbed", error: null });
  });

  it("agent-reload surfaces reload failures instead of throwing", async () => {
    const paseo = {
      agents: { ref: () => ({ reload: async () => { throw new Error("session is busy"); } }) },
    };
    const result = (await call("command-center.agent-reload", { agentId: "ag_1" }, paseo)) as {
      ok: boolean;
      error: string | null;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("busy");
  });
});
