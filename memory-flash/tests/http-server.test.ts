import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../server/store";
import {
  McpHttpServer,
  isWildcardHost,
  resolveRoutableHost,
} from "../server/http-server";

let dir: string;
let store: MemoryStore;
let server: McpHttpServer;
let baseUrl: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-http-"));
  store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  server = new McpHttpServer({
    host: "127.0.0.1",
    port: 0,
    context: { store },
    serverInfo: { name: "memory-flash", version: "0.1.1" },
  });
  await server.start();
  baseUrl = new URL(server.url!).origin;
});

afterEach(async () => {
  await server.stop();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function postJson(
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function withAuth(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` };
}

function callTool(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  return postJson(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    headers,
  );
}

describe("McpHttpServer", () => {
  it("answers /healthz without a key", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, server: "memory-flash-mcp" });
  });

  it("requires a Bearer key on /mcp", async () => {
    const missing = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const badScheme = await postJson(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { Authorization: "Basic abc" },
    );
    expect(badScheme.status).toBe(401);

    const invalid = await postJson(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      withAuth("mf_live_nope"),
    );
    expect(invalid.status).toBe(401);
  });

  it("rate-limits repeated 401s per client", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await postJson(
        "/mcp",
        { jsonrpc: "2.0", id: i, method: "ping" },
        withAuth("mf_live_bad"),
      );
      expect(res.status).toBe(401);
    }
    const blocked = await postJson(
      "/mcp",
      { jsonrpc: "2.0", id: 11, method: "ping" },
      withAuth("mf_live_bad"),
    );
    expect(blocked.status).toBe(429);
  });

  it("serves MCP over HTTP with a valid key", async () => {
    const { secret } = store.generateApiKey({ label: "laptop" });
    const res = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, withAuth(secret));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("answers initialize and ping with a valid key", async () => {
    const { secret } = store.generateApiKey({ label: "laptop" });
    const init = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" }, withAuth(secret));
    const initBody = await init.json();
    expect(initBody.result.protocolVersion).toBe("2024-11-05");
    expect(initBody.result.serverInfo.name).toBe("memory-flash");

    const ping = await postJson("/mcp", { jsonrpc: "2.0", id: 7, method: "ping" }, withAuth(secret));
    const pingBody = await ping.json();
    expect(pingBody.id).toBe(7);
    expect(pingBody.result).toEqual({});
  });

  it("round-trips a tool call over HTTP", async () => {
    const { secret } = store.generateApiKey({ label: "laptop" });
    const save = await callTool("memory_save", { title: "t", content: "c" }, withAuth(secret));
    expect(save.status).toBe(200);
    const saved = await save.json();
    expect(saved.result.content[0].text).toContain('"saved": true');

    const stats = await callTool("memory_stats", {}, withAuth(secret));
    const statsBody = await stats.json();
    expect(statsBody.result.content[0].text).toContain('"total": 1');
  });

  it("filters tools/list for read-scoped keys", async () => {
    const { secret } = store.generateApiKey({ label: "reader", scope: "read" });
    const res = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, withAuth(secret));
    const body = await res.json();
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    // memory_diagnose joined this set in 0.7.0: it only measures search over
    // control queries and writes nothing.
    expect(names).toEqual([
      "memory_search",
      "memory_get",
      "memory_list_by_tag",
      "memory_diagnose",
      "memory_stats",
    ]);
  });

  it("blocks write tools for read-scoped keys before dispatch", async () => {
    const { secret } = store.generateApiKey({ label: "reader", scope: "read" });
    store.create(
      { kind: "note", title: "seed", content: "c", tags: [], project: null, agentId: null },
      "test",
    );
    const denied = await callTool("memory_delete", { id: 1 }, withAuth(secret));
    expect(denied.status).toBe(200);
    const body = await denied.json();
    expect(body.error.code).toBe(-32000);
    // The row must still exist — the tool never ran.
    expect(store.getById(1)).not.toBeNull();
  });

  it("lets read-scoped keys call read tools", async () => {
    const { secret } = store.generateApiKey({ label: "reader", scope: "read" });
    const res = await callTool("memory_stats", {}, withAuth(secret));
    const body = await res.json();
    expect(body.result.content[0].text).toContain('"total": 0');
  });

  it("answers 405 for GET /mcp and 404 for unknown paths", async () => {
    const get = await fetch(`${baseUrl}/mcp`);
    expect(get.status).toBe(405);
    const notFound = await fetch(`${baseUrl}/nope`);
    expect(notFound.status).toBe(404);
  });

  it("answers 400 with a JSON-RPC parse error for malformed bodies", async () => {
    const { secret } = store.generateApiKey({ label: "x" });
    const res = await postJson("/mcp", "{not json", withAuth(secret));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it("answers unknown methods with a JSON-RPC error", async () => {
    const { secret } = store.generateApiKey({ label: "x" });
    const res = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "resources/list" }, withAuth(secret));
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });

  it("accepts notifications with 202 and an empty body", async () => {
    const { secret } = store.generateApiKey({ label: "x" });
    const res = await postJson(
      "/mcp",
      { jsonrpc: "2.0", method: "notifications/initialized" },
      withAuth(secret),
    );
    expect(res.status).toBe(202);
  });

  it("records the last-used timestamp of an authenticated key", async () => {
    const { record, secret } = store.generateApiKey({ label: "laptop" });
    await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, withAuth(secret));
    expect(store.listApiKeys().find((key) => key.id === record.id)!.lastUsedAt).not.toBeNull();
  });
});

describe("wildcard bind addresses", () => {
  it("recognises every spelling of a wildcard host", () => {
    for (const host of ["0.0.0.0", "0.0.0.0 ", "::", "[::]", "*", ""]) {
      expect(isWildcardHost(host)).toBe(true);
    }
    for (const host of ["127.0.0.1", "localhost", "100.64.0.2", "::1", "0.0.0.1"]) {
      expect(isWildcardHost(host)).toBe(false);
    }
  });

  it("replaces a wildcard with a dialable address, not the wildcard itself", () => {
    for (const host of ["0.0.0.0", "::", "*", ""]) {
      const resolved = resolveRoutableHost(host);
      expect(isWildcardHost(resolved)).toBe(false);
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("keeps a concrete bind address as-is", () => {
    expect(resolveRoutableHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveRoutableHost("100.64.0.2")).toBe("100.64.0.2");
    expect(resolveRoutableHost(" ::1 ")).toBe("::1");
  });

  it("reports the bound interface verbatim and a dialable copy URL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-wildcard-"));
    const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
    const server = new McpHttpServer({
      host: "0.0.0.0",
      port: 0,
      context: { store },
      serverInfo: { name: "memory-flash", version: "0.1.1" },
    });
    try {
      await server.start();
      // bindUrl is the truth for the status line; url is what gets copied.
      expect(server.boundHost).toBe("0.0.0.0");
      expect(server.wildcardBound).toBe(true);
      expect(server.bindUrl).toBe(`http://0.0.0.0:${server.boundTcpPort}/mcp`);
      expect(server.url).not.toContain("0.0.0.0");
      expect(server.url).toBe(
        `http://${resolveRoutableHost("0.0.0.0")}:${server.boundTcpPort}/mcp`,
      );
      const health = await fetch(`${new URL(server.url!).origin}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await server.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
