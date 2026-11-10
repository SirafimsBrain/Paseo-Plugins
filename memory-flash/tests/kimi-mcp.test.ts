import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  kimiCodeHome,
  kimiMcpPath,
  kimiMcpStatus,
  registerKimiMcp,
  unregisterKimiMcp,
} from "../server/kimi-mcp";

/**
 * Kimi Code CLI reads its user-level MCP servers from
 * `$KIMI_CODE_HOME/mcp.json` (`~/.kimi-code/mcp.json` by default). The tests
 * isolate both variables so they never touch a real Kimi install.
 */
let home: string;
let originalHome: string | undefined;
let originalKimiHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-kimi-"));
  originalHome = process.env.HOME;
  originalKimiHome = process.env.KIMI_CODE_HOME;
  process.env.HOME = home;
  delete process.env.KIMI_CODE_HOME;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = originalKimiHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Kimi Code CLI MCP registration", () => {
  it("resolves the default config path under ~/.kimi-code", () => {
    expect(kimiCodeHome()).toBe(path.join(home, ".kimi-code"));
    expect(kimiMcpPath()).toBe(path.join(home, ".kimi-code", "mcp.json"));
  });

  it("follows KIMI_CODE_HOME when the CLI's data root is moved", () => {
    const moved = path.join(home, "kimi-root");
    process.env.KIMI_CODE_HOME = moved;
    expect(kimiCodeHome()).toBe(moved);
    expect(kimiMcpPath()).toBe(path.join(moved, "mcp.json"));
  });

  it("reports an undetected config file on a clean machine", () => {
    const status = kimiMcpStatus();
    expect(status.path).toBe(kimiMcpPath());
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.upToDate).toBeNull();
    expect(status.command).toBeNull();
    expect(status.args).toBeNull();
  });

  it("registers into a missing config file, creating it", () => {
    const result = registerKimiMcp();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const settings = JSON.parse(fs.readFileSync(kimiMcpPath(), "utf-8"));
    const entry = settings.mcpServers["memory-flash"];
    expect(typeof entry.command).toBe("string");
    expect(Array.isArray(entry.args)).toBe(true);
    expect(entry.args[0]).toMatch(/mcp-server\.js$/);

    const status = kimiMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.upToDate).toBe(true);
  });

  it("preserves other servers when registering", () => {
    fs.mkdirSync(path.dirname(kimiMcpPath()), { recursive: true });
    fs.writeFileSync(
      kimiMcpPath(),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        },
      }),
      "utf-8",
    );
    expect(registerKimiMcp().ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(kimiMcpPath(), "utf-8"));
    expect(settings.mcpServers.filesystem.command).toBe("npx");
    expect(settings.mcpServers["memory-flash"]).toBeDefined();
  });

  it("detects the Kimi data directory even when the file is missing", () => {
    fs.mkdirSync(path.dirname(kimiMcpPath()), { recursive: true });
    const status = kimiMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(false);
  });

  it("refuses to register over a corrupted config file", () => {
    fs.mkdirSync(path.dirname(kimiMcpPath()), { recursive: true });
    fs.writeFileSync(kimiMcpPath(), "{ not json", "utf-8");

    const result = registerKimiMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be parsed");
    expect(fs.readFileSync(kimiMcpPath(), "utf-8")).toBe("{ not json");
  });

  it("unregisters only the memory-flash entry", () => {
    fs.mkdirSync(path.dirname(kimiMcpPath()), { recursive: true });
    fs.writeFileSync(
      kimiMcpPath(),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
          "memory-flash": { command: "node", args: ["old.js"] },
        },
      }),
      "utf-8",
    );
    expect(unregisterKimiMcp().ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(kimiMcpPath(), "utf-8"));
    expect(settings.mcpServers["memory-flash"]).toBeUndefined();
    expect(settings.mcpServers.filesystem).toBeDefined();
    expect(kimiMcpStatus().installed).toBe(false);
  });
});
