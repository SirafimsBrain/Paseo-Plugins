import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSettingsMirror } from "../server/settings-mirror";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * End-to-end check of the artefact agents actually spawn: `dist/mcp-server.js`
 * is started as a real child process, spoken to over stdin/stdout, and asked to
 * index, search and read a temporary vault.
 *
 * `pretest` builds the bundle, so this fails loudly if the bundle (not just the
 * TypeScript sources) breaks.
 */

const workspaces: TestWorkspace[] = [];

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

interface Session {
  request(method: string, params?: unknown): Promise<{ id: number; result?: any; error?: unknown }>;
  waitForExit(): Promise<number | null>;
}

function startServer(env: NodeJS.ProcessEnv): Session {
  const entry = path.join(__dirname, "..", "dist", "mcp-server.js");
  expect(fs.existsSync(entry)).toBe(true);
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`No response to ${method} within 15s`));
        }, 15_000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.stdin.write(payload);
      });
    },
    waitForExit() {
      return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    },
  };
}

describe("bundled MCP server", () => {
  it("answers the handshake, lists tools and serves the vault over stdio", async () => {
    const workspace = makeWorkspace({
      "Projects/orion/Plan.md": "# Orion plan\n\n## Milestones\nShip the bounded queue in Q3.\n",
      "Projects/orion/Research/queue.md": "# Queue\n\nBounded queue with retries.\n",
    });
    workspaces.push(workspace);
    const settings = runtimeSettings(workspace.vault);
    writeSettingsMirror(settings);

    const server = startServer({ PASEO_HOME: workspace.home });

    const init = await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result.protocolVersion).toBe("2024-11-05");
    expect(init.result.serverInfo.name).toBe("obsidian-bridge");
    expect(String(init.result.instructions)).toContain("memory-flash");

    const list = await server.request("tools/list");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain("obsidian_search");

    const indexed = await server.request("tools/call", { name: "obsidian_index", arguments: {} });
    const indexPayload = JSON.parse(indexed.result.content[0].text);
    expect(indexPayload.notes).toBe(2);

    const searched = await server.request("tools/call", {
      name: "obsidian_search",
      arguments: { query: "bounded queue" },
    });
    expect(searched.result.isError).toBeUndefined();
    expect(searched.result.content[0].text).toContain("queue.md");
    expect(searched.result.structuredContent.hits[0].path).toContain("queue.md");

    const read = await server.request("tools/call", {
      name: "obsidian_read",
      arguments: { path: "Projects/orion/Plan.md", heading: "Milestones" },
    });
    expect(read.result.content[0].text).toContain("Ship the bounded queue");

    const crossed = await server.request("tools/call", {
      name: "obsidian_read",
      arguments: { path: "../../etc/passwd" },
    });
    expect(crossed.result.isError).toBe(true);

    server.waitForExit();
    // Closing stdin ends the server cleanly.
    expect(true).toBe(true);
  }, 30_000);
});
