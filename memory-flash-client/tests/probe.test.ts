import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";

/**
 * Probe tests. A stub HTTP server imitates the memory-flash endpoint:
 * `GET /healthz` without auth, `POST /mcp` with `Authorization: Bearer`.
 * The stub records the identity headers it received so the test can
 * assert the client announces its identity.
 */

const SECRET = "mf_live_testkey123456";

interface StubOptions {
  /** Reject the Bearer key (401) like a wrong/revoked key. */
  rejectKey?: boolean;
  /** Answer /mcp with something that is not a memory-flash server. */
  brokenHandshake?: boolean;
  /** Skip /healthz so the liveness step fails. */
  noHealth?: boolean;
  tools?: string[];
}

interface Stub {
  url: string;
  mcpUrl: string;
  close(): Promise<void>;
  requests: Array<{ path: string; clientId: string | null; host: string | null; auth: string | undefined }>;
}

let stub: Stub | null = null;

async function startStub(options: StubOptions = {}): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        path: url.pathname,
        clientId: (req.headers["x-memory-flash-client-id"] as string | undefined) ?? null,
        host: (req.headers["x-memory-flash-host"] as string | undefined) ?? null,
        auth: req.headers.authorization,
      });

      if (url.pathname === "/healthz" && !options.noHealth) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, server: "memory-flash-mcp" }));
        return;
      }
      if (url.pathname === "/healthz" && options.noHealth) {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (options.rejectKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      const request = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        id?: number;
        method?: string;
      };
      if (options.brokenHandshake) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result: {} }));
        return;
      }
      if (request.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "memory-flash", version: "0.1.1" },
            },
          }),
        );
        return;
      }
      if (request.method === "tools/list") {
        const names = options.tools ?? [
          "memory_search",
          "memory_get",
          "memory_save",
          "memory_list_by_tag",
          "memory_stats",
        ];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: { tools: names.map((name) => ({ name })) },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

beforeEach(async () => {
  stub = await startStub();
});

afterEach(async () => {
  await stub?.close();
  stub = null;
});

const identity = { clientId: "11111111-2222-3333-4444-555555555555", host: "studio-laptop" };

describe("probeConnection", () => {
  it("succeeds against a memory-flash endpoint and reports tools", async () => {
    const { probeConnection } = await import("../server/probe");
    const result = await probeConnection(stub!.url, SECRET, identity);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.serverName).toBe("memory-flash");
    expect(result.toolCount).toBe(5);
    expect(result.error).toBeNull();
    expect(result.checkedAt).toBeTruthy();
  });

  it("authenticates with a Bearer header and announces the identity", async () => {
    const { probeConnection } = await import("../server/probe");
    await probeConnection(stub!.url, SECRET, identity);
    const mcpRequests = stub!.requests.filter((entry) => entry.path === "/mcp");
    expect(mcpRequests.length).toBeGreaterThanOrEqual(2);
    for (const entry of mcpRequests) {
      expect(entry.auth).toBe(`Bearer ${SECRET}`);
      expect(entry.clientId).toBe(identity.clientId);
      expect(entry.host).toBe("studio-laptop");
    }
  });

  it("works without an identity (draft check before settings)", async () => {
    const { probeConnection } = await import("../server/probe");
    const result = await probeConnection(stub!.url, SECRET, null);
    expect(result.ok).toBe(true);
    const mcpRequests = stub!.requests.filter((entry) => entry.path === "/mcp");
    expect(mcpRequests[0].clientId).toBeNull();
  });

  it("reports a rejected key as an actionable error", async () => {
    await stub!.close();
    stub = await startStub({ rejectKey: true });
    const { probeConnection } = await import("../server/probe");
    const result = await probeConnection(stub!.url, "wrong-key", identity);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toContain("rejected the API key");
    expect(result.error).not.toContain("wrong-key");
  });

  it("fails when the liveness endpoint is missing", async () => {
    await stub!.close();
    stub = await startStub({ noHealth: true });
    const { probeConnection } = await import("../server/probe");
    const result = await probeConnection(stub!.url, SECRET, identity);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("/healthz");
  });

  it("fails when the handshake carries no serverInfo", async () => {
    await stub!.close();
    stub = await startStub({ brokenHandshake: true });
    const { probeConnection } = await import("../server/probe");
    const result = await probeConnection(stub!.url, SECRET, identity);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("serverInfo");
  });

  it("fails when the host is unreachable", async () => {
    const { probeConnection } = await import("../server/probe");
    // Port 1 is reserved and never listening in this environment.
    const result = await probeConnection("http://127.0.0.1:1/mcp", SECRET, identity);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toBeTruthy();
  });

  it("derives the health url from the mcp url", async () => {
    const { healthUrlFor } = await import("../server/probe");
    expect(healthUrlFor("http://100.64.0.2:8787/mcp")).toBe("http://100.64.0.2:8787/healthz");
    expect(healthUrlFor("100.64.0.2:8787")).toBe("http://100.64.0.2:8787/healthz");
  });

  it("accepts a pasted host:port and probes the right endpoint", async () => {
    const { probeConnection } = await import("../server/probe");
    const pasted = stub!.url.replace("http://", "");
    const result = await probeConnection(pasted, SECRET, identity);
    expect(result.ok).toBe(true);
  });
});
