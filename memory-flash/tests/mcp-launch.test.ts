import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  mcpServerCommand,
  publishedMcpEntry,
  resolveMcpEntry,
} from "../server/mcp-launch";

/**
 * Regression cover for the `Connection closed` failure seen in real Paseo
 * work: an agent created before a plugin update keeps the MCP entry path that
 * was baked into its config at `agent.create` time, and the daemon deletes
 * the per-revision install directory on every update. The entry therefore has
 * to live at a revision-independent path.
 */

const BUNDLE = "// memory-flash bundle\n";

/** A fake plugin home holding `config.json`; see {@link installRevision}. */
function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "mf-launch-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ plugins: {} }));
  return home;
}

/** Installs a plugin revision into `home` and points `config.json` at it. */
function installRevision(home: string, revision: string, bundle = BUNDLE): string {
  const install = path.join(home, "plugins", "memory-flash", revision, "checkout", "memory-flash");
  mkdirSync(path.join(install, "dist"), { recursive: true });
  writeFileSync(path.join(install, "dist", "mcp-server.js"), bundle);
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ plugins: { "memory-flash": { source: "directory", path: install } } }),
  );
  return install;
}

describe("mcp-launch entry resolution", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.PASEO_HOME;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });

  it("publishes on the first resolution and stays idempotent", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      const install = installRevision(home, "rev-a");
      const entry = resolveMcpEntry();
      // Resolving again must not churn the published file — the hot path is
      // every agent.create and every registration into an agent config file.
      expect(resolveMcpEntry()).toBe(entry);
      expect(existsSync(entry)).toBe(true);
      expect(realpathSync(entry)).toBe(realpathSync(path.join(install, "dist", "mcp-server.js")));
      // No staging leftovers.
      const dataDir = path.join(home, "plugins", "memory-flash");
      expect(readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("publishes the entry at a revision-independent path", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      const install = installRevision(home, "rev-a");
      const entry = resolveMcpEntry();
      expect(entry).toBe(publishedMcpEntry());
      expect(entry).toBe(path.join(home, "plugins", "memory-flash", "mcp-server.js"));
      expect(realpathSync(entry)).toBe(
        realpathSync(path.join(install, "dist", "mcp-server.js")),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps an agent's entry working after the install revision is replaced", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      installRevision(home, "rev-a");
      // The agent config captures this path — as `agent.create` does.
      const entry = mcpServerCommand().args[0]!;
      expect(existsSync(entry)).toBe(true);

      // The daemon deletes the old revision and installs a new one.
      rmSync(path.join(home, "plugins", "memory-flash", "rev-a"), {
        recursive: true,
        force: true,
      });
      const install = installRevision(home, "rev-b", "// memory-flash bundle v2\n");

      const refreshed = mcpServerCommand().args[0]!;
      // Same path the old agent already holds — so its config stays valid.
      expect(refreshed).toBe(entry);
      expect(existsSync(refreshed)).toBe(true);
      expect(realpathSync(refreshed)).toBe(
        realpathSync(path.join(install, "dist", "mcp-server.js")),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("republishes over a dangling entry left by a removed install", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      installRevision(home, "rev-a");
      resolveMcpEntry();
      rmSync(path.join(home, "plugins", "memory-flash", "rev-a"), {
        recursive: true,
        force: true,
      });
      // A dangling link must not be mistaken for a usable entry.
      expect(existsSync(publishedMcpEntry())).toBe(false);

      installRevision(home, "rev-b");
      expect(resolveMcpEntry()).toBe(publishedMcpEntry());
      expect(existsSync(publishedMcpEntry())).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns the expected path when no bundle was built", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      const install = path.join(home, "plugins", "memory-flash", "rev-a", "checkout", "memory-flash");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ plugins: { "memory-flash": { path: install } } }),
      );
      expect(resolveMcpEntry()).toBe(path.join(install, "dist", "mcp-server.js"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("launches the published entry with a real node binary", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      installRevision(home, "rev-a");
      const launch = mcpServerCommand();
      expect(launch.args).toEqual([publishedMcpEntry()]);
      expect(path.basename(launch.command)).toMatch(/^node(\.exe)?$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
