import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureStableEntry, healStaleSavedEntries, stableMcpEntryPath } from "../server/mcp-stable";
import { resolveMcpEntry } from "../server/mcp-launch";

/**
 * 0.7.6: the injected path must survive a plugin reinstall, and the paths older
 * versions already saved into agent records must be restored.
 */

let home: string;
let bundle: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bunny-search-stable-"));
  bundle = path.join(home, "checkout", "bunny-search", "dist", "mcp-server.js");
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, "// bundled server\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

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
      "bunny-search",
      "old-install",
      "checkout",
      "bunny-search",
      "dist",
      "mcp-server.js",
    );
    writeAgent("ag-stale", {
      "bunny-search": { type: "stdio", command: "node", args: [stale] },
    });
    expect(fs.existsSync(stale)).toBe(false);

    expect(healStaleSavedEntries(bundle, "bunny-search", home)).toEqual([stale]);
    expect(fs.readFileSync(stale, "utf-8")).toBe("// bundled server\n");
  });

  it("only heals this plugin's own key, and only inside its own directory", () => {
    const foreign = path.join(home, "elsewhere", "mcp-server.js");
    writeAgent("ag-other-key", {
      "other-server": {
        type: "stdio",
        command: "node",
        args: [path.join(home, "plugins", "bunny-search", "x", "dist", "mcp-server.js")],
      },
    });
    expect(healStaleSavedEntries(bundle, "bunny-search", home)).toEqual([]);

    writeAgent("ag-outside", {
      "bunny-search": { type: "stdio", command: "node", args: [foreign] },
    });
    expect(healStaleSavedEntries(bundle, "bunny-search", home)).toEqual([]);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it("skips an entry that still exists", () => {
    const existing = path.join(home, "plugins", "bunny-search", "keep", "mcp-server.js");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "// old server\n");
    writeAgent("ag-intact", {
      "bunny-search": { type: "stdio", command: "node", args: [existing] },
    });

    expect(healStaleSavedEntries(bundle, "bunny-search", home)).toEqual([]);
    expect(fs.readFileSync(existing, "utf-8")).toBe("// old server\n");
  });
});
