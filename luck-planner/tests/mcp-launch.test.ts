import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  isExecutableFile,
  mcpServerCommand,
  publishedMcpEntry,
  resolveMcpEntry,
} from "../server/mcp-launch";

/**
 * Regression cover for the memory-flash 0.7.1 failure: an agent created
 * before a plugin update keeps the MCP entry path baked into its config at
 * `agent.create` time, while the daemon deletes the per-revision install
 * directory on every update. The entry therefore has to live at a
 * revision-independent path and be re-published atomically.
 *
 * Stage J2 added the second half: the published entry is a **copy**, not a
 * link into the revision directory. A link dangles the moment the daemon
 * removes the revision — which is what the live install showed: the entry
 * pointed at the revision the update had just deleted, and every agent
 * spawning the server got "Cannot find module".
 */

const BUNDLE = "// luck-planner bundle\n";

/** A fake plugin home holding `config.json`; see {@link installRevision}. */
function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "luck-launch-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ plugins: {} }));
  return home;
}

/** Installs a plugin revision into `home` and points `config.json` at it. */
function installRevision(home: string, revision: string, bundle = BUNDLE): string {
  const install = path.join(
    home,
    "plugins",
    "luck-planner",
    revision,
    "checkout",
    "luck-planner",
  );
  mkdirSync(path.join(install, "dist"), { recursive: true });
  writeFileSync(path.join(install, "dist", "mcp-server.js"), bundle);
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ plugins: { "luck-planner": { source: "directory", path: install } } }),
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
      // Re-resolving must not churn the published file — the hot path runs
      // on plugin load and on every agent.create.
      expect(resolveMcpEntry()).toBe(entry);
      expect(existsSync(entry)).toBe(true);
      // The published entry is a *copy* of the bundle, not a link into the
      // revision: a link dies with the revision (stage J2, live daemon).
      expect(lstatSync(entry).isFile()).toBe(true);
      expect(readFileSync(entry, "utf8")).toBe(
        readFileSync(path.join(install, "dist", "mcp-server.js"), "utf8"),
      );
      // No staging leftovers.
      const dataDir = path.join(home, "plugins", "luck-planner");
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
      expect(entry).toBe(path.join(home, "plugins", "luck-planner", "mcp-server.js"));
      expect(readFileSync(entry, "utf8")).toBe(
        readFileSync(path.join(install, "dist", "mcp-server.js"), "utf8"),
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
      const entry = mcpServerCommand().args[0];
      expect(existsSync(entry)).toBe(true);

      // The daemon deletes the old revision and installs a new one.
      rmSync(path.join(home, "plugins", "luck-planner", "rev-a"), {
        recursive: true,
        force: true,
      });
      const install = installRevision(home, "rev-b", "// luck-planner bundle v2\n");

      // The published entry survives the deletion of the revision it was
      // copied from — a link into the revision would dangle here, and every
      // agent spawning the server would get "Cannot find module".
      expect(existsSync(entry)).toBe(true);
      expect(isExecutableFile(entry)).toBe(true);

      const refreshed = mcpServerCommand().args[0];
      // Same path the old agent already holds — so its config stays valid.
      expect(refreshed).toBe(entry);
      expect(existsSync(refreshed)).toBe(true);
      // And the refresh carries the new revision's bundle.
      expect(readFileSync(refreshed, "utf8")).toBe(
        readFileSync(path.join(install, "dist", "mcp-server.js"), "utf8"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("republishes over an entry left by a removed install", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      installRevision(home, "rev-a");
      resolveMcpEntry();
      rmSync(path.join(home, "plugins", "luck-planner", "rev-a"), {
        recursive: true,
        force: true,
      });
      // The copy is still there — the removal of the revision cannot take it
      // away, which is the whole point of publishing a copy.
      expect(existsSync(publishedMcpEntry())).toBe(true);

      installRevision(home, "rev-b", "// luck-planner bundle v2\n");
      expect(resolveMcpEntry()).toBe(publishedMcpEntry());
      expect(existsSync(publishedMcpEntry())).toBe(true);
      expect(readFileSync(publishedMcpEntry(), "utf8")).toContain("bundle v2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns the expected path when no bundle was built", () => {
    const home = makeHome();
    process.env.PASEO_HOME = home;
    try {
      const install = path.join(
        home,
        "plugins",
        "luck-planner",
        "rev-a",
        "checkout",
        "luck-planner",
      );
      mkdirSync(install, { recursive: true });
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ plugins: { "luck-planner": { path: install } } }),
      );
      expect(resolveMcpEntry()).toBe(path.join(install, "dist", "mcp-server.js"));
      // Nothing was published from a missing build.
      expect(existsSync(publishedMcpEntry())).toBe(false);
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
