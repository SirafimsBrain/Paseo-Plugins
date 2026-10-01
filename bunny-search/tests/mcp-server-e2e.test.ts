import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Spawns the bundled stdio MCP server (`dist/mcp-server.js`,
 * rebuilt by the `pretest` script) and speaks real MCP with it,
 * backing the search endpoint with a fake SearXNG JSON API.
 */

const SERVER_PATH = path.join(process.cwd(), "dist", "mcp-server.js");

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

let fakeSearxng: http.Server;
let fakeSearxngUrl: string;
let child: ChildProcess;
const responses = new Map<number | string | null, JsonRpcMessage>();
let stdoutBuffer = "";

function send(message: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
}

function request(id: number, method: string, params?: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

function waitFor(id: number | string | null, timeoutMs = 10000): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      const response = responses.get(id);
      if (response) return resolve(response);
      if (Date.now() - startedAt > timeoutMs)
        return reject(new Error(`timeout waiting for response id=${String(id)}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(async () => {
  // Fake SearXNG JSON API on an ephemeral loopback port.
  fakeSearxng = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/search") {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        query: url.searchParams.get("q") ?? "",
        answers: ["42"],
        suggestions: ["suggested query"],
        results: [
          {
            title: "First result",
            url: "https://example.com/1",
            content: "A snippet about the query.",
            engines: ["google"],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => fakeSearxng.listen(0, "127.0.0.1", resolve));
  const address = fakeSearxng.address();
  if (!address || typeof address === "string") throw new Error("failed to bind fake SearXNG");
  fakeSearxngUrl = `http://127.0.0.1:${address.port}/search`;

  child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BUNNY_SEARCH_BASE_URL: fakeSearxngUrl,
      BUNNY_SEARCH_MAX_RESULTS: "5",
    },
  });
  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.length === 0) continue;
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        responses.set(message.id ?? null, message);
      } catch {
        // Not JSON — ignore.
      }
    }
  });

  // Wait for the server to boot by pinging it.
  request(0, "ping");
  await waitFor(0);
});

afterAll(() => {
  child.kill("SIGTERM");
  fakeSearxng.close();
});

describe("bunny-search MCP server (stdio e2e)", () => {
  it("answers initialize with the MCP protocol version and server info", async () => {
    request(1, "initialize", {});
    const response = await waitFor(1);
    const result = response.result as {
      protocolVersion?: string;
      capabilities?: { tools?: unknown };
      serverInfo?: { name?: string; version?: string };
    };
    expect(response.jsonrpc).toBe("2.0");
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities?.tools).not.toBeUndefined();
    expect(result.serverInfo?.name).toBe("bunny-search");
  });

  it("lists web_search and search_status tools", async () => {
    request(2, "tools/list");
    const response = await waitFor(2);
    const result = response.result as { tools?: Array<{ name?: string }> };
    const names = (result.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["web_search", "search_status"]));
  });

  it("runs a web_search against the configured service", async () => {
    request(3, "tools/call", {
      name: "web_search",
      arguments: { query: "cats", max_results: 2 },
    });
    const response = await waitFor(3);
    const result = response.result as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Query: cats");
    expect(text).toContain("Answer: 42");
    expect(text).toContain("Did you mean: suggested query");
    expect(text).toContain("1. First result");
    expect(text).toContain("https://example.com/1");
    expect(text).toContain("Engines: google");
  });

  it("reports provider failures as tool errors, not protocol errors", async () => {
    request(4, "tools/call", { name: "web_search", arguments: { query: "" } });
    const response = await waitFor(4);
    const result = response.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("query is required");
  });

  it("answers search_status with the effective configuration", async () => {
    request(5, "tools/call", { name: "search_status", arguments: {} });
    const response = await waitFor(5);
    const result = response.result as { content?: Array<{ text?: string }> };
    const parsed = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    expect(parsed.provider).toBe("searxng");
    expect(parsed.baseUrl).toBe(fakeSearxngUrl);
    expect((parsed.defaults as Record<string, unknown>).maxResults).toBe(5);
  });

  it("answers ping", async () => {
    request(6, "ping");
    const response = await waitFor(6);
    expect(response.result).toEqual({});
  });

  it("answers unknown methods with -32601", async () => {
    request(7, "no/such/method");
    const response = await waitFor(7);
    expect(response.error?.code).toBe(-32601);
  });

  it("answers malformed JSON with -32700", async () => {
    child.stdin?.write("{not json\n");
    const response = await waitFor(null);
    expect(response.error?.code).toBe(-32700);
  });
});
