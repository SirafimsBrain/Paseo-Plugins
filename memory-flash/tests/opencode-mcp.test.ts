import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  kiloConfigPath,
  kiloMcpStatus,
  opencodeConfigPath,
  opencodeMcpStatus,
  registerKiloMcp,
  registerOpencodeMcp,
  unregisterKiloMcp,
  unregisterOpencodeMcp,
} from "../server/opencode-mcp";

/**
 * OpenCode and Kilo read MCP servers from `mcp` in their own config file.
 * Registering there is what survives OpenCode's per-directory location
 * eviction, so these tests pin the file handling: create, merge, refresh,
 * remove only our entry, and never rewrite a file we cannot round-trip.
 */

let home: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-opencode-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  // Keep the resolution predictable: `~/.config/<app>` under the temp home.
  delete process.env.XDG_CONFIG_HOME;
  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    fs.rmSync(home, { recursive: true, force: true });
  };
});

function writeConfig(target: string, document: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
}

function readConfig(target: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(target, "utf-8"));
}

describe("OpenCode MCP registration", () => {
  it("reports an undetected config on a clean machine", () => {
    const status = opencodeMcpStatus();
    expect(status.path).toBe(opencodeConfigPath());
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.upToDate).toBeNull();
  });

  it("creates a config file with a local server entry the agent can spawn", () => {
    const result = registerOpencodeMcp();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const settings = readConfig(opencodeConfigPath());
    const entry = settings.mcp["memory-flash"];
    expect(entry.type).toBe("local");
    // OpenCode and Kilo take the whole command line as an array.
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command).toHaveLength(2);
    expect(entry.command[1]).toMatch(/mcp-server\.js$/);
    expect(entry.enabled).toBe(true);

    const status = opencodeMcpStatus();
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.upToDate).toBe(true);
  });

  it("keeps every other key and server in the config file", () => {
    writeConfig(opencodeConfigPath(), {
      $schema: "https://opencode.ai/config.json",
      disabled_providers: ["x"],
      mcp: { other: { type: "remote", url: "https://example.test/mcp" } },
    });
    expect(registerOpencodeMcp().ok).toBe(true);

    const settings = readConfig(opencodeConfigPath());
    expect(settings.disabled_providers).toEqual(["x"]);
    expect(settings.mcp.other.url).toBe("https://example.test/mcp");
    expect(settings.mcp["memory-flash"].type).toBe("local");
  });

  it("prefers the existing .jsonc file over creating a new one", () => {
    const jsonc = path.join(path.dirname(opencodeConfigPath()), "opencode.jsonc");
    writeConfig(jsonc, { mcp: {} });
    expect(registerOpencodeMcp().ok).toBe(true);
    expect(fs.existsSync(jsonc)).toBe(true);
    expect(readConfig(jsonc).mcp["memory-flash"].type).toBe("local");
  });

  it("refreshes an outdated registration on re-register", () => {
    expect(registerOpencodeMcp().ok).toBe(true);
    const stale = readConfig(opencodeConfigPath());
    stale.mcp["memory-flash"].command = ["node", "/gone/mcp-server.js"];
    writeConfig(opencodeConfigPath(), stale);

    expect(opencodeMcpStatus().installed).toBe(true);
    expect(opencodeMcpStatus().upToDate).toBe(false);

    expect(registerOpencodeMcp().ok).toBe(true);
    expect(opencodeMcpStatus().upToDate).toBe(true);
  });

  it("removes only the memory-flash entry", () => {
    writeConfig(opencodeConfigPath(), {
      theme: "dark",
      mcp: {
        other: { type: "remote", url: "https://example.test/mcp" },
        "memory-flash": { type: "local", command: ["node", "old.js"], enabled: true },
      },
    });
    expect(unregisterOpencodeMcp().ok).toBe(true);

    const settings = readConfig(opencodeConfigPath());
    expect(settings.theme).toBe("dark");
    expect(settings.mcp["memory-flash"]).toBeUndefined();
    expect(settings.mcp.other).toBeDefined();
    expect(opencodeMcpStatus().installed).toBe(false);
  });

  it("drops the mcp key entirely when it becomes empty", () => {
    expect(registerOpencodeMcp().ok).toBe(true);
    expect(unregisterOpencodeMcp().ok).toBe(true);
    expect(readConfig(opencodeConfigPath()).mcp).toBeUndefined();
  });

  it("unregister is a no-op when nothing is registered", () => {
    const result = unregisterOpencodeMcp();
    expect(result.ok).toBe(true);
    expect(fs.existsSync(opencodeConfigPath())).toBe(false);
  });

  it("never rewrites a config file it cannot parse as JSON", () => {
    const target = path.join(path.dirname(opencodeConfigPath()), "opencode.jsonc");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const withComment = '{\n  // the user wants to keep this comment\n  "theme": "dark"\n}\n';
    fs.writeFileSync(target, withComment, "utf-8");

    const result = registerOpencodeMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be parsed");
    expect(fs.readFileSync(target, "utf-8")).toBe(withComment);
    expect(opencodeMcpStatus().installed).toBe(false);
  });
});

describe("Kilo MCP registration", () => {
  it("registers into kilo.jsonc, the file Kilo ships by default", () => {
    const target = path.join(path.dirname(kiloConfigPath()), "kilo.jsonc");
    writeConfig(target, { permission: { bash: { "npm test *": "allow" } } });
    expect(kiloMcpStatus().detected).toBe(true);
    expect(kiloMcpStatus().installed).toBe(false);

    expect(registerKiloMcp().ok).toBe(true);
    const settings = readConfig(target);
    expect(settings.permission.bash["npm test *"]).toBe("allow");
    expect(settings.mcp["memory-flash"].command).toHaveLength(2);
    expect(kiloMcpStatus().upToDate).toBe(true);
  });

  it("unregisters from the same file it registered into", () => {
    expect(registerKiloMcp().ok).toBe(true);
    const target = kiloConfigPath();
    expect(readConfig(target).mcp["memory-flash"]).toBeDefined();
    expect(unregisterKiloMcp().ok).toBe(true);
    expect(readConfig(target).mcp).toBeUndefined();
  });
});
