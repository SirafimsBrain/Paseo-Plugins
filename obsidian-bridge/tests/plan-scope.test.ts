import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { planScope } from "../server/plan/scope";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const workspaces: TestWorkspace[] = [];

function workspace(notes: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

const PLAN_FIXTURE = {
  "Workspaces/_index.md": "# Planning\n",
  "Workspaces/_schema.md": "# Schema\n",
  "Workspaces/centurion/centurion.md": "# Centurion\n",
  "Workspaces/centurion/backend/backend.md": "# Backend\n",
  "Workspaces/centurion/backend/auth/auth.md": "# Auth\n",
  "Workspaces/centurion/backend/auth/session-store.md": "# Session store\n",
  "Workspaces/centurion/__history/centurion.v1.r1.md": "# Centurion (snapshot)\n",
  "Workspaces/centurion/backend/__history/auth.v1.r3.md": "# Auth (snapshot)\n",
  "Workspaces/_archive/old/old.md": "# Archived\n",
};

describe("planScope", () => {
  it("says planning is unavailable when the vault is not configured", () => {
    const scope = planScope(runtimeSettings(""));
    expect(scope.planning_available).toBe(false);
    expect(scope.reason).toBe("not_configured");
    expect(scope.writesEnabled).toBe(false);
    expect(scope.path).toBeNull();
  });

  it("creates a missing root and reports it ready", () => {
    const created = workspace({ "A.md": "# A\n" });
    const scope = planScope(runtimeSettings(created.vault));
    expect(scope.planning_available).toBe(true);
    expect(scope.reason).toBeNull();
    expect(scope.path).not.toBeNull();
    expect(fs.existsSync(path.join(created.vault, "Workspaces"))).toBe(true);
  });

  it("reports an empty root as ready, not as an unusable tree", () => {
    const created = workspace({});
    fs.mkdirSync(path.join(created.vault, "Workspaces"));
    const scope = planScope(runtimeSettings(created.vault));
    expect(scope.planning_available).toBe(true);
    expect(scope.reason).toBeNull();
    expect(scope.empty).toBe(true);
    expect(scope.path).not.toBeNull();
    expect(scope.documents).toBe(0);
    expect(scope.projects).toEqual([]);
  });

  it("counts the live tree and hides history and archive", () => {
    const created = workspace(PLAN_FIXTURE);
    const scope = planScope(runtimeSettings(created.vault));
    expect(scope.planning_available).toBe(true);
    expect(scope.reason).toBeNull();
    expect(scope.root).toBe("Workspaces");
    // _index, _schema, centurion, backend, auth, session-store — and neither
    // snapshot nor the archived node.
    expect(scope.documents).toBe(6);
    expect(scope.projects).toEqual(["centurion"]);
    expect(scope.projectCount).toBe(1);
    expect(scope.registry).toBe("Workspaces/_index.md");
    expect(scope.schema).toBe("Workspaces/_schema.md");
    expect(scope.systemDirs).toEqual(["__history", "_archive"]);
    expect(scope.limits.maxWriteChars).toBe(200_000);
  });

  it("follows readOnly", () => {
    const created = workspace(PLAN_FIXTURE);
    const scope = planScope(runtimeSettings(created.vault, { readOnly: true }));
    expect(scope.planning_available).toBe(true);
    expect(scope.writesEnabled).toBe(false);
  });

  it("serves an unconfigured installation through the tool without opening the index", async () => {
    const outcome = await dispatchTool("plan_scope", {}, runtimeSettings(""));
    expect(outcome.isError).toBeUndefined();
    const scope = outcome.structuredContent as { planning_available: boolean; reason: string };
    expect(scope.planning_available).toBe(false);
    expect(scope.reason).toBe("not_configured");
  });
});

describe("document tools vs planning system directories", () => {
  it("refuses to read a snapshot or an archived node", async () => {
    const created = workspace(PLAN_FIXTURE);
    const settings = runtimeSettings(created.vault);
    for (const relPath of [
      "Workspaces/centurion/__history/centurion.v1.r1.md",
      "Workspaces/_archive/old/old.md",
    ]) {
      const outcome = await dispatchTool("obsidian_read", { path: relPath }, settings);
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("planning history");
    }
  });

  it("refuses to outline or edit them either", async () => {
    const created = workspace(PLAN_FIXTURE);
    const settings = runtimeSettings(created.vault);
    const outline = await dispatchTool(
      "obsidian_outline",
      { path: "Workspaces/centurion/__history/centurion.v1.r1.md" },
      settings,
    );
    expect(outline.isError).toBe(true);

    const edit = await dispatchTool(
      "obsidian_edit",
      {
        path: "Workspaces/centurion/__history/centurion.v1.r1.md",
        old_text: "snapshot",
        new_text: "changed",
      },
      settings,
    );
    expect(edit.isError).toBe(true);
    expect(
      fs.readFileSync(
        path.join(created.vault, "Workspaces/centurion/__history/centurion.v1.r1.md"),
        "utf-8",
      ),
    ).toContain("snapshot");
  });
});
