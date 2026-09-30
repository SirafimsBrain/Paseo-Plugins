import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spawns the actual MCP server bundle as a child process (the same way coding
 * agents spawn it) and speaks JSON-RPC over stdio. The bundle is produced by
 * `scripts/bundle-mcp-server.mjs` (esbuild) — run `npm run bundle` before the
 * tests (wired into the `pretest` script).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_BUNDLE = path.join(__dirname, "..", "dist", "mcp-server.js");

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function startServer(home: string) {
  const child = spawn(process.execPath, [SERVER_BUNDLE], {
    env: { ...process.env, PASEO_HOME: home, MEMORY_FLASH_AGENT_ID: "e2e-agent" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map<number, Pending>();
  let nextId = 1;
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = message.id as number | undefined;
      if (id !== undefined && pending.has(id)) {
        const entry = pending.get(id) as Pending;
        clearTimeout(entry.timer);
        pending.delete(id);
        if (message.error) entry.reject(new Error(String((message.error as { message: string }).message)));
        else entry.resolve(message.result as Record<string, unknown>);
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    // Keep stderr for debugging failures; never asserted.
    void chunk;
  });

  const request = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
    });
  };

  return {
    request,
    stop: () => {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

describe("MCP server end-to-end (real process)", () => {
  it("handshakes, lists tools and round-trips a memory", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-e2e-"));
    const server = startServer(home);
    try {
      const init = await server.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0.0.1" },
      });
      expect((init.serverInfo as { name: string }).name).toBe("memory-flash");

      const tools = await server.request("tools/list");
      const toolNames = (tools.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(toolNames).toContain("memory_save");
      expect(toolNames).toContain("memory_search");

      const save = await server.request("tools/call", {
        name: "memory_save",
        arguments: { title: "E2E memory", content: "Written through the stdio MCP server.", tags: ["e2e", "Paseo"] },
      });
      const savePayload = JSON.parse((save.content as Array<{ text: string }>)[0].text) as { id: number };
      expect(savePayload.id).toBeGreaterThan(0);

      const search = await server.request("tools/call", {
        name: "memory_search",
        arguments: { query: "stdio" },
      });
      const searchPayload = JSON.parse((search.content as Array<{ text: string }>)[0].text) as { matches: number };
      expect(searchPayload.matches).toBe(1);

      // The database file really exists under $PASEO_HOME.
      expect(fs.existsSync(path.join(home, "plugins", "memory-flash", "memory.db"))).toBe(true);
    } finally {
      server.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
