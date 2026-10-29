import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { agentReload } from "../shared/memories";
import { agentsRoot, paseoHome, readSavedMcpServers, savedServersInclude } from "../server/agent-record";
import { decideSessionOpen, type SessionOpenInput } from "../server/session-open";
import { createMemoryRecallTool } from "../server/agent-tools";
import { MemoryStore } from "../server/store";
import { handleJsonRpcRequest, MCP_INSTRUCTIONS, PROTOCOL_VERSION } from "../server/mcp-jsonrpc";

/**
 * 0.9.4 coverage: the `agent.session_open` contribution, the read-only recall
 * tool, the repair RPC and the MCP `instructions`.
 *
 * The decision logic lives in `server/session-open.ts` and the record reader in
 * `server/agent-record.ts`, both pure/injectable, so most of the matrix below
 * runs without a daemon. The `contribute()` block then proves the wiring: the
 * hook is registered, reads settings, consults the daemon for capabilities and
 * returns the contribution Paseo merges.
 */

let tempHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-flash-hooks-"));
  savedHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = tempHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** Writes an agent record the way the daemon stores it. */
function writeAgentRecord(
  agentId: string,
  config: unknown,
  workspace = "ws-one",
): string {
  const dir = path.join(tempHome, "agents", workspace);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentId}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: agentId, createdAt: "2026-01-01T00:00:00.000Z", config }));
  return file;
}

// ---------------------------------------------------------------------------

describe("readSavedMcpServers", () => {
  it("reads the saved MCP names from the daemon's agent record", () => {
    writeAgentRecord("ag-1", { provider: "opencode", mcpServers: { "memory-flash": {}, other: {} } });
    const lookup = readSavedMcpServers("ag-1", agentsRoot());
    expect(lookup.status).toBe("found");
    expect(savedServersInclude(lookup, "memory-flash")).toBe(true);
    expect(savedServersInclude(lookup, "bunny-search")).toBe(false);
  });

  it("treats a record without mcpServers as an empty saved set", () => {
    writeAgentRecord("ag-2", { provider: "claude" });
    expect(readSavedMcpServers("ag-2", agentsRoot())).toEqual({
      status: "found",
      savedServers: [],
    });
  });

  it("reports a missing record instead of guessing", () => {
    // The root exists but holds no record for this agent.
    fs.mkdirSync(path.join(tempHome, "agents"), { recursive: true });
    expect(readSavedMcpServers("ag-missing", agentsRoot()).status).toBe("missing");
  });

  it("fails safe when the record has no config or is not JSON", () => {
    const dir = path.join(tempHome, "agents", "ws-one");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ag-noconfig.json"), JSON.stringify({ id: "ag-noconfig" }));
    fs.writeFileSync(path.join(dir, "ag-bad.json"), "{not json");

    expect(readSavedMcpServers("ag-noconfig", agentsRoot()).status).toBe("unusable");
    expect(readSavedMcpServers("ag-bad", agentsRoot()).status).toBe("unusable");
  });

  it("fails safe when the agents root does not exist", () => {
    const lookup = readSavedMcpServers("ag-1", path.join(tempHome, "nope"));
    expect(lookup.status).toBe("unusable");
  });

  it("resolves the home from PASEO_HOME", () => {
    expect(paseoHome()).toBe(tempHome);
  });
});

// ---------------------------------------------------------------------------

function input(overrides: Partial<SessionOpenInput> = {}): SessionOpenInput {
  return {
    reason: "resume",
    purpose: "interactive",
    provider: "opencode",
    injectIntoAgents: true,
    serverName: "memory-flash",
    configCovered: false,
    lookup: { status: "found", savedServers: [] },
    supportsMcpServers: true,
    ...overrides,
  };
}

describe("decideSessionOpen", () => {
  it("injects a launch-only server when the saved configuration lacks it", () => {
    const decision = decideSessionOpen(input());
    expect(decision.injectMcp).toBe(true);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("saved configuration has no such server");
  });

  it("never injects on create — the agent.create hook owns that path", () => {
    const decision = decideSessionOpen(input({ reason: "create" }));
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("agent.create");
  });

  it("never injects a name the saved configuration already carries (collision)", () => {
    const decision = decideSessionOpen(
      input({ lookup: { status: "found", savedServers: ["memory-flash"] } }),
    );
    expect(decision.injectMcp).toBe(false);
    // The agent already has its MCP server, so nothing to attach either.
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("collision");
  });

  it("attaches the recall tool when the server cannot be contributed", () => {
    for (const overrides of [
      { supportsMcpServers: false },
      { supportsMcpServers: null },
      { lookup: { status: "missing" as const } },
      { lookup: { status: "unusable" as const, reason: "no config" } },
    ]) {
      const decision = decideSessionOpen(input(overrides));
      expect(decision.injectMcp, JSON.stringify(overrides)).toBe(false);
      expect(decision.attachTool, JSON.stringify(overrides)).toBe(true);
    }
  });

  it("honours the injectIntoAgents switch and the history purpose", () => {
    expect(decideSessionOpen(input({ injectIntoAgents: false }))).toMatchObject({
      injectMcp: false,
      attachTool: false,
    });
    expect(decideSessionOpen(input({ purpose: "history" }))).toMatchObject({
      injectMcp: false,
      attachTool: false,
    });
  });

  it("skips everything when a config-file registration covers the provider", () => {
    const decision = decideSessionOpen(input({ configCovered: true }));
    expect(decision.injectMcp).toBe(false);
    // The config file already provides the server, so attaching a second read
    // path would duplicate it (§13.1: one name, one owner).
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("0.8.2");
  });
});

// ---------------------------------------------------------------------------

interface FakeServer extends PluginServerContext {
  call<T>(name: string, input: unknown, context?: unknown): Promise<T>;
  runSessionOpenHook(
    request: Record<string, unknown>,
    context?: unknown,
  ): Promise<Record<string, unknown>>;
  setSettings(values: Record<string, unknown>): void;
  handlers: Map<string, (input: never, context: never) => unknown>;
}

/** `paseo` stub for hook/RPC contexts; `supportsMcpServers` is configurable. */
function fakeContext(supportsMcpServers: boolean | null = true) {
  return {
    paseo: {
      agents: {
        ref: (agentId: string) => ({
          refresh: async () =>
            supportsMcpServers === null
              ? null
              : { agent: { id: agentId, capabilities: { supportsMcpServers } } },
          reload: async () => (supportsMcpServers === null ? null : { agent: { id: agentId } }),
        }),
      },
    },
    signal: new AbortController().signal,
  };
}

function createFakeServer(initial: Record<string, unknown>): FakeServer {
  const handlers = new Map<string, (input: never, context: never) => unknown>();
  const hooks = new Map<string, (input: never, context: never) => unknown>();
  let settingsState: { status: "ready"; revision: string; values: Record<string, unknown> } = {
    status: "ready",
    revision: "1",
    values: initial,
  };

  const server = {
    registerSettings() {
      return {
        async read() {
          return settingsState;
        },
        subscribe() {
          return () => {};
        },
      };
    },
    handle(contract: { name: string }, handler: (input: never, context: never) => unknown) {
      handlers.set(contract.name, handler);
    },
    before(name: string, handler: (input: never, context: never) => unknown) {
      hooks.set(name, handler);
      return () => {
        hooks.delete(name);
      };
    },
    on() {
      return () => {};
    },
    registerProvider() {},
    async call<T>(name: string, input: unknown, context?: unknown): Promise<T> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      return (await handler(input as never, (context ?? fakeContext()) as never)) as T;
    },
    async runSessionOpenHook(
      request: Record<string, unknown>,
      context?: unknown,
    ): Promise<Record<string, unknown>> {
      const hook = hooks.get("agent.session_open");
      if (!hook) throw new Error("agent.session_open hook not registered");
      const result = await hook({ request } as never, (context ?? fakeContext()) as never);
      return (result ?? request) as Record<string, unknown>;
    },
    setSettings(values: Record<string, unknown>) {
      settingsState = { status: "ready", revision: "2", values };
    },
    handlers,
  };
  return server as unknown as FakeServer;
}

function defaults(): Record<string, unknown> {
  return {
    injectIntoAgents: true,
    mcpServerName: "memory-flash",
    historyPerMemory: 50,
    defaultAgentId: "",
    httpEnabled: false,
    httpHost: "127.0.0.1",
    httpPort: 8787,
  };
}

const AGENT = "11111111-2222-4333-8444-555555555555";

describe("agent.session_open hook (contribution wiring)", () => {
  it("contributes the launch-only server when the agent has none saved", async () => {
    writeAgentRecord(AGENT, { provider: "opencode" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runSessionOpenHook({
      agentId: AGENT,
      workspaceId: "ws",
      provider: "opencode",
      cwd: "/tmp/x",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      env: {},
      mcpServers: {},
    });

    const servers = request.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["memory-flash"]);
    expect(servers["memory-flash"]).toMatchObject({ type: "stdio", alwaysLoad: true });
    expect(request.tools).toEqual([]);
    cleanup();
  });

  it("leaves the request untouched when the saved configuration already carries the server", async () => {
    writeAgentRecord(AGENT, { provider: "opencode", mcpServers: { "memory-flash": {} } });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const original = {
      agentId: AGENT,
      workspaceId: "ws",
      provider: "opencode",
      cwd: "/tmp/x",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      env: {},
      mcpServers: {},
    };
    const request = await server.runSessionOpenHook(original);
    expect(request.mcpServers).toEqual({});
    expect(request.tools).toEqual([]);
    cleanup();
  });

  it("does nothing for reason=create and for purpose=history", async () => {
    writeAgentRecord(AGENT, { provider: "opencode" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    for (const overrides of [
      { reason: "create", purpose: "interactive" },
      { reason: "resume", purpose: "history" },
    ]) {
      const request = await server.runSessionOpenHook({
        agentId: AGENT,
        workspaceId: "ws",
        provider: "opencode",
        cwd: "/tmp/x",
        title: null,
        labels: {},
        tools: [],
        env: {},
        mcpServers: {},
        ...overrides,
      });
      expect(request.mcpServers).toEqual({});
      expect(request.tools).toEqual([]);
    }
    cleanup();
  });

  it("attaches the recall tool when the server cannot be contributed", async () => {
    // No record on disk → the saved set is unknown, so the MCP contribution is
    // refused and the read-only tool is offered instead.
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runSessionOpenHook({
      agentId: AGENT,
      workspaceId: "ws",
      provider: "opencode",
      cwd: "/tmp/x",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      env: {},
      mcpServers: {},
    });

    expect(request.mcpServers).toEqual({});
    const tools = request.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["memory_flash_recall"]);
    cleanup();
  });

  it("does not contribute when the provider cannot use MCP servers", async () => {
    writeAgentRecord(AGENT, { provider: "weird" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runSessionOpenHook(
      {
        agentId: AGENT,
        workspaceId: "ws",
        provider: "weird",
        cwd: "/tmp/x",
        reason: "resume",
        purpose: "interactive",
        title: null,
        labels: {},
        tools: [],
        env: {},
        mcpServers: {},
      },
      fakeContext(false),
    );

    expect(request.mcpServers).toEqual({});
    const tools = request.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["memory_flash_recall"]);
    cleanup();
  });

  it("skips the server when injection is turned off in settings", async () => {
    writeAgentRecord(AGENT, { provider: "opencode" });
    const server = createFakeServer({ ...defaults(), injectIntoAgents: false });
    const cleanup = contribute(server);

    const request = await server.runSessionOpenHook({
      agentId: AGENT,
      workspaceId: "ws",
      provider: "opencode",
      cwd: "/tmp/x",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      env: {},
      mcpServers: {},
    });

    expect(request.mcpServers).toEqual({});
    expect(request.tools).toEqual([]);
    cleanup();
  });

  it("registers and removes both hooks", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    await server.runSessionOpenHook({
      agentId: AGENT,
      workspaceId: "ws",
      provider: "opencode",
      cwd: "/tmp/x",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      env: {},
      mcpServers: {},
    });
    cleanup();
    await expect(
      server.runSessionOpenHook({
        agentId: AGENT,
        workspaceId: "ws",
        provider: "opencode",
        cwd: "/tmp/x",
        reason: "resume",
        purpose: "interactive",
        title: null,
        labels: {},
        tools: [],
        env: {},
        mcpServers: {},
      }),
    ).rejects.toThrow(/not registered/);
  });
});

// ---------------------------------------------------------------------------

describe("repair RPC (agents.ref().reload)", () => {
  it("reloads the agent and reports success", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    const result = await server.call<{ ok: boolean; error: string | null }>(
      agentReload.name,
      { agentId: AGENT },
    );
    expect(result).toEqual({ ok: true, error: null });
    cleanup();
  });

  it("reports a refused reload instead of throwing", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    const result = await server.call<{ ok: boolean; error: string | null }>(
      agentReload.name,
      { agentId: AGENT },
      fakeContext(null), // refresh/reload return null → not reloadable
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    cleanup();
  });
});

// ---------------------------------------------------------------------------

describe("memory_flash_recall tool", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-flash-recall-"));
    store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns matching memories with their snippet", () => {
    store.create(
      {
        kind: "bugfix",
        title: "Fix WAL checkpoint stall",
        content: "Symptom: writes stall until the checkpoint finishes.",
        tags: ["paseo-plugins", "sqlite"],
        project: "paseo-plugins",
        agentId: "tester",
      },
      "tester",
    );
    const tool = createMemoryRecallTool(store);
    const result = tool.execute(
      { query: "checkpoint stall" },
      fakeContextWithAgent(),
    ) as { text: string; structuredContent: { count: number; ids: number[] } };
    expect(result.structuredContent.count).toBe(1);
    expect(result.text).toContain("Fix WAL checkpoint stall");
    expect(result.text).toContain("memory-flash_* MCP tools");
  });

  it("fetches one memory by id", () => {
    const memory = store.create(
      {
        kind: "decision",
        title: "Use RRF",
        content: "Rank fusion over several FTS5 views.",
        tags: ["search"],
        project: null,
        agentId: null,
      },
      "tester",
    );
    const tool = createMemoryRecallTool(store);
    const result = tool.execute({ query: "", id: memory.id }, fakeContextWithAgent()) as {
      text: string;
    };
    expect(result.text).toContain("Use RRF");
    expect(result.text).toContain("Rank fusion");
  });

  it("explains an empty result instead of pretending the base is empty", () => {
    const tool = createMemoryRecallTool(store);
    const result = tool.execute({ query: "nothing here" }, fakeContextWithAgent()) as {
      text: string;
      structuredContent: { count: number };
    };
    expect(result.structuredContent.count).toBe(0);
    expect(result.text).toContain("retry with different words");
  });

  it("reports a missing id without failing", () => {
    const tool = createMemoryRecallTool(store);
    const result = tool.execute({ query: "", id: 999 }, fakeContextWithAgent()) as {
      text: string;
    };
    expect(result.text).toContain("No memory #999");
  });
});

function fakeContextWithAgent(): AgentToolContext {
  return {
    agent: {
      id: "tester",
      workspaceId: null,
      parentAgentId: null,
      provider: "opencode",
      cwd: "/tmp",
      title: null,
    },
    paseo: {} as never,
    signal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------

describe("MCP initialize instructions", () => {
  it("describes the mandatory workflow in the initialize result", () => {
    const response = handleJsonRpcRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { store: null as never, defaultAgentId: undefined },
      { name: "memory-flash", version: "0.1.1" },
    );
    const result = response?.result as {
      protocolVersion: string;
      instructions: string;
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe("memory-flash");
    expect(result.instructions).toBe(MCP_INSTRUCTIONS);
    expect(result.instructions).toContain("mandatory, not optional");
    expect(result.instructions).toContain("2-4 differently worded memory_search calls");
    expect(result.instructions).toContain("memory_handoff");
  });
});
