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
const BRANCH_FILE = "Workspaces/centurion/durable-sessions/durable-sessions.md";

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
  it("materialises the steps into a trunk and its leaves", async () => {
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
      branch: { path: string; kind: string };
      leaves: Array<{ path: string; name: string }>;
      revision: number;
    };
    expect(result).toMatchObject({
      action: "approved",
      status: "approved",
      materialized: "centurion/durable-sessions/durable-sessions.md",
      branch: { path: "centurion/durable-sessions/durable-sessions.md", kind: "trunk" },
    });
    expect(result.leaves.map((leaf) => leaf.path)).toEqual([
      "centurion/durable-sessions/move-the-session-table.md",
      "centurion/durable-sessions/rotate-refresh-tokens.md",
    ]);

    const branch = documentOf(created, BRANCH_FILE);
    expect(branch.frontmatter).toMatchObject({
      kind: "trunk",
      version: 1,
      revision: 1,
      parent: "[[Workspaces/centurion/centurion|centurion]]",
    });
    expect(branch.frontmatter.children).toEqual([
      "[[Workspaces/centurion/durable-sessions/move-the-session-table|move-the-session-table]]",
      "[[Workspaces/centurion/durable-sessions/rotate-refresh-tokens|rotate-refresh-tokens]]",
    ]);

    const leaf = documentOf(
      created,
      "Workspaces/centurion/durable-sessions/move-the-session-table.md",
    );
    expect(leaf.frontmatter).toMatchObject({
      kind: "leaf",
      status: "draft",
      goal: "[[Workspaces/centurion/_goals/durable-sessions|durable-sessions]]",
      parent: "[[Workspaces/centurion/durable-sessions/durable-sessions|durable-sessions]]",
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

    const read = await call(created, "plan_read", {
      path: "centurion/durable-sessions/move-the-session-table",
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
