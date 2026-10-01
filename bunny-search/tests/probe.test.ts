import { describe, expect, it } from "vitest";
import { probeMcpServer, PROBE_TIMEOUT_MS } from "../server/probe";

/** A fake stdio MCP server: answers every `initialize` (id 1) on stdout. */
const FAKE_MCP_SERVER = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    try {
      const message = JSON.parse(line);
      if (message.id === 1) {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: {} } }) + "\\n",
        );
      }
    } catch {
      // Not JSON — ignore.
    }
  }
});
`;

describe("probeMcpServer", () => {
  it("resolves true for a command that answers the MCP handshake", async () => {
    const ok = await probeMcpServer(process.execPath, ["-e", FAKE_MCP_SERVER]);
    expect(ok).toBe(true);
  }, PROBE_TIMEOUT_MS + 2000);

  it("resolves false for a command that exits immediately", async () => {
    const ok = await probeMcpServer(process.execPath, ["-e", "process.exit(1)"]);
    expect(ok).toBe(false);
  }, PROBE_TIMEOUT_MS + 2000);

  it("resolves false for a command that never answers", async () => {
    const ok = await probeMcpServer(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 200,
    });
    expect(ok).toBe(false);
  }, 5000);

  it("resolves false for a nonexistent command", async () => {
    const ok = await probeMcpServer("/nonexistent/mcp-server", []);
    expect(ok).toBe(false);
  }, PROBE_TIMEOUT_MS + 2000);
});
