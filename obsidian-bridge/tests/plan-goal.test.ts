import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { parsePlanDocument } from "../server/plan/frontmatter";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { planFiles } from "./plan-fixtures";

const workspaces: TestWorkspace[] = [];

function workspace(extra: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace(planFiles(extra));
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

/** Fails with the tool's own message, which is the actionable part. */
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

async function createGoal(created: TestWorkspace) {
  const outcome = await call(created, "plan_goal", {
    path: GOAL,
    name: "Durable sessions",
    formal_text: "Sessions survive a daemon restart.",
    plan: [{ title: "Move the session table" }, "Rotate refresh tokens"],
    notes: "Approved shape is two leaves under auth.",
    actor: "claude",
  });
  expectOk(outcome);
  return outcome.structuredContent as {
    action: string;
    status: string;
    version: number;
    revision: number;
    steps: Array<{ id: string; title: string }>;
  };
}

describe("plan_goal", () => {
  it("creates a draft goal with stable step ids", async () => {
    const created = workspace();
    const result = await createGoal(created);
    expect(result).toMatchObject({ action: "created", status: "draft", version: 1, revision: 1 });
    expect(result.steps).toEqual([
      { id: "s1", title: "Move the session table" },
      { id: "s2", title: "Rotate refresh tokens" },
    ]);

    const goal = documentOf(created, GOAL_FILE);
    expect(goal.frontmatter).toMatchObject({
      kind: "goal",
      status: "draft",
      version: 1,
      revision: 1,
      formal_text: "Sessions survive a daemon restart.",
      materialized: null,
      project: "[[Workspaces/centurion/centurion|centurion]]",
    });
    expect(goal.body).toContain("Approved shape is two leaves under auth.");
  });

  it("proposes a draft once, and refuses a second proposal", async () => {
    const created = workspace();
    await createGoal(created);

    const proposed = await call(created, "plan_goal", { action: "propose", path: GOAL });
    expectOk(proposed);
    expect(proposed.structuredContent).toMatchObject({
      action: "proposed",
      status: "proposed",
      previous_status: "draft",
      revision: 2,
      snapshot: "Workspaces/centurion/_goals/__history/durable-sessions.v1.r1.md",
    });

    const again = await call(created, "plan_goal", { action: "propose", path: GOAL });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already proposed");
    expect(documentOf(created, GOAL_FILE).frontmatter.revision).toBe(2);
  });

  it("updates the formal text and the steps", async () => {
    const created = workspace();
    await createGoal(created);
    const outcome = await call(created, "plan_goal", {
      action: "update",
      path: GOAL,
      formal_text: "Sessions survive a restart and a deploy.",
      plan: [
        { id: "s1", title: "Move the session table", description: "SQLite table" },
        "Rotate refresh tokens",
        "Expire idle sessions",
      ],
    });
    expectOk(outcome);
    expect(outcome.structuredContent).toMatchObject({ revision: 2 });

    const goal = documentOf(created, GOAL_FILE);
    expect(goal.frontmatter.formal_text).toBe("Sessions survive a restart and a deploy.");
    expect(goal.frontmatter.plan).toEqual([
      { id: "s1", title: "Move the session table", description: "SQLite table" },
      { id: "s2", title: "Rotate refresh tokens" },
      { id: "s3", title: "Expire idle sessions" },
    ]);
  });

  it("refuses a goal outside _goals and one that already exists", async () => {
    const created = workspace();
    const outside = await call(created, "plan_goal", {
      path: "centurion/durable-sessions",
      name: "Durable sessions",
    });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain("_goals");

    const existing = await call(created, "plan_goal", {
      path: "centurion/_goals/session-persistence",
      name: "Another goal",
    });
    expect(existing.isError).toBe(true);
    expect(existing.text).toContain("already exists");
  });

  it("refuses a plan with duplicate step ids", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_goal", {
      path: GOAL,
      name: "Durable sessions",
      plan: [
        { id: "s1", title: "One" },
        { id: "s1", title: "Two" },
      ],
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("unique");
  });
});

describe("plan_growth", () => {
  it("records progress on a goal and merges steps by title", async () => {
    const created = workspace();
    await createGoal(created);

    const first = await call(created, "plan_growth", {
      path: GOAL,
      status: "active",
      summary: "Started the durable table",
      progress: 40,
      steps: [
        { title: "Move the session table", state: "completed", note: "Table created" },
        { title: "Rotate refresh tokens" },
      ],
      actor: "codex",
    });
    expectOk(first);
    expect(first.structuredContent).toMatchObject({
      revision: 2,
      previous: { version: 1, revision: 1 },
      growth: {
        status: "active",
        summary: "Started the durable table",
        progress: 40,
      },
    });
    // The counters this write replaced travel under `previous`, never as
    // `node.revision` beside the new revision (0.21.17).
    expect((first.structuredContent as { node?: unknown }).node).toBeUndefined();

    const second = await call(created, "plan_growth", {
      path: GOAL,
      steps: [{ title: "Move the session table", state: "in_progress" }],
    });
    expectOk(second);
    const growth = (
      second.structuredContent as {
        growth: { steps: Array<Record<string, unknown>>; progress: number };
      }
    ).growth;
    expect(growth.progress).toBe(40);
    expect(growth.steps).toEqual([
      {
        title: "Move the session table",
        state: "in_progress",
        note: "Table created",
      },
      { title: "Rotate refresh tokens", state: "pending" },
    ]);

    const goal = documentOf(created, GOAL_FILE);
    expect(goal.frontmatter.revision).toBe(3);
    expect(goal.frontmatter.growth).toMatchObject({
      status: "active",
      progress: 40,
    });

    const read = await call(created, "plan_read", { path: GOAL });
    expect((read.structuredContent as { growth?: { status: string } }).growth).toMatchObject({
      status: "active",
      progress: 40,
    });

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain("plan_growth");
  });

  it("replaces the step list only when asked", async () => {
    const created = workspace();
    await createGoal(created);
    await call(created, "plan_growth", {
      path: GOAL,
      steps: ["Move the session table", "Rotate refresh tokens"],
    });
    const replaced = await call(created, "plan_growth", {
      path: GOAL,
      steps: [{ title: "Expire idle sessions", state: "in_progress" }],
      replace: true,
    });
    expectOk(replaced);
    expect((replaced.structuredContent as { growth: { steps: unknown[] } }).growth.steps).toEqual([
      { title: "Expire idle sessions", state: "in_progress" },
    ]);
  });

  it("refuses an unknown state and an out-of-range progress", async () => {
    const created = workspace();
    await createGoal(created);
    const state = await call(created, "plan_growth", {
      path: GOAL,
      steps: [{ title: "Move the session table", state: "finished" }],
    });
    expect(state.isError).toBe(true);
    expect(state.text).toContain("not a step state");

    const progress = await call(created, "plan_growth", { path: GOAL, progress: 120 });
    expect(progress.isError).toBe(true);
    expect(progress.text).toContain("between 0 and 100");

    expect(documentOf(created, GOAL_FILE).frontmatter.revision).toBe(1);
  });

  it("refuses an incident as a growth subject", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_growth", {
      path: "centurion/_incidents/inc-7-session-loss",
      status: "active",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("incident");
  });
});
