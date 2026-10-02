import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { memoryFlashClientSettings } from "../shared/settings";
import {
  checkConnection,
  clientStatus,
  conflictCheck,
  deleteConnection,
  listConnections,
  saveConnection,
} from "../shared/contracts";
import { saveConnection as persistConnection } from "../server/connections";

/**
 * Server contribution tests: the agent.create hook is the heart of the
 * plugin, so it is exercised with a minimal fake PluginServerContext.
 * `PASEO_HOME` points at a temp directory for the connections file.
 */

interface FakeServer extends PluginServerContext {
  /** Calls an RPC handler registered through `server.handle`. */
  call<T>(name: string, input: unknown): Promise<T>;
  /** Runs the `agent.create` before-hook over a fresh request. */
  runCreateHook(config: { mcpServers?: Record<string, unknown> }): Promise<{
    config: { mcpServers?: Record<string, unknown> };
  }>;
  setSettings(values: Record<string, unknown>): void;
  handlers: Map<string, (input: never, context: never) => unknown>;
}

function createFakeServer(initial: Record<string, unknown>): FakeServer {
  const handlers = new Map<string, (input: never, context: never) => unknown>();
  let settingsState: { status: "ready"; revision: string; values: Record<string, unknown> } = {
    status: "ready",
    revision: "1",
    values: initial,
  };
  let createHook: ((input: { request: { config: { mcpServers?: Record<string, unknown> } } }) => unknown) | null = null;

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
    before(name: string, handler: typeof createHook) {
      if (name === "agent.create") createHook = handler;
      return () => {
        createHook = null;
      };
    },
    on() {
      return () => {};
    },
    registerProvider() {},
    async call<T>(name: string, input: unknown): Promise<T> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      return (await handler(input as never, undefined as never)) as T;
    },
    async runCreateHook(config: { mcpServers?: Record<string, unknown> }) {
      if (!createHook) throw new Error("agent.create hook not registered");
      const request = { config: { ...config } };
      const result = await createHook({ request });
      return (result ?? request) as { config: { mcpServers?: Record<string, unknown> } };
    },
    setSettings(values: Record<string, unknown>) {
      settingsState = { status: "ready", revision: "2", values };
    },
    handlers,
  };
  return server as unknown as FakeServer;
}

/** Schema defaults, so the fake store behaves like the real one. */
function defaults(): Record<string, unknown> {
  return {
    injectIntoAgents: true,
    clientId: "",
    hostname: "",
    mcpServerName: "memory-flash",
    sendIdentityHeaders: true,
  };
}

let tempHome: string;
const previousHome = process.env.PASEO_HOME;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mfc-server-"));
  process.env.PASEO_HOME = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function addConnection(input: { id?: string; label: string; url: string; secret: string; enabled?: boolean }): string {
  const result = persistConnection({
    id: input.id ?? "",
    label: input.label,
    url: input.url,
    secret: input.secret,
    enabled: input.enabled ?? true,
  });
  return result.id;
}

describe("agent.create hook", () => {
  it("injects a single enabled connection as an HTTP MCP server", async () => {
    addConnection({ label: "office", url: "http://100.64.0.2:8787/mcp", secret: "mf_live_aaa" });
    const server = createFakeServer({ ...defaults(), hostname: "studio-laptop" });
    const cleanup = contribute(server);

    const request = await server.runCreateHook({});
    const servers = request.config.mcpServers ?? {};
    expect(Object.keys(servers)).toEqual(["memory-flash"]);
    const config = servers["memory-flash"] as {
      type: string;
      url: string;
      headers: Record<string, string>;
      alwaysLoad: boolean;
    };
    expect(config.type).toBe("http");
    expect(config.url).toBe("http://100.64.0.2:8787/mcp");
    expect(config.headers.Authorization).toBe("Bearer mf_live_aaa");
    expect(config.alwaysLoad).toBe(true);
    // Identity headers carry the host name from settings and a generated UUID.
    expect(config.headers["X-Memory-Flash-Host"]).toBe("studio-laptop");
    expect(config.headers["X-Memory-Flash-Client-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    cleanup();
  });

  it("uses the pinned client UUID from settings", async () => {
    addConnection({ label: "office", url: "http://100.64.0.2:8787/mcp", secret: "mf_live_aaa" });
    const pinned = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const server = createFakeServer({ ...defaults(), clientId: pinned, hostname: "laptop" });
    const cleanup = contribute(server);

    const request = await server.runCreateHook({});
    const config = (request.config.mcpServers?.["memory-flash"] ?? {}) as {
      headers: Record<string, string>;
    };
    expect(config.headers["X-Memory-Flash-Client-Id"]).toBe(pinned);
    expect(config.headers["X-Memory-Flash-Host"]).toBe("laptop");
    cleanup();
  });

  it("keeps the same generated UUID across agents", async () => {
    addConnection({ label: "office", url: "http://100.64.0.2:8787/mcp", secret: "mf_live_aaa" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const first = await server.runCreateHook({});
    const second = await server.runCreateHook({});
    const header = (key: string) =>
      ((first.config.mcpServers?.["memory-flash"] ?? {}) as { headers: Record<string, string> })
        .headers[key];
    expect(header("X-Memory-Flash-Client-Id")).toBe(
      ((second.config.mcpServers?.["memory-flash"] ?? {}) as { headers: Record<string, string> })
        .headers["X-Memory-Flash-Client-Id"],
    );
    cleanup();
  });

  it("suffixes names when several connections are enabled", async () => {
    const first = addConnection({ label: "a", url: "http://a:8787/mcp", secret: "mf_live_a" });
    addConnection({ label: "b", url: "http://b:8787/mcp", secret: "mf_live_b" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runCreateHook({});
    const names = Object.keys(request.config.mcpServers ?? {});
    expect(names).toHaveLength(2);
    expect(names).toContain(`memory-flash-${first}`);
    cleanup();
  });

  it("skips disabled connections and preserves existing MCP servers", async () => {
    addConnection({ label: "on", url: "http://a:8787/mcp", secret: "mf_live_a" });
    addConnection({ label: "off", url: "http://b:8787/mcp", secret: "mf_live_b", enabled: false });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const request = await server.runCreateHook({ mcpServers: { other: { type: "stdio" } } });
    const servers = request.config.mcpServers ?? {};
    expect(Object.keys(servers).sort()).toEqual(["memory-flash", "other"]);
    cleanup();
  });

  it("does nothing when injection is off or no connection exists", async () => {
    addConnection({ label: "a", url: "http://a:8787/mcp", secret: "mf_live_a" });
    const off = createFakeServer({ ...defaults(), injectIntoAgents: false });
    const offCleanup = contribute(off);
    expect((await off.runCreateHook({})).config.mcpServers).toBeUndefined();
    offCleanup();

    fs.rmSync(path.join(tempHome, "plugins", "memory-flash-client", "connections.json"), {
      force: true,
    });
    const on = createFakeServer(defaults());
    const onCleanup = contribute(on);
    expect((await on.runCreateHook({})).config.mcpServers).toBeUndefined();
    onCleanup();
  });

  it("omits the identity headers when the toggle is off", async () => {
    addConnection({ label: "a", url: "http://a:8787/mcp", secret: "mf_live_a" });
    const server = createFakeServer({ ...defaults(), sendIdentityHeaders: false });
    const cleanup = contribute(server);
    const request = await server.runCreateHook({});
    const headers = (request.config.mcpServers?.["memory-flash"] ?? {}) as {
      headers: Record<string, string>;
    };
    expect(headers.headers["X-Memory-Flash-Client-Id"]).toBeUndefined();
    expect(headers.headers.Authorization).toBe("Bearer mf_live_a");
    cleanup();
  });
});

describe("RPC surface", () => {
  it("lists, saves and deletes connections without leaking secrets", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const saved = await server.call<{ ok: boolean; id: string }>("memory-flash-client.connections-save", {
      connection: { id: "", label: "office", url: "100.64.0.2:8787", secret: "mf_live_supersecret", enabled: true },
    });
    expect(saved.ok).toBe(true);

    const listed = await server.call<{ connections: Array<Record<string, unknown>> }>(
      "memory-flash-client.connections",
      {},
    );
    expect(listed.connections).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("supersecret");

    const removed = await server.call<{ ok: boolean }>("memory-flash-client.connections-delete", {
      id: saved.id,
    });
    expect(removed.ok).toBe(true);
    cleanup();
  });

  it("reports the client status with connection counts", async () => {
    addConnection({ label: "a", url: "http://a:8787/mcp", secret: "mf_live_a" });
    addConnection({ label: "b", url: "http://b:8787/mcp", secret: "mf_live_b", enabled: false });
    const server = createFakeServer({ ...defaults(), hostname: "laptop" });
    const cleanup = contribute(server);

    const status = await server.call<{
      identityHost: string;
      totalConnections: number;
      enabledConnections: number;
      connectionsPath: string;
    }>("memory-flash-client.status", {});
    expect(status.identityHost).toBe("laptop");
    expect(status.totalConnections).toBe(2);
    expect(status.enabledConnections).toBe(1);
    expect(status.connectionsPath).toContain("memory-flash-client");
    cleanup();
  });

  it("reports a missing connection for the check RPC", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    const result = await server.call<{ ok: boolean; error: string | null }>(
      "memory-flash-client.connections-check",
      { id: "nope" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Connection not found.");
    cleanup();
  });

  it("runs the coexistence check through the RPC", async () => {
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);
    const result = await server.call<{ conflict: boolean }>("memory-flash-client.conflict-check", {});
    expect(result.conflict).toBe(false);
    cleanup();
  });

  it("regenerates the client id and pins it in the injected config", async () => {
    addConnection({ label: "a", url: "http://a:8787/mcp", secret: "mf_live_a" });
    const server = createFakeServer(defaults());
    const cleanup = contribute(server);

    const before = await server.runCreateHook({});
    const idBefore = (
      (before.config.mcpServers?.["memory-flash"] ?? {}) as { headers: Record<string, string> }
    ).headers["X-Memory-Flash-Client-Id"];

    const regenerated = await server.call<{ clientId: string }>("memory-flash-client.regenerate-id", {});
    expect(regenerated.clientId).not.toBe(idBefore);

    const after = await server.runCreateHook({});
    const idAfter = (
      (after.config.mcpServers?.["memory-flash"] ?? {}) as { headers: Record<string, string> }
    ).headers["X-Memory-Flash-Client-Id"];
    expect(idAfter).toBe(regenerated.clientId);
    cleanup();
  });
});

// The contract objects are imported to prove the RPC names the tests call
// are the ones the plugin registered.
expect(listConnections.name).toBe("memory-flash-client.connections");
expect(saveConnection.name).toBe("memory-flash-client.connections-save");
expect(deleteConnection.name).toBe("memory-flash-client.connections-delete");
expect(checkConnection.name).toBe("memory-flash-client.connections-check");
expect(clientStatus.name).toBe("memory-flash-client.status");
expect(conflictCheck.name).toBe("memory-flash-client.conflict-check");
expect(memoryFlashClientSettings.id).toBe("memory-flash-client");
