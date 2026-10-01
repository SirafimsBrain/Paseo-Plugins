import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cursorMcpPath,
  cursorMcpStatus,
  registerCursorMcp,
  unregisterCursorMcp,
} from "../server/cursor-mcp";

// Isolate $HOME so tests never touch the real Cursor config.
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-cursor-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  };
});

describe("Cursor MCP registration", () => {
  it("reports an undetected config file on a clean machine", () => {
    const status = cursorMcpStatus();
    expect(status.path).toBe(cursorMcpPath());
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.upToDate).toBeNull();
    expect(status.command).toBeNull();
    expect(status.args).toBeNull();
  });

  it("registers into a missing config file, creating it", () => {
    const result = registerCursorMcp();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const settings = JSON.parse(fs.readFileSync(cursorMcpPath(), "utf-8"));
    const entry = settings.mcpServers["memory-flash"];
    expect(typeof entry.command).toBe("string");
    expect(Array.isArray(entry.args)).toBe(true);
    expect(entry.args[0]).toMatch(/mcp-server\.js$/);

    const status = cursorMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.upToDate).toBe(true);
  });

  it("preserves other servers when registering", () => {
    fs.mkdirSync(path.dirname(cursorMcpPath()), { recursive: true });
    fs.writeFileSync(
      cursorMcpPath(),
      JSON.stringify({
        mcpServers: {
          websearch: { command: "python", args: ["serve.py"] },
        },
      }),
      "utf-8",
    );
    expect(registerCursorMcp().ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(cursorMcpPath(), "utf-8"));
    expect(settings.mcpServers.websearch.command).toBe("python");
    expect(settings.mcpServers.websearch.args).toEqual(["serve.py"]);
    expect(settings.mcpServers["memory-flash"]).toBeDefined();
  });

  it("detects the config directory even when the file is missing", () => {
    fs.mkdirSync(path.dirname(cursorMcpPath()), { recursive: true });
    const status = cursorMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(false);
  });

  it("refuses to register over a corrupted config file", () => {
    fs.mkdirSync(path.dirname(cursorMcpPath()), { recursive: true });
    fs.writeFileSync(cursorMcpPath(), "{ not json", "utf-8");

    const result = registerCursorMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be parsed");
    expect(fs.readFileSync(cursorMcpPath(), "utf-8")).toBe("{ not json");
  });

  it("unregisters only the memory-flash entry", () => {
    fs.mkdirSync(path.dirname(cursorMcpPath()), { recursive: true });
    fs.writeFileSync(
      cursorMcpPath(),
      JSON.stringify({
        mcpServers: {
          websearch: { command: "python", args: ["serve.py"] },
          "memory-flash": { command: "node", args: ["old.js"] },
        },
      }),
      "utf-8",
    );
    expect(unregisterCursorMcp().ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(cursorMcpPath(), "utf-8"));
    expect(settings.mcpServers["memory-flash"]).toBeUndefined();
    expect(settings.mcpServers.websearch).toBeDefined();
    expect(cursorMcpStatus().installed).toBe(false);
  });
});
