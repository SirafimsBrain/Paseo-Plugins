import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultSettings, luckPlannerSettings } from "../shared/settings";
import {
  MCP_SERVER_KEY,
  injectedMcpConfig,
  publishedMcpEntry,
  sessionActorEnv,
} from "../server/mcp-launch";

/**
 * Stage D3 (`PLAN.md`): the shape that goes into every agent's config and
 * the settings that gate it. The env semantics are pinned against the
 * installed daemon: stdio servers spawn with
 * `env: { ...sessionEnv, ...config.env }` — the session env carries the
 * agent id, `config.env` carries the server name.
 */

let home: string;
let originalPaseoHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "luck-inject-"));
  originalPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  // A fake directory install so `resolveMcpEntry` has a real bundle to
  // publish at the revision-independent path (the publication mechanics
  // themselves are covered by tests/mcp-launch.test.ts).
  const install = path.join(
    home,
    "plugins",
    "luck-planner",
    "rev-a",
    "checkout",
    "luck-planner",
  );
  fs.mkdirSync(path.join(install, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(install, "dist", "mcp-server.js"),
    "// luck-planner bundle\n",
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ plugins: { "luck-planner": { source: "directory", path: install } } }),
  );
  return () => {
    if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalPaseoHome;
    fs.rmSync(home, { recursive: true, force: true });
  };
});

describe("settings schema", () => {
  it("defaults to injection enabled with the default server name", () => {
    expect(defaultSettings()).toEqual({
      injectIntoAgents: true,
      mcpServerName: "luck-planner",
      httpPort: 8899,
      accessToken: "",
      historyRetentionDays: 0,
    });
    expect(luckPlannerSettings.schema.parse({})).toEqual(defaultSettings());
  });

  it("validates the server name", () => {
    expect(
      luckPlannerSettings.schema.parse({ mcpServerName: "  my-luck " })
        .mcpServerName,
    ).toBe("my-luck");
    expect(() =>
      luckPlannerSettings.schema.parse({ mcpServerName: "" }),
    ).toThrow();
    expect(() =>
      luckPlannerSettings.schema.parse({ mcpServerName: "x".repeat(61) }),
    ).toThrow();
    expect(() =>
      luckPlannerSettings.schema.parse({ injectIntoAgents: "yes" }),
    ).toThrow();
  });
});

describe("injectedMcpConfig", () => {
  it("builds a stdio config pointing at the published entry", () => {
    const config = injectedMcpConfig({ serverName: "custom-luck" });
    expect(config.type).toBe("stdio");
    expect(config.alwaysLoad).toBe(true);
    expect(path.basename(config.command)).toMatch(/^node(\.exe)?$/);
    expect(config.args).toHaveLength(1);
    // Revision-independent published path — the whole point of stage D2.
    expect(config.args[0]).toBe(publishedMcpEntry());
    expect(config.env.LUCK_PLANNER_SERVER_NAME).toBe("custom-luck");
    // Non-default daemon homes survive even a provider that passes
    // config.env through on its own.
    expect(config.env.PASEO_HOME).toBe(home);
  });

  it("keeps the config key stable — it becomes the host tool prefix", () => {
    expect(MCP_SERVER_KEY).toBe("luck-planner");
    // `dispatchMcpTool` strips `/^luck[-_]planner_/`; the key must keep
    // matching it or every host-prefixed call would come back unknown.
    expect(new RegExp(`^luck[-_]planner_`).test(`${MCP_SERVER_KEY}_luck_tree_search`)).toBe(
      true,
    );
    const a = injectedMcpConfig({ serverName: "one" });
    const b = injectedMcpConfig({ serverName: "two" });
    // Only the reported name changes — launch command and args never do.
    expect(b.args).toEqual(a.args);
    expect(b.command).toBe(a.command);
  });

  it("omits PASEO_HOME when the daemon runs on the default home", () => {
    delete process.env.PASEO_HOME;
    const config = injectedMcpConfig({ serverName: "luck-planner" });
    expect(config.env.PASEO_HOME).toBeUndefined();
    expect(config.env.LUCK_PLANNER_SERVER_NAME).toBe("luck-planner");
  });
});

describe("sessionActorEnv", () => {
  it("carries the agent id the audit trail needs", () => {
    expect(sessionActorEnv("agent-123")).toEqual({
      LUCK_PLANNER_AGENT_ID: "agent-123",
    });
    // The bundle reads exactly this variable at startup (mcp-server.ts),
    // and the e2e spawn asserts the actor lands in history rows.
    expect(Object.keys(sessionActorEnv("x"))).toEqual([
      "LUCK_PLANNER_AGENT_ID",
    ]);
  });
});
