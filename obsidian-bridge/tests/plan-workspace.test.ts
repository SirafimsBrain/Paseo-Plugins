import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { planRootRelPath, resolvePlanRoot } from "../server/plan/paths";
import { planScope } from "../server/plan/scope";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const ENV_KEYS = ["PASEO_WORKSPACE_ID", "PASEO_AGENT_CWD", "OBSIDIAN_PROJECT_NAME"] as const;
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

function paseoAgent(workspaceId: string, projectCwd: string) {
  process.env.PASEO_WORKSPACE_ID = workspaceId;
  process.env.PASEO_AGENT_CWD = projectCwd;
}

function vaultWith(notes: Record<string, string> = {}) {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

describe("Paseo project planning root", () => {
  it("creates the default directory and a folder named after the Paseo project", () => {
    paseoAgent("wks_own", "/projects/My Project");
    const created = vaultWith();
    const scope = planScope(runtimeSettings(created.vault, { planRoot: "  " }));

    expect(scope.planning_available).toBe(true);
    expect(scope.reason).toBeNull();
    expect(scope.empty).toBe(true);
    expect(scope.root).toBe("Projects/my-project");
    expect(scope.project).toEqual({ name: "my-project" });
    expect(scope.workspaceId).toBe("wks_own");
    expect(fs.statSync(path.join(created.vault, "Projects/my-project")).isDirectory()).toBe(true);
  });

  it("respects a custom planning directory and the project-name override", () => {
    paseoAgent("wks_own", "/projects/ignored");
    process.env.OBSIDIAN_PROJECT_NAME = "Alpha Team";
    const created = vaultWith();
    const settings = runtimeSettings(created.vault, { planRoot: "Plans" });

    expect(planRootRelPath(settings)).toBe("Plans/alpha-team");
    expect(planScope(settings).root).toBe("Plans/alpha-team");
    expect(fs.statSync(path.join(created.vault, "Plans/alpha-team")).isDirectory()).toBe(true);
  });

  it("records the workspace id in plan YAML and lets every workspace of the project use the tree", async () => {
    paseoAgent("wks_own", "/projects/Own");
    const created = vaultWith({
      "Workspaces/Other/foreign.md": "# Foreign\n\nThis plan belongs to another project.\n",
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
    const file = path.join(created.vault, "Workspaces/own/mine/mine.md");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toContain("workspace_id: wks_own");

    // Another workspace of the same project addresses the very same tree.
    paseoAgent("wks_second", "/projects/Own");
    const fromSiblingWorkspace = await dispatchTool("plan_read", { path: "mine" }, settings);
    expect(fromSiblingWorkspace.isError).toBeUndefined();
    expect((fromSiblingWorkspace.structuredContent as { root?: string }).root).toBe(
      "Workspaces/own",
    );

    const foreign = await dispatchTool(
      "obsidian_read",
      { path: "Workspaces/Other/foreign.md" },
      settings,
    );
    expect(foreign.isError).toBeUndefined();
    expect((foreign.structuredContent as { content: string }).content).toContain("another project");
  });

  it("takes the project folder from the Git root, so sub-directories share it", () => {
    const created = vaultWith();
    const repo = path.join(path.dirname(created.vault), "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "backend", "src"), { recursive: true });
    paseoAgent("wks_deep", path.join(repo, "backend", "src"));

    expect(planRootRelPath(runtimeSettings(created.vault))).toBe("Workspaces/repo");
  });

  it("refuses instead of inventing a project folder when the project is unknown", () => {
    process.env.PASEO_WORKSPACE_ID = "wks_orphan";
    for (const key of ["PASEO_AGENT_CWD", "OBSIDIAN_PROJECT_NAME"] as const) delete process.env[key];
    const created = vaultWith();
    const scope = planScope(runtimeSettings(created.vault));

    expect(scope.planning_available).toBe(false);
    expect(scope.reason).toBe("invalid");
    expect(scope.error).toContain("project");
    // Nothing is created, and no per-workspace folder appears.
    expect(fs.existsSync(path.join(created.vault, "Workspaces"))).toBe(false);
  });

  it("uses the bare planning root without Paseo context", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const created = vaultWith();
    const resolved = resolvePlanRoot(runtimeSettings(created.vault));
    expect("root" in resolved && resolved.root.relPath).toBe("Workspaces");
    expect("root" in resolved && resolved.root.project).toBeNull();
    expect("root" in resolved && resolved.root.workspaceId).toBeNull();
  });
});
