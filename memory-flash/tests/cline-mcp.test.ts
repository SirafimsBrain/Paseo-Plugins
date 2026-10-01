import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clineMcpStatus,
  clineSettingsPath,
  registerClineMcp,
  unregisterClineMcp,
} from "../server/cline-mcp";

// Isolate $HOME so tests never touch the real Cline settings.
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-cline-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  };
});

describe("Cline MCP registration", () => {
  it("reports an undetected settings file on a clean machine", () => {
    const status = clineMcpStatus();
    expect(status.path).toBe(clineSettingsPath());
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.upToDate).toBeNull();
    expect(status.command).toBeNull();
    expect(status.args).toBeNull();
  });

  it("registers into a missing settings file, creating it", () => {
    const result = registerClineMcp();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const settings = JSON.parse(fs.readFileSync(clineSettingsPath(), "utf-8"));
    const entry = settings.mcpServers["memory-flash"];
    expect(entry.transport.type).toBe("stdio");
    expect(typeof entry.transport.command).toBe("string");
    expect(Array.isArray(entry.transport.args)).toBe(true);
    expect(entry.transport.args[0]).toMatch(/mcp-server\.js$/);

    const status = clineMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.upToDate).toBe(true);
  });

  it("preserves other servers when registering", () => {
    fs.mkdirSync(path.dirname(clineSettingsPath()), { recursive: true });
    fs.writeFileSync(
      clineSettingsPath(),
      JSON.stringify({
        mcpServers: {
          websearch: {
            transport: { type: "stdio", command: "python", args: ["serve.py"] },
          },
        },
      }),
      "utf-8",
    );
    expect(registerClineMcp().ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(clineSettingsPath(), "utf-8"));
    expect(settings.mcpServers.websearch.transport.command).toBe("python");
    expect(settings.mcpServers.websearch.transport.args).toEqual(["serve.py"]);
    expect(settings.mcpServers["memory-flash"]).toBeDefined();
  });

  it("refreshes an outdated registration on re-register", () => {
    expect(registerClineMcp().ok).toBe(true);
    // Simulate a stale entry (e.g. plugin moved to another directory).
    const settings = JSON.parse(fs.readFileSync(clineSettingsPath(), "utf-8"));
    settings.mcpServers["memory-flash"].transport.args = ["/gone/mcp-server.js"];
    fs.writeFileSync(clineSettingsPath(), JSON.stringify(settings), "utf-8");

    const stale = clineMcpStatus();
    expect(stale.installed).toBe(true);
    expect(stale.upToDate).toBe(false);

    expect(registerClineMcp().ok).toBe(true);
    expect(clineMcpStatus().upToDate).toBe(true);
  });

  it("unregisters only the memory-flash entry", () => {
    fs.mkdirSync(path.dirname(clineSettingsPath()), { recursive: true });
    fs.writeFileSync(
      clineSettingsPath(),
      JSON.stringify({
        mcpServers: {
          websearch: {
            transport: { type: "stdio", command: "python", args: ["serve.py"] },
          },
          "memory-flash": {
            transport: { type: "stdio", command: "node", args: ["old.js"] },
          },
        },
      }),
      "utf-8",
    );
    const result = unregisterClineMcp();
    expect(result.ok).toBe(true);

    const settings = JSON.parse(fs.readFileSync(clineSettingsPath(), "utf-8"));
    expect(settings.mcpServers["memory-flash"]).toBeUndefined();
    expect(settings.mcpServers.websearch).toBeDefined();
    expect(clineMcpStatus().installed).toBe(false);
  });

  it("unregister is a no-op when nothing is registered", () => {
    const result = unregisterClineMcp();
    expect(result.ok).toBe(true);
    expect(fs.existsSync(clineSettingsPath())).toBe(false);
  });

  it("refuses to register over a corrupted settings file", () => {
    fs.mkdirSync(path.dirname(clineSettingsPath()), { recursive: true });
    fs.writeFileSync(clineSettingsPath(), "{ not json", "utf-8");

    const status = clineMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(false);

    const result = registerClineMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be parsed");
    // The corrupted file must be left untouched.
    expect(fs.readFileSync(clineSettingsPath(), "utf-8")).toBe("{ not json");
  });
});
