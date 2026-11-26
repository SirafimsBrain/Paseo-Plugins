import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  piAgentDir,
  piMcpPath,
  piMcpStatus,
  registerPiMcp,
  unregisterPiMcp,
} from "../server/pi-mcp";

/**
 * Pi reads its user-level stdio MCP servers from `<agent-dir>/mcp.json`, where
 * the agent directory is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. The tests
 * isolate both variables so they never touch a real Pi install.
 */
let home: string;
let originalHome: string | undefined;
let originalAgentDir: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-pi-"));
  originalHome = process.env.HOME;
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Pi MCP registration", () => {
  it("resolves the default config path under ~/.pi/agent", () => {
    expect(piAgentDir()).toBe(path.join(home, ".pi", "agent"));
    expect(piMcpPath()).toBe(path.join(home, ".pi", "agent", "mcp.json"));
  });

  it("follows PI_CODING_AGENT_DIR when the agent directory is moved", () => {
    const moved = path.join(home, "pi-root");
    process.env.PI_CODING_AGENT_DIR = moved;
    expect(piAgentDir()).toBe(moved);
    expect(piMcpPath()).toBe(path.join(moved, "mcp.json"));
  });

  it("reports an undetected config file on a clean machine", () => {
    const status = piMcpStatus();
    expect(status.path).toBe(piMcpPath());
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.upToDate).toBeNull();
    expect(status.command).toBeNull();
    expect(status.args).toBeNull();
  });

  it("registers into a missing config file, creating it", () => {
    const result = registerPiMcp();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const settings = JSON.parse(fs.readFileSync(piMcpPath(), "utf-8"));
    const entry = settings.mcpServers["memory-flash"];
    expect(typeof entry.command).toBe("string");
    expect(Array.isArray(entry.args)).toBe(true);
    expect(entry.args[0]).toMatch(/mcp-server\.js$/);

    const status = piMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.upToDate).toBe(true);
  });

  it("preserves other servers when registering", () => {
    fs.mkdirSync(path.dirname(piMcpPath()), { recursive: true });
    fs.writeFileSync(
      piMcpPath(),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        },
      }),
      "utf-8",
    );
    expect(registerPiMcp().ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(piMcpPath(), "utf-8"));
    expect(settings.mcpServers.filesystem.command).toBe("npx");
    expect(settings.mcpServers["memory-flash"]).toBeDefined();
  });

  it("detects the Pi agent directory even when the file is missing", () => {
    fs.mkdirSync(path.dirname(piMcpPath()), { recursive: true });
    const status = piMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(false);
  });

  it("refuses to register over a corrupted config file", () => {
    fs.mkdirSync(path.dirname(piMcpPath()), { recursive: true });
    fs.writeFileSync(piMcpPath(), "{ not json", "utf-8");

    const result = registerPiMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be parsed");
    expect(fs.readFileSync(piMcpPath(), "utf-8")).toBe("{ not json");
  });

  it("unregisters only the memory-flash entry", () => {
    fs.mkdirSync(path.dirname(piMcpPath()), { recursive: true });
    fs.writeFileSync(
      piMcpPath(),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
          "memory-flash": { command: "node", args: ["old.js"] },
        },
      }),
      "utf-8",
    );
    expect(unregisterPiMcp().ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(piMcpPath(), "utf-8"));
    expect(settings.mcpServers["memory-flash"]).toBeUndefined();
    expect(settings.mcpServers.filesystem).toBeDefined();
    expect(piMcpStatus().installed).toBe(false);
  });
});
