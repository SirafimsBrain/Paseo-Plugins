import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  codexConfigPath,
  codexMcpStatus,
  registerCodexMcp,
  unregisterCodexMcp,
} from "../server/codex-mcp";

// Isolate $HOME so tests never touch the real Codex config.
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-codex-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  };
});

describe("Codex CLI MCP registration", () => {
  it("reports an undetected config file on a clean machine", () => {
    const status = codexMcpStatus();
    expect(status.path).toBe(codexConfigPath());
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.upToDate).toBeNull();
    expect(status.command).toBeNull();
    expect(status.args).toBeNull();
  });

  it("registers into a missing config file, creating it", () => {
    const result = registerCodexMcp();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const config = fs.readFileSync(codexConfigPath(), "utf-8");
    expect(config).toContain("[mcp_servers.memory-flash]");
    expect(config).toMatch(/^command = ".*"$/m);
    expect(config).toMatch(/^args = \[.*mcp-server\.js.*\]$/m);

    const status = codexMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.upToDate).toBe(true);
    expect(status.command).toBeTypeOf("string");
    expect(status.args).toEqual([expect.stringMatching(/mcp-server\.js$/)]);
  });

  it("preserves unrelated content when registering", () => {
    fs.mkdirSync(path.dirname(codexConfigPath()), { recursive: true });
    const original = [
      "# my codex config",
      "model = \"gpt-5\"",
      "",
      "[mcp_servers.websearch]",
      "command = \"python\"",
      "args = [\"serve.py\"]",
      "",
      "[profiles.default]",
      "model = \"o4-mini\"",
      "",
    ].join("\n");
    fs.writeFileSync(codexConfigPath(), original, "utf-8");

    expect(registerCodexMcp().ok).toBe(true);

    const updated = fs.readFileSync(codexConfigPath(), "utf-8");
    expect(updated).toContain("# my codex config");
    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain("[mcp_servers.websearch]");
    expect(updated).toContain('command = "python"');
    expect(updated).toContain('args = ["serve.py"]');
    expect(updated).toContain("[profiles.default]");
    expect(updated).toContain("[mcp_servers.memory-flash]");
  });

  it("refreshes an outdated registration on re-register", () => {
    expect(registerCodexMcp().ok).toBe(true);
    // Simulate a stale entry (e.g. plugin moved to another directory).
    const config = fs.readFileSync(codexConfigPath(), "utf-8");
    const stale = config.replace(
      /^args = \[.*\]$/m,
      'args = ["/gone/mcp-server.js"]',
    );
    fs.writeFileSync(codexConfigPath(), stale, "utf-8");

    const staleStatus = codexMcpStatus();
    expect(staleStatus.installed).toBe(true);
    expect(staleStatus.upToDate).toBe(false);

    expect(registerCodexMcp().ok).toBe(true);
    expect(codexMcpStatus().upToDate).toBe(true);
  });

  it("detects a table registered with a quoted key", () => {
    fs.mkdirSync(path.dirname(codexConfigPath()), { recursive: true });
    const command = "node";
    const entry = ["node", "-e", "noop"].map((value) => `"${value}"`).join(", ");
    fs.writeFileSync(
      codexConfigPath(),
      `[mcp_servers."memory-flash"]\ncommand = "${command}"\nargs = [${entry}]\n`,
      "utf-8",
    );

    const status = codexMcpStatus();
    expect(status.installed).toBe(true);
    expect(status.command).toBe("node");
    expect(status.args).toEqual(["node", "-e", "noop"]);
  });

  it("unregisters only the memory-flash table", () => {
    fs.mkdirSync(path.dirname(codexConfigPath()), { recursive: true });
    fs.writeFileSync(
      codexConfigPath(),
      [
        "model = \"gpt-5\"",
        "",
        "[mcp_servers.websearch]",
        "command = \"python\"",
        "args = [\"serve.py\"]",
        "",
        "[mcp_servers.memory-flash]",
        'command = "node"',
        'args = ["old.js"]',
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = unregisterCodexMcp();
    expect(result.ok).toBe(true);

    const config = fs.readFileSync(codexConfigPath(), "utf-8");
    expect(config).not.toContain("mcp_servers.memory-flash");
    expect(config).toContain("[mcp_servers.websearch]");
    expect(config).toContain("model = \"gpt-5\"");
    expect(codexMcpStatus().installed).toBe(false);
  });

  it("unregister is a no-op when the config file is missing", () => {
    const result = unregisterCodexMcp();
    expect(result.ok).toBe(true);
    expect(fs.existsSync(codexConfigPath())).toBe(false);
  });

  it("unregister is a no-op when nothing is registered", () => {
    fs.mkdirSync(path.dirname(codexConfigPath()), { recursive: true });
    fs.writeFileSync(codexConfigPath(), "model = \"gpt-5\"\n", "utf-8");
    expect(unregisterCodexMcp().ok).toBe(true);
    expect(fs.readFileSync(codexConfigPath(), "utf-8")).toBe("model = \"gpt-5\"\n");
  });
});
