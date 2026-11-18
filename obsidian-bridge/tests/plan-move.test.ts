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

async function frontendTrunk(created: TestWorkspace) {
  expectOk(
    await call(created, "plan_create_node", {
      path: "centurion/frontend",
      kind: "trunk",
      name: "Frontend",
      description: "UI and rendering",
    }),
  );
}

const OLD_AUTH = "Workspaces/centurion/backend/auth";
const NEW_AUTH = "Workspaces/centurion/frontend/auth";

describe("plan_move_node", () => {
  it("moves a subtree and rewrites every link into it", async () => {
    const created = workspace();
    await frontendTrunk(created);

    const outcome = await call(created, "plan_move_node", {
      path: "centurion/backend/auth",
      to: "centurion/frontend/auth",
      accept_external: true,
      actor: "codex",
    });
    expectOk(outcome);
    const result = outcome.structuredContent as {
      action: string;
      to: string;
      op_id: string;
      files_changed: number;
      mapping: Array<{ from: string; to: string }>;
    };
    expect(result.action).toBe("moved");
    expect(result.to).toBe("centurion/frontend/auth/auth.md");
    expect(result.op_id).toBeTruthy();
    expect(result.files_changed).toBeGreaterThanOrEqual(5);
    expect(result.mapping).toContainEqual({
      from: "Workspaces/centurion/backend/auth/session-store",
      to: "Workspaces/centurion/frontend/auth/session-store",
    });

    // The folder moved; the old one is gone.
    expect(fs.existsSync(path.join(created.vault, NEW_AUTH, "auth.md"))).toBe(true);
    expect(fs.existsSync(path.join(created.vault, OLD_AUTH))).toBe(false);

    const auth = documentOf(created, `${NEW_AUTH}/auth.md`);
    expect(auth.frontmatter.parent).toBe("[[Workspaces/centurion/frontend/frontend|frontend]]");
    expect(auth.frontmatter.children).toEqual([
      "[[Workspaces/centurion/frontend/auth/session-store|session-store]]",
      "[[Workspaces/centurion/frontend/auth/token-refresh|token-refresh]]",
    ]);

    const frontend = documentOf(created, "Workspaces/centurion/frontend/frontend.md");
    expect(frontend.frontmatter.children).toContain(
      "[[Workspaces/centurion/frontend/auth/auth|auth]]",
    );

    const backend = documentOf(created, "Workspaces/centurion/backend/backend.md");
    expect(backend.frontmatter.children).toEqual([]);

    // A relation between two moved leaves follows the move.
    const sessionStore = documentOf(created, `${NEW_AUTH}/session-store.md`);
    const edge = (sessionStore.frontmatter.influences as Array<Record<string, unknown>>)[0];
    expect(edge.target).toBe("[[Workspaces/centurion/frontend/auth/token-refresh|token-refresh]]");
    expect(sessionStore.frontmatter.blocked_by).toEqual([
      "[[Workspaces/centurion/_incidents/inc-7-session-loss|INC-7 session loss]]",
    ]);

    // Snapshots travelled with the folder.
    expect(fs.existsSync(path.join(created.vault, NEW_AUTH, "__history", "session-store.v1.r3.md"))).toBe(
      true,
    );

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain(`op:start ${result.op_id}`);
    expect(journal).toContain(`op:done ${result.op_id}`);

    const read = await call(created, "plan_read", { path: "centurion/frontend/auth/session-store" });
    expectOk(read);
    expect((read.structuredContent as { node: { path: string } }).node.path).toBe(
      "centurion/frontend/auth/session-store.md",
    );

    const old = await call(created, "plan_read", { path: "centurion/backend/auth" });
    expect(old.isError).toBe(true);
  });

  it("refuses an occupied destination, a root and a move inside itself", async () => {
    const created = workspace();
    await frontendTrunk(created);

    expectOk(
      await call(created, "plan_create_node", {
        path: "centurion/frontend/api",
        kind: "branch",
        name: "Api",
      }),
    );
    const occupied = await call(created, "plan_move_node", {
      path: "centurion/backend/auth",
      to: "centurion/frontend/api",
      accept_external: true,
    });
    expect(occupied.isError).toBe(true);
    expect(occupied.text).toContain("already exists");

    const root = await call(created, "plan_move_node", {
      path: "centurion",
      to: "centurion/centurion",
    });
    expect(root.isError).toBe(true);
    expect(root.text).toContain("project root");

    const inside = await call(created, "plan_move_node", {
      path: "centurion/backend/auth",
      to: "centurion/backend/auth/nested",
    });
    expect(inside.isError).toBe(true);
    expect(inside.text).toContain("inside itself");

    expect(fs.existsSync(path.join(created.vault, OLD_AUTH, "auth.md"))).toBe(true);
  });

  it("resumes an interrupted move from the destination after a rename", async () => {
    const created = workspace();
    await frontendTrunk(created);

    const opId = "resume-move-1";
    // Simulate a crash after the rename: the marker is in the journal and the
    // folder has moved, but no link was rewritten yet.
    fs.appendFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      `2026-11-18T00:00:00Z · op:start ${opId} · [[Workspaces/centurion/backend/auth/auth|auth]] · plan_move_node · pending · actor: agent\n`,
      "utf-8",
    );
    fs.mkdirSync(path.join(created.vault, "Workspaces/centurion/frontend"), { recursive: true });
    fs.renameSync(
      path.join(created.vault, OLD_AUTH),
      path.join(created.vault, NEW_AUTH),
    );

    const outcome = await call(created, "plan_move_node", {
      path: "centurion/backend/auth",
      to: "centurion/frontend/auth",
      op_id: opId,
    });
    expectOk(outcome);
    expect((outcome.structuredContent as { action: string }).action).toBe("resumed");

    const auth = documentOf(created, `${NEW_AUTH}/auth.md`);
    expect(auth.frontmatter.parent).toBe("[[Workspaces/centurion/frontend/frontend|frontend]]");
    const backend = documentOf(created, "Workspaces/centurion/backend/backend.md");
    expect(backend.frontmatter.children).toEqual([]);
    const frontend = documentOf(created, "Workspaces/centurion/frontend/frontend.md");
    expect(frontend.frontmatter.children).toContain(
      "[[Workspaces/centurion/frontend/auth/auth|auth]]",
    );

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain(`op:done ${opId}`);
    expect((journal.match(new RegExp(`op:done ${opId}`, "g")) ?? []).length).toBe(1);

    // A third call is a no-op rather than a duplicate.
    const again = await call(created, "plan_move_node", {
      path: "centurion/backend/auth",
      to: "centurion/frontend/auth",
      op_id: opId,
    });
    expectOk(again);
    expect((again.structuredContent as { action: string }).action).toBe("already_done");
  });

  it("refuses a move into a folder without a parent node", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_move_node", {
      path: "centurion/backend/auth",
      to: "centurion/nowhere/auth",
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("no parent node");
  });
});
