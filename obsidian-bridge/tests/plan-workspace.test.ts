import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { planRootRelPath, resolvePlanRoot } from "../server/plan/paths";
import { planScope } from "../server/plan/scope";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const ENV_KEYS = ["PASEO_WORKSPACE_ID", "PASEO_AGENT_CWD", "OBSIDIAN_WORKSPACE_NAME"] as const;
const savedEnv: Record<string, string | undefined> = {};
const workspaces: TestWorkspace[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function paseoWorkspace(id: string, cwd: string) {
  process.env.PASEO_WORKSPACE_ID = id;
  process.env.PASEO_AGENT_CWD = cwd;
}

function vaultWith(notes: Record<string, string> = {}) {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

describe("Paseo workspace planning root", () => {
  it("creates the default directory and a folder named after the Paseo workspace", () => {
    paseoWorkspace("wks_own", "/projects/My Project");
    const created = vaultWith();
    const scope = planScope(runtimeSettings(created.vault, { planRoot: "  " }));

    expect(scope.planning_available).toBe(true);
    expect(scope.reason).toBeNull();
    expect(scope.empty).toBe(true);
    expect(scope.root).toBe("Workspaces/my-project");
    expect(scope.workspace).toEqual({ id: "wks_own", name: "my-project" });
    expect(fs.statSync(path.join(created.vault, "Workspaces/my-project")).isDirectory()).toBe(true);
  });

  it("respects a custom planning directory and the name override", () => {
    paseoWorkspace("wks_own", "/projects/ignored");
    process.env.OBSIDIAN_WORKSPACE_NAME = "Alpha Team";
    const created = vaultWith();
    const settings = runtimeSettings(created.vault, { planRoot: "Plans" });

    expect(planRootRelPath(settings)).toBe("Plans/alpha-team");
    expect(planScope(settings).root).toBe("Plans/alpha-team");
    expect(fs.statSync(path.join(created.vault, "Plans/alpha-team")).isDirectory()).toBe(true);
  });

  it("keeps plan_* inside its own workspace while obsidian_* can read another one", async () => {
    paseoWorkspace("wks_own", "/projects/Own");
    const created = vaultWith({
      "Workspaces/Other/foreign.md": "# Foreign\n\nThis plan belongs to another workspace.\n",
    });
    const settings = runtimeSettings(created.vault);

    const outside = await dispatchTool("plan_read", { path: "../Other/foreign" }, settings);
    expect(outside.isError).toBe(true);

    const createdNode = await dispatchTool(
      "plan_create_node",
      { path: "mine", kind: "root", name: "Mine" },
      settings,
    );
    expect(createdNode.isError).toBeUndefined();
    expect(fs.existsSync(path.join(created.vault, "Workspaces/own/mine/mine.md"))).toBe(true);

    const foreign = await dispatchTool(
      "obsidian_read",
      { path: "Workspaces/Other/foreign.md" },
      settings,
    );
    expect(foreign.isError).toBeUndefined();
    expect((foreign.structuredContent as { content: string }).content).toContain(
      "another workspace",
    );
  });

  it("uses the bare planning root without Paseo workspace context", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const created = vaultWith();
    const resolved = resolvePlanRoot(runtimeSettings(created.vault));
    expect("root" in resolved && resolved.root.relPath).toBe("Workspaces");
    expect("root" in resolved && resolved.root.workspace).toBeNull();
  });
});
