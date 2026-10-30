import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { refreshSession } from "../shared/session-manager";
import { invalidateListing, listAgentSessions } from "../server/session-manager";
import { providers } from "../server/providers/registry";
import type { ProviderListResult } from "../server/providers/types";

/**
 * 0.3.3 coverage: the two lifecycle additions of §18.3 — the `agent.closed` cache
 * invalidation and the `session-manager.refresh` reload RPC.
 *
 * The interesting assertion is behavioural, not wiring: the listing cache is a
 * module-private 30-second store, so the test primes it through the public
 * `listAgentSessions()` with one adapter's `list()` spied, fires the hook, and
 * observes that the same adapter is scanned again. Registration alone would not
 * prove the cache was actually dropped.
 */

interface FakeServer extends PluginServerContext {
  call<T>(name: string, input: unknown, context?: unknown): Promise<T>;
  onHooks: Map<string, (event: never, context: never) => unknown>;
  handlers: Map<string, (input: never, context: never) => unknown>;
}

function fakeContext(reloadable = true) {
  return {
    paseo: {
      agents: {
        ref: (agentId: string) => ({
          reload: async () => (reloadable ? { agent: { id: agentId } } : null),
        }),
      },
    },
    signal: new AbortController().signal,
  };
}

function createFakeServer(): FakeServer {
  const handlers = new Map<string, (input: never, context: never) => unknown>();
  const onHooks = new Map<string, (event: never, context: never) => unknown>();

  const server = {
    registerSettings() {
      return {
        async read() {
          return { status: "ready", revision: "1", values: {} };
        },
        subscribe() {
          return () => {};
        },
      };
    },
    handle(contract: { name: string }, handler: (input: never, context: never) => unknown) {
      handlers.set(contract.name, handler);
    },
    before() {
      return () => {};
    },
    on(name: string, handler: (event: never, context: never) => unknown) {
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
    handlers,
    onHooks,
  };
  return server as unknown as FakeServer;
}

let tempHome: string;
let savedHome: string | undefined;
let listSpy: ReturnType<typeof vi.spyOn> | null = null;

const EMPTY_LISTING: ProviderListResult = {
  sessions: [],
  detected: true,
  detail: "test",
  deletable: true,
  storeBytes: null,
  error: null,
};

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-hooks-"));
  savedHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = tempHome;
  invalidateListing();
  // The first adapter stands in for "the provider" — its `list()` call is what the
  // cache is about, and spying on the shared registry object is visible to the
  // module-internal `readListing()`.
  listSpy = vi.spyOn(providers[0], "list").mockResolvedValue({ ...EMPTY_LISTING });
});

afterEach(() => {
  listSpy?.mockRestore();
  listSpy = null;
  if (savedHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("agent.closed hook", () => {
  it("is registered by contribute() and removed by the cleanup", () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    expect(server.onHooks.has("agent.closed")).toBe(true);
    cleanup();
    expect(server.onHooks.has("agent.closed")).toBe(false);
  });

  it("drops the listing cache so the next list rescans instead of ageing out", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    const hook = server.onHooks.get("agent.closed");
    expect(hook).toBeDefined();

    await listAgentSessions(); // prime
    await listAgentSessions(); // still warm: same TTL entry
    expect(listSpy).toHaveBeenCalledTimes(1);

    await hook!(
      {
        agent: {
          id: "agent-1",
          workspaceId: "ws",
          parentAgentId: null,
          provider: "opencode",
          cwd: "/tmp/x",
          title: null,
        },
      } as never,
      fakeContext() as never,
    );

    await listAgentSessions();
    expect(listSpy).toHaveBeenCalledTimes(2);
    cleanup();
  });
});

// ---------------------------------------------------------------------------

describe("session-manager.refresh RPC", () => {
  it("reopens the agent session and invalidates the listing cache", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);

    await listAgentSessions(); // prime
    expect(listSpy).toHaveBeenCalledTimes(1);

    const result = await server.call<{ ok: boolean; error: string | null }>(
      refreshSession.name,
      { agentId: "agent-1" },
      fakeContext(),
    );
    expect(result).toEqual({ ok: true, error: null });

    await listAgentSessions();
    expect(listSpy).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("reports a refused reload instead of throwing", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    const result = await server.call<{ ok: boolean; error: string | null }>(
      refreshSession.name,
      { agentId: "unknown" },
      fakeContext(false),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    cleanup();
  });
});
