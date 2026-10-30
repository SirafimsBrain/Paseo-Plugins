import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { agentReload, type RuntimeSettings } from "../shared/contracts";
import { agentsRoot, paseoHome, readSavedMcpServers, savedServersInclude } from "../server/agent-record";
import {
  createHookOwnsCreation,
  decideSessionOpen,
  injectionGateBlockReason,
  labelGateAllows,
  needsCapabilityProbe,
  providerExcluded,
  type SessionOpenInput,
} from "../server/session-open";
import { createWebSearchTool } from "../server/agent-tools";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../server/mcp-tools";

/**
 * 0.5.2 coverage: the `agent.session_open` contribution, the injection gate, the
 * attached `bunny_web_search` tool, the repair RPC and the MCP `instructions`.
 *
 * The decision logic lives in `server/session-open.ts` and the record reader in
 * `server/agent-record.ts`, both pure/injectable, so most of the matrix below runs
 * without a daemon. The `contribute()` block then proves the wiring: both hooks are
 * registered, the create hook honours the gate it *can* evaluate, and the session-open
 * hook returns exactly the contribution Paseo merges.
 */

let tempHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-search-hooks-"));
  savedHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = tempHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Writes an agent record the way the daemon stores it. */
function writeAgentRecord(agentId: string, config: unknown, workspace = "ws-one"): string {
  const dir = path.join(tempHome, "agents", workspace);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ id: agentId, createdAt: "2026-01-01T00:00:00.000Z", config }),
  );
  return file;
}

// ---------------------------------------------------------------------------

describe("readSavedMcpServers", () => {
  it("reads the saved MCP names from the daemon's agent record", () => {
    writeAgentRecord("ag-1", { provider: "opencode", mcpServers: { "bunny-search": {}, other: {} } });
    const lookup = readSavedMcpServers("ag-1", agentsRoot());
    expect(lookup.status).toBe("found");
    expect(savedServersInclude(lookup, "bunny-search")).toBe(true);
    expect(savedServersInclude(lookup, "memory-flash")).toBe(false);
  });

  it("treats a record without mcpServers as an empty saved set", () => {
    writeAgentRecord("ag-2", { provider: "claude" });
    expect(readSavedMcpServers("ag-2", agentsRoot())).toEqual({
      status: "found",
      savedServers: [],
    });
  });

  it("reports a missing record instead of guessing", () => {
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
    expect(readSavedMcpServers("ag-1", path.join(tempHome, "nope")).status).toBe("unusable");
  });

  it("resolves the home from PASEO_HOME", () => {
    expect(paseoHome()).toBe(tempHome);
  });
});

// ---------------------------------------------------------------------------

describe("injection gate", () => {
  it("excludes providers from the comma-separated list, case-insensitively", () => {
    expect(providerExcluded("opencode", "")).toBe(false);
    expect(providerExcluded("opencode", "cline, opencode")).toBe(true);
    expect(providerExcluded("OpenCode", "opencode")).toBe(true);
    expect(providerExcluded("claude", "cline, opencode")).toBe(false);
    expect(providerExcluded("opencode", " , ,")).toBe(false);
  });

  it("lets everything through when no label key is configured", () => {
    expect(labelGateAllows({}, "")).toBe(true);
    expect(labelGateAllows({ "web-search": "off" }, "  ")).toBe(true);
  });

  it("requires an opt-in value on the configured key", () => {
    expect(labelGateAllows({ "web-search": "on" }, "web-search")).toBe(true);
    expect(labelGateAllows({ "web-search": "true" }, "web-search")).toBe(true);
    expect(labelGateAllows({ "web-search": "off" }, "web-search")).toBe(false);
    expect(labelGateAllows({ "web-search": "false" }, "web-search")).toBe(false);
    expect(labelGateAllows({ "web-search": "0" }, "web-search")).toBe(false);
    expect(labelGateAllows({ "web-search": "" }, "web-search")).toBe(false);
    expect(labelGateAllows({}, "web-search")).toBe(false);
    expect(labelGateAllows({ other: "on" }, "web-search")).toBe(false);
  });

  it("explains why it blocked instead of silently no-oping", () => {
    expect(
      injectionGateBlockReason({
        injectIntoAgents: true,
        provider: "opencode",
        labels: {},
        labelGateKey: "web-search",
        skipProviders: "",
      }),
    ).toContain("label gate");
    expect(
      injectionGateBlockReason({
        injectIntoAgents: false,
        provider: "opencode",
        labels: {},
        labelGateKey: "",
        skipProviders: "",
      }),
    ).toContain("injectIntoAgents is off");
    expect(
      injectionGateBlockReason({
        injectIntoAgents: true,
        provider: "acpx",
        labels: {},
        labelGateKey: "",
        skipProviders: "acpx",
      }),
    ).toContain("excluded");
    expect(
      injectionGateBlockReason({
        injectIntoAgents: true,
        provider: "opencode",
        labels: { "web-search": "on" },
        labelGateKey: "web-search",
        skipProviders: "",
      }),
    ).toBeNull();
  });

  it("defers creation to this hook only while a label gate is configured", () => {
    // `agent.create` carries no labels, so without a gate it still owns creation.
    expect(createHookOwnsCreation({ labelGateKey: "" })).toBe(true);
    expect(createHookOwnsCreation({ labelGateKey: "web-search" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function input(overrides: Partial<SessionOpenInput> = {}): SessionOpenInput {
  return {
    reason: "resume",
    purpose: "interactive",
    provider: "opencode",
    labels: {},
    injectIntoAgents: true,
    serverName: "bunny-search",
    labelGateKey: "",
    skipProviders: "",
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

  it("gives a gated-off agent nothing at all", () => {
    for (const overrides of [
      { injectIntoAgents: false },
      { labelGateKey: "web-search" },
      { skipProviders: "opencode" },
    ]) {
      const decision = decideSessionOpen(input(overrides));
      expect(decision.injectMcp, JSON.stringify(overrides)).toBe(false);
      // The tool must not become a back door around the gate.
      expect(decision.attachTool, JSON.stringify(overrides)).toBe(false);
      expect(decision.why).toContain("skipped");
    }
  });

  it("injects for an opted-in agent when the label gate is configured", () => {
    const decision = decideSessionOpen(
      input({ labelGateKey: "web-search", labels: { "web-search": "on" } }),
    );
    expect(decision.injectMcp).toBe(true);
  });

  it("never contributes to a history view", () => {
    expect(decideSessionOpen(input({ purpose: "history" }))).toMatchObject({
      injectMcp: false,
      attachTool: false,
    });
  });

  it("leaves creation to the agent.create hook when no label gate is set", () => {
    const decision = decideSessionOpen(input({ reason: "create" }));
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("agent.create");
  });

  it("takes over creation when a label gate deferred it", () => {
    const decision = decideSessionOpen(
      input({
        reason: "create",
        labelGateKey: "web-search",
        labels: { "web-search": "on" },
      }),
    );
    expect(decision.injectMcp).toBe(true);
    expect(decision.why).toContain("saved configuration has no such server");
  });

  it("attaches the tool when the server cannot be contributed", () => {
    for (const overrides of [
      { supportsMcpServers: false },
      { supportsMcpServers: null },
      { lookup: { status: "missing" as const } },
      { lookup: { status: "unusable" as const, reason: "no config" } },
    ]) {
      const decision = decideSessionOpen(input(overrides));
      expect(decision.injectMcp, JSON.stringify(overrides)).toBe(false);
      expect(decision.attachTool, JSON.stringify(overrides)).toBe(true);
      expect(decision.why, JSON.stringify(overrides)).toContain("bunny_web_search");
    }
  });

  it("never attaches a second search path when the server is already saved", () => {
    const decision = decideSessionOpen(
      input({ lookup: { status: "found", savedServers: ["bunny-search"] } }),
    );
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("collision");
  });
});

// ---------------------------------------------------------------------------

describe("needsCapabilityProbe", () => {
  it("asks the daemon only when an MCP contribution is still possible", () => {
    expect(needsCapabilityProbe(input())).toBe(true);
    expect(needsCapabilityProbe(input({ labelGateKey: "web-search" }))).toBe(false);
    expect(needsCapabilityProbe(input({ skipProviders: "opencode" }))).toBe(false);
    expect(needsCapabilityProbe(input({ injectIntoAgents: false }))).toBe(false);
    expect(needsCapabilityProbe(input({ purpose: "history" }))).toBe(false);
    expect(needsCapabilityProbe(input({ reason: "create" }))).toBe(false);
    expect(
      needsCapabilityProbe(input({ lookup: { status: "found", savedServers: ["bunny-search"] } })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

interface FakeServer extends PluginServerContext {
  call<T>(name: string, input: unknown, context?: unknown): Promise<T>;
  runCreateHook(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  runSessionOpenHook(
    request: Record<string, unknown>,
    context?: unknown,
  ): Promise<Record<string, unknown>>;
  setSettings(values: Record<string, unknown>): void;
  handlers: Map<string, (input: never, context: never) => unknown>;
  beforeHooks: Map<string, (input: never, context: never) => unknown>;
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
  const beforeHooks = new Map<string, (input: never, context: never) => unknown>();
  const onHooks = new Map<string, (input: never, context: never) => unknown>();
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
      beforeHooks.set(name, handler);
      return () => {
        beforeHooks.delete(name);
      };
    },
    on(name: string, handler: (input: never, context: never) => unknown) {
      onHooks.set(name, handler);
      return () => {
        onHooks.delete(name);
      };
    },
    registerProvider() {},
    async call<T>(name: string, input: unknown, context?: unknown): Promise<T> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      return (await handler(input as never, (context ?? fakeContext()) as never)) as T;
    },
    async runCreateHook(request: Record<string, unknown>): Promise<Record<string, unknown>> {
      const hook = beforeHooks.get("agent.create");
      if (!hook) throw new Error("agent.create hook not registered");
      const result = await hook({ request } as never, fakeContext() as never);
      return (result ?? request) as Record<string, unknown>;
    },
    async runSessionOpenHook(
      request: Record<string, unknown>,
      context?: unknown,
    ): Promise<Record<string, unknown>> {
      const hook = beforeHooks.get("agent.session_open");
      if (!hook) throw new Error("agent.session_open hook not registered");
      const result = await hook({ request } as never, (context ?? fakeContext()) as never);
      return (result ?? request) as Record<string, unknown>;
    },
    setSettings(values: Record<string, unknown>) {
      settingsState = { status: "ready", revision: "2", values };
    },
    handlers,
    beforeHooks,
    onHooks,
  };
  return server as unknown as FakeServer;
}

function defaults(): Record<string, unknown> {
  return {
    injectIntoAgents: true,
    mcpServerName: "bunny-search",
    labelGateKey: "",
    skipProviders: "",
    searchService: "duckduckjs",
    duckduckjsEngine: "auto",
    proxyUrl: "",
    ddgsPythonPath: "",
    searxngBaseUrl: "http://127.0.0.1:8888/search",
    customBaseUrl: "",
    searchUiUrl: "",
    apiKey: "",
    timeoutMs: 5000,
    maxResults: 10,
    categories: "general,web",
    language: "",
  };
}

const AGENT = "11111111-2222-4333-8444-555555555555";

function openRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("agent.create hook (injection gate it can evaluate)", () => {
  it("writes the server into the saved configuration by default", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    const request = await server.runCreateHook({
      config: { provider: "opencode", mcpServers: {} },
    });
    const servers = (request.config as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(Object.keys(servers)).toEqual(["bunny-search"]);
    expect(servers["bunny-search"]).toMatchObject({ type: "stdio", alwaysLoad: true });
    cleanup();
  });

  it("skips providers on the exclusion list", async () => {
    const server = createFakeServer({ ...defaults(), skipProviders: "opencode, cline" });
    const cleanup = contribute(server);
    const request = await server.runCreateHook({
      config: { provider: "opencode", mcpServers: {} },
    });
    const servers = (request.config as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(Object.keys(servers)).toEqual([]);
    cleanup();
  });

  it("defers entirely to session_open while a label gate is configured", async () => {
    const server = createFakeServer({ ...defaults(), labelGateKey: "web-search" });
    const cleanup = contribute(server);
    const request = await server.runCreateHook({
      config: { provider: "opencode", mcpServers: {} },
    });
    // No labels on this request — injecting here would ignore the gate.
    const servers = (request.config as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(Object.keys(servers)).toEqual([]);
    cleanup();
  });
});

// ---------------------------------------------------------------------------

describe("agent.session_open hook (contribution wiring)", () => {
  it("contributes the launch-only server when the agent has none saved", async () => {
    writeAgentRecord(AGENT, { provider: "opencode" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runSessionOpenHook(openRequest());
    const servers = request.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["bunny-search"]);
    expect(servers["bunny-search"]).toMatchObject({ type: "stdio", alwaysLoad: true });
    expect(request.tools).toEqual([]);
    cleanup();
  });

  it("attaches bunny_web_search when the record cannot be read", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runSessionOpenHook(openRequest());
    expect(request.mcpServers).toEqual({});
    const tools = request.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["bunny_web_search"]);
    cleanup();
  });

  it("attaches the tool when the provider cannot use MCP servers", async () => {
    writeAgentRecord(AGENT, { provider: "weird" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runSessionOpenHook(
      openRequest({ provider: "weird" }),
      fakeContext(false),
    );
    expect(request.mcpServers).toEqual({});
    const tools = request.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["bunny_web_search"]);
    cleanup();
  });

  it("leaves a gated-off agent untouched", async () => {
    for (const values of [
      { ...defaults(), injectIntoAgents: false },
      { ...defaults(), labelGateKey: "web-search" },
      { ...defaults(), skipProviders: "opencode" },
    ]) {
      writeAgentRecord(AGENT, { provider: "opencode" });
      const server = createFakeServer(values);
      const cleanup = contribute(server);
      const request = await server.runSessionOpenHook(openRequest());
      expect(request.mcpServers, JSON.stringify(values)).toEqual({});
      expect(request.tools, JSON.stringify(values)).toEqual([]);
      cleanup();
    }
  });

  it("honours the label gate once it is configured", async () => {
    // The record must exist for the collision-safe lookup to allow a contribution.
    writeAgentRecord(AGENT, { provider: "opencode" });
    const server = createFakeServer({ ...defaults(), labelGateKey: "web-search" });
    const cleanup = contribute(server);

    const off = await server.runSessionOpenHook(
      openRequest({ reason: "create", labels: { "web-search": "off" } }),
    );
    expect(off.mcpServers).toEqual({});
    expect(off.tools).toEqual([]);

    const on = await server.runSessionOpenHook(
      openRequest({ reason: "create", labels: { "web-search": "on" } }),
    );
    expect(Object.keys(on.mcpServers as Record<string, unknown>)).toEqual(["bunny-search"]);
    cleanup();
  });

  it("does nothing for purpose=history and for create with no label gate", async () => {
    writeAgentRecord(AGENT, { provider: "opencode" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    for (const overrides of [
      { reason: "create", purpose: "interactive" },
      { reason: "resume", purpose: "history" },
    ]) {
      const request = await server.runSessionOpenHook(openRequest(overrides));
      expect(request.mcpServers).toEqual({});
      expect(request.tools).toEqual([]);
    }
    cleanup();
  });

  it("registers and removes both hooks", async () => {
    writeAgentRecord(AGENT, { provider: "opencode" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    expect(server.beforeHooks.has("agent.create")).toBe(true);
    expect(server.beforeHooks.has("agent.session_open")).toBe(true);
    await server.runSessionOpenHook(openRequest());
    cleanup();
    await expect(server.runSessionOpenHook(openRequest())).rejects.toThrow(/not registered/);
    await expect(server.runCreateHook({ config: { provider: "opencode" } })).rejects.toThrow(
      /not registered/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("repair RPC (agents.ref().reload)", () => {
  it("reloads the agent and reports success", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    const result = await server.call<{ ok: boolean; error: string | null }>(agentReload.name, {
      agentId: AGENT,
    });
    expect(result).toEqual({ ok: true, error: null });
    cleanup();
  });

  it("reports a refused reload instead of throwing", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    const result = await server.call<{ ok: boolean; error: string | null }>(
      agentReload.name,
      { agentId: AGENT },
      fakeContext(null),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    cleanup();
  });
});

// ---------------------------------------------------------------------------

describe("bunny_web_search tool", () => {
  function runtimeSettings(): RuntimeSettings {
    return {
      searchService: "searxng",
      duckduckjsEngine: "auto",
      proxyUrl: "",
      ddgsPythonPath: "",
      searxngBaseUrl: "http://searxng.test/search",
      customBaseUrl: "",
      apiKey: "",
      timeoutMs: 5000,
      maxResults: 10,
      categories: "general,web",
      language: "",
    };
  }

  const toolContext = (): AgentToolContext => ({
    agent: { id: "tester", workspaceId: null, parentAgentId: null, provider: "opencode", cwd: "/tmp", title: null },
    paseo: {} as never,
    signal: new AbortController().signal,
  });

  it("is registered under the collision-free prefixed name", () => {
    const tool = createWebSearchTool(async () => runtimeSettings());
    expect(tool.name).toBe("bunny_web_search");
    expect(tool.description).toContain("web");
    expect(MCP_TOOLS.map((entry) => entry.name)).toEqual(["web_search", "search_status"]);
  });

  it("returns formatted results from the same searchWeb the RPC uses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          query: "cats",
          results: [
            { title: "First", url: "https://example.com/1", content: "One", engines: ["google"] },
          ],
        }),
        text: async () => "{}",
      })),
    );
    const tool = createWebSearchTool(async () => runtimeSettings());
    const result = (await tool.execute({ query: "cats" }, toolContext())) as {
      text: string;
      structuredContent: { count: number; provider: string };
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("1. First");
    expect(result.text).toContain("https://example.com/1");
    expect(result.structuredContent).toMatchObject({ count: 1, provider: "searxng" });
  });

  it("rejects a blank query without a network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tool = createWebSearchTool(async () => runtimeSettings());
    const result = (await tool.execute({ query: "   " }, toolContext())) as {
      text: string;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.text).toContain("query is required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops when the turn is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = createWebSearchTool(async () => runtimeSettings());
    const result = (await tool.execute(
      { query: "cats" },
      { ...toolContext(), signal: controller.signal },
    )) as { text: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Cancelled.");
  });

  it("reports a provider failure as a tool error, not a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const tool = createWebSearchTool(async () => runtimeSettings());
    const result = (await tool.execute({ query: "cats" }, toolContext())) as {
      text: string;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    // The provider wraps the transport error into a message the agent can act on.
    expect(result.text).toContain("Cannot connect");
  });
});

// ---------------------------------------------------------------------------

describe("MCP initialize instructions", () => {
  it("tells agents when to search and what to do with the answer", () => {
    expect(MCP_INSTRUCTIONS).toContain("web_search");
    expect(MCP_INSTRUCTIONS).toContain("outside world");
    expect(MCP_INSTRUCTIONS).toContain("failing build");
    expect(MCP_INSTRUCTIONS).toContain("open the returned URLs");
  });
});
