import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clineMcpStatus, clineSettingsPath, registerClineMcp, unregisterClineMcp } from "../server/cline-mcp";

/**
 * Cline ignores a stdio server from the session payload, so the plugin writes
 * the entry into Cline's own settings file. These tests pin the entry shape,
 * the preservation of other servers and the refusal to touch a broken file.
 */

let home = "";
const previousHome = process.env.HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "obb-cline-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function settingsFile(): string {
  return clineSettingsPath();
}

function makeClineHome(): void {
  fs.mkdirSync(path.join(home, ".cline"), { recursive: true });
}

function readSettings(): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(settingsFile(), "utf-8"));
}

describe("Cline MCP registration", () => {
  it("writes the stdio transport entry", () => {
    makeClineHome();
    expect(registerClineMcp().ok).toBe(true);
    const entry = readSettings().mcpServers?.["obsidian-bridge"] as {
      transport: { type: string; command: string; args: string[] };
    };
    expect(entry.transport.type).toBe("stdio");
    expect(entry.transport.command).toMatch(/node$/);
    expect(entry.transport.args[0]).toMatch(/mcp-server\.js$/);
    expect(clineMcpStatus()).toMatchObject({ detected: true, installed: true, upToDate: true, error: null });
  });

  it("preserves other servers and unrelated keys", () => {
    makeClineHome();
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        mcpServers: { memory: { transport: { type: "stdio", command: "node", args: ["x.js"] } }, remote: { url: "http://x" } },
        theme: "dark",
      }),
      "utf-8",
    );
    registerClineMcp();
    const document = readSettings() as { theme?: string; mcpServers: Record<string, unknown> };
    expect(document.theme).toBe("dark");
    expect(Object.keys(document.mcpServers).sort()).toEqual(["memory", "obsidian-bridge", "remote"].sort());
  });

  it("reports an entry that points at an old install as outdated", () => {
    makeClineHome();
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        mcpServers: { "obsidian-bridge": { transport: { type: "stdio", command: "node", args: ["/gone.js"] } } },
      }),
      "utf-8",
    );
    expect(clineMcpStatus().upToDate).toBe(false);
    registerClineMcp();
    expect(clineMcpStatus().upToDate).toBe(true);
  });

  it("removes only its own entry", () => {
    makeClineHome();
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ mcpServers: { memory: { transport: { type: "stdio", command: "node", args: [] } } } }),
      "utf-8",
    );
    registerClineMcp();
    expect(unregisterClineMcp().ok).toBe(true);
    expect(Object.keys(readSettings().mcpServers ?? {})).toEqual(["memory"]);
  });

  it("does nothing when Cline is not installed", () => {
    const result = registerClineMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Cline is not installed/);
    expect(fs.existsSync(path.join(home, ".cline"))).toBe(false);
  });

  it("never overwrites a file it cannot parse", () => {
    makeClineHome();
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const broken = "{ not json";
    fs.writeFileSync(settingsFile(), broken, "utf-8");
    const result = registerClineMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/left untouched/);
    expect(fs.readFileSync(settingsFile(), "utf-8")).toBe(broken);
    expect(clineMcpStatus().error).not.toBeNull();
  });
});
