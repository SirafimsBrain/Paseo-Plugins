import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { parsePlanDocument } from "../server/plan/frontmatter";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { planFiles } from "./plan-fixtures";

const workspaces: TestWorkspace[] = [];

function workspace(): TestWorkspace {
  const created = makeWorkspace(planFiles());
  workspaces.push(created);
  return created;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function documentOf(created: TestWorkspace, relPath: string) {
  const text = fs.readFileSync(path.join(created.vault, relPath), "utf-8");
  const parsed = parsePlanDocument(text);
  if ("error" in parsed) throw new Error(`${relPath}: ${parsed.error}`);
  return parsed.document;
}

function expectOk(outcome: { isError?: boolean; text: string }) {
  if (outcome.isError) throw new Error(outcome.text);
}

async function call(
  created: TestWorkspace,
  name: string,
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return dispatchTool(name, input, runtimeSettings(created.vault, overrides));
}

const GOAL = "centurion/_goals/durable-sessions";
const GOAL_FILE = "Workspaces/centurion/_goals/durable-sessions.md";
const TRUNK_FILE = "Workspaces/centurion/durable-sessions/durable-sessions.md";
const BRANCH_FILE = "Workspaces/centurion/durable-sessions/steps/steps.md";

/** A fresh goal: the tools write it, so no hand edit needs `accept_external`. */
async function proposedGoal(created: TestWorkspace, actor: string) {
  expectOk(
    await call(created, "plan_goal", {
      path: GOAL,
      name: "Durable sessions",
      formal_text: "Sessions survive a daemon restart.",
      plan: [
        { title: "Move the session table", description: "A durable SQLite table" },
        "Rotate refresh tokens",
      ],
      actor,
    }),
  );
  expectOk(await call(created, "plan_goal", { action: "propose", path: GOAL, actor }));
}

describe("plan_approve_goal", () => {
  it("materialises the steps into a trunk, a branch and its leaves", async () => {
    const created = workspace();
    await proposedGoal(created, "claude");

    const outcome = await call(created, "plan_approve_goal", {
      path: GOAL,
      actor: "codex",
    });
    expectOk(outcome);
    const result = outcome.structuredContent as {
      action: string;
      status: string;
      materialized: string;
      trunk: { path: string; kind: string };
      branch: { path: string; kind: string };
      leaves: Array<{ path: string; name: string }>;
      revision: number;
    };
    expect(result).toMatchObject({
      action: "approved",
      status: "approved",
      materialized: "centurion/durable-sessions/durable-sessions.md",
      trunk: { path: "centurion/durable-sessions/durable-sessions.md", kind: "trunk" },
      branch: { path: "centurion/durable-sessions/steps/steps.md", kind: "branch" },
    });
    expect(result.leaves.map((leaf) => leaf.path)).toEqual([
      "centurion/durable-sessions/steps/move-the-session-table.md",
      "centurion/durable-sessions/steps/rotate-refresh-tokens.md",
    ]);

    const trunk = documentOf(created, TRUNK_FILE);
    expect(trunk.frontmatter).toMatchObject({
      kind: "trunk",
      version: 1,
      revision: 1,
      parent: "[[Workspaces/centurion/centurion|centurion]]",
    });
    expect(trunk.frontmatter.children).toEqual([
      "[[Workspaces/centurion/durable-sessions/steps/steps|steps]]",
    ]);

    const branch = documentOf(created, BRANCH_FILE);
    expect(branch.frontmatter).toMatchObject({
      kind: "branch",
      version: 1,
      revision: 1,
      parent: "[[Workspaces/centurion/durable-sessions/durable-sessions|durable-sessions]]",
    });
    expect(branch.frontmatter.children).toEqual([
      "[[Workspaces/centurion/durable-sessions/steps/move-the-session-table|move-the-session-table]]",
      "[[Workspaces/centurion/durable-sessions/steps/rotate-refresh-tokens|rotate-refresh-tokens]]",
    ]);

    const leaf = documentOf(
      created,
      "Workspaces/centurion/durable-sessions/steps/move-the-session-table.md",
    );
    expect(leaf.frontmatter).toMatchObject({
      kind: "leaf",
      status: "draft",
      goal: "[[Workspaces/centurion/_goals/durable-sessions|durable-sessions]]",
      parent: "[[Workspaces/centurion/durable-sessions/steps/steps|steps]]",
    });

    const goal = documentOf(created, GOAL_FILE);
    expect(goal.frontmatter).toMatchObject({
      status: "approved",
      materialized: "[[Workspaces/centurion/durable-sessions/durable-sessions|durable-sessions]]",
    });
    expect(goal.frontmatter.revision).toBe(3);

    const root = documentOf(created, "Workspaces/centurion/centurion.md");
    expect(root.frontmatter.children).toContain(
      "[[Workspaces/centurion/durable-sessions/durable-sessions|durable-sessions]]",
    );

    // The approval must leave a plan the schema accepts: root → trunk → branch
    // → leaf, never a leaf directly under a trunk (P1 of the live test report).
    const validate = await call(created, "plan_validate", { project: "centurion" });
    expectOk(validate);
    // The fixture carries its own hand-written bodies and one influence loop,
    // so the assertion is about the approval's structure, not the whole plan.
    const report = validate.structuredContent as { issues: Array<{ kind: string }> };
    expect(
      report.issues.filter((issue) =>
        ["invalid_parent_kind", "layout_mismatch", "kind_tag_mismatch"].includes(issue.kind),
      ),
    ).toEqual([]);

    const read = await call(created, "plan_read", {
      path: "centurion/durable-sessions/steps/move-the-session-table",
    });
    expectOk(read);
    expect((read.structuredContent as { goal?: { path: string } }).goal?.path).toBe(
      "centurion/_goals/durable-sessions.md",
    );
  });

  it("refuses approval by the agent that created the goal", async () => {
    const created = workspace();
    await proposedGoal(created, "codex");
    const outcome = await call(created, "plan_approve_goal", { path: GOAL, actor: "codex" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("cannot approve");
    expect(documentOf(created, GOAL_FILE).frontmatter.status).toBe("proposed");
    expect(fs.existsSync(path.join(created.vault, "Workspaces/centurion/durable-sessions"))).toBe(
      false,
    );
  });

  it("lets the user approve what an agent created", async () => {
    const created = workspace();
    await proposedGoal(created, "codex");
    const outcome = await call(created, "plan_approve_goal", { path: GOAL, actor: "user" });
    expectOk(outcome);
    expect(documentOf(created, GOAL_FILE).frontmatter.status).toBe("approved");
  });

  it("refuses a draft goal and a second approval", async () => {
    const created = workspace();
    expectOk(
      await call(created, "plan_goal", {
        path: GOAL,
        name: "Durable sessions",
        plan: ["Move the session table"],
        actor: "claude",
      }),
    );
    const draft = await call(created, "plan_approve_goal", { path: GOAL, actor: "codex" });
    expect(draft.isError).toBe(true);
    expect(draft.text).toContain("only a proposed goal is approved");

    expectOk(await call(created, "plan_goal", { action: "propose", path: GOAL, actor: "claude" }));
    expectOk(await call(created, "plan_approve_goal", { path: GOAL, actor: "codex" }));

    const again = await call(created, "plan_approve_goal", { path: GOAL, actor: "user" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already materialised|only a proposed goal is approved/);
  });

  it("refuses a goal with no steps", async () => {
    const created = workspace();
    expectOk(
      await call(created, "plan_goal", {
        path: GOAL,
        name: "Empty goal",
        actor: "claude",
      }),
    );
    expectOk(await call(created, "plan_goal", { action: "propose", path: GOAL, actor: "claude" }));
    const outcome = await call(created, "plan_approve_goal", { path: GOAL, actor: "codex" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("no steps");
  });
});
