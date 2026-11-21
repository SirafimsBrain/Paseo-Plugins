import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureStableEntry,
  healStaleSavedEntries,
  refreshStableEntry,
  stableMcpEntryPath,
} from "../server/mcp-stable";
import { resolveMcpEntry } from "../server/mcp-launch";

/**
 * 0.9.11: the injected path must survive a plugin reinstall, and the paths older
 * versions already saved into agent records must be restored.
 */

let home: string;
let bundle: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-bridge-stable-"));
  bundle = path.join(home, "checkout", "obsidian-bridge", "dist", "mcp-server.js");
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, "// bundled server\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Writes a checkout whose `package.json` names `version`, returning its bundle. */
function checkoutWithVersion(version: string, content: string): string {
  const dir = path.join(home, "checkout", "obsidian-bridge");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "obsidian-bridge", version }),
  );
  const entry = path.join(dir, "dist", "mcp-server.js");
  fs.writeFileSync(entry, content);
  return entry;
}

/** Writes one agent record with the given saved MCP servers. */
function writeAgent(agentId: string, servers: Record<string, unknown>): void {
  const dir = path.join(home, "agents", "ws-one");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${agentId}.json`),
    JSON.stringify({ id: agentId, config: { provider: "opencode", mcpServers: servers } }),
  );
}

describe("stable MCP entry", () => {
  it("copies the bundle into the plugin data directory and injects that path", () => {
    const stable = ensureStableEntry(bundle, home);
    expect(stable).toBe(stableMcpEntryPath(home));
    expect(fs.readFileSync(stable as string, "utf-8")).toBe("// bundled server\n");
    // The launch command follows the stable copy, so a reinstall cannot move it.
    expect(resolveMcpEntry()).toBe(stable);
  });

  it("restores a saved entry that points into an older checkout", () => {
    const stale = path.join(
      home,
      "plugins",
      "obsidian-bridge",
      "old-install",
      "checkout",
      "obsidian-bridge",
      "dist",
      "mcp-server.js",
    );
    writeAgent("ag-stale", {
      "obsidian-bridge": { type: "stdio", command: "node", args: [stale] },
    });
    expect(fs.existsSync(stale)).toBe(false);

    expect(healStaleSavedEntries(bundle, "obsidian-bridge", home)).toEqual([stale]);
    expect(fs.readFileSync(stale, "utf-8")).toBe("// bundled server\n");
  });

  it("only heals this plugin's own key, and only inside its own directory", () => {
    const foreign = path.join(home, "elsewhere", "mcp-server.js");
    writeAgent("ag-other-key", {
      "other-server": {
        type: "stdio",
        command: "node",
        args: [path.join(home, "plugins", "obsidian-bridge", "x", "dist", "mcp-server.js")],
      },
    });
    expect(healStaleSavedEntries(bundle, "obsidian-bridge", home)).toEqual([]);

    writeAgent("ag-outside", {
      "obsidian-bridge": { type: "stdio", command: "node", args: [foreign] },
    });
    expect(healStaleSavedEntries(bundle, "obsidian-bridge", home)).toEqual([]);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it("skips an entry that still exists", () => {
    const existing = path.join(home, "plugins", "obsidian-bridge", "keep", "mcp-server.js");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "// old server\n");
    writeAgent("ag-intact", {
      "obsidian-bridge": { type: "stdio", command: "node", args: [existing] },
    });

    expect(healStaleSavedEntries(bundle, "obsidian-bridge", home)).toEqual([]);
    expect(fs.readFileSync(existing, "utf-8")).toBe("// old server\n");
  });

  it("heals nothing when the daemon has no agent records", () => {
    expect(healStaleSavedEntries(bundle, "obsidian-bridge", home)).toEqual([]);
  });
});

/**
 * 0.21.17: `paseo plugin update` does not restart the plugin host, so the
 * stable copy must follow the installed version without waiting for
 * `paseo plugin reload`.
 */
describe("stable MCP entry follows the installed version", () => {
  it("rewrites an older copy when the checkout ships another version", () => {
    const installed = checkoutWithVersion("0.21.17", "// new server\n");
    const stable = stableMcpEntryPath(home);
    fs.mkdirSync(path.dirname(stable), { recursive: true });
    fs.writeFileSync(stable, "// old server\n");

    expect(refreshStableEntry(installed, "0.21.16", home)).toMatchObject({
      target: stable,
      updated: true,
      running: "0.21.16",
      installed: "0.21.17",
    });
    expect(fs.readFileSync(stable, "utf-8")).toBe("// new server\n");
  });

  it("leaves a same-version copy alone, so a running agent is not raced", () => {
    const installed = checkoutWithVersion("0.21.17", "// new server\n");
    const stable = stableMcpEntryPath(home);
    fs.mkdirSync(path.dirname(stable), { recursive: true });
    fs.writeFileSync(stable, "// old server\n");

    expect(refreshStableEntry(installed, "0.21.17", home)?.updated).toBe(false);
    expect(fs.readFileSync(stable, "utf-8")).toBe("// old server\n");
  });

  it("creates the copy when it is missing, even at the running version", () => {
    const installed = checkoutWithVersion("0.21.17", "// new server\n");
    const stable = stableMcpEntryPath(home);
    expect(fs.existsSync(stable)).toBe(false);

    expect(refreshStableEntry(installed, "0.21.17", home)?.updated).toBe(true);
    expect(fs.readFileSync(stable, "utf-8")).toBe("// new server\n");
  });

  it("does nothing when the checkout has no readable version", () => {
    const naked = path.join(home, "naked", "dist", "mcp-server.js");
    fs.mkdirSync(path.dirname(naked), { recursive: true });
    fs.writeFileSync(naked, "// unknown\n");

    expect(refreshStableEntry(naked, "0.21.16", home)).toBeNull();
    expect(fs.existsSync(stableMcpEntryPath(home))).toBe(false);
  });

  it("reports no change when the installed bundle is the stable copy", () => {
    const stable = stableMcpEntryPath(home);
    fs.mkdirSync(path.dirname(stable), { recursive: true });
    fs.writeFileSync(stable, "// server\n");

    expect(refreshStableEntry(stable, "0.21.16", home)).toMatchObject({ updated: false });
  });
});
