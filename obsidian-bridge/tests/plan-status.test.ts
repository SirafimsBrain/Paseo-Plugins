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

const DONE_LEAF = [
  "---",
  "id: 5c1b7e20-8f34-4a10-9c77-1e2d3b4a5c60",
  "schema: 1",
  "kind: leaf",
  "name: Finished fact",
  "description: already done",
  "status: done",
  "version: 1",
  "revision: 2",
  'parent: "[[Workspaces/centurion/backend/auth/auth|auth]]"',
  "children: []",
  "influences: []",
  "created: 2026-11-18T10:00:00Z",
  "updated: 2026-11-18T10:00:00Z",
  "created_by: codex",
  "updated_by: codex",
  "---",
  "",
  "# Finished fact",
  "",
].join("\n");

function documentOf(created: TestWorkspace, relPath: string) {
  const parsed = parsePlanDocument(
    fs.readFileSync(path.join(created.vault, relPath), "utf-8"),
  );
  if ("error" in parsed) throw new Error(`${relPath}: ${parsed.error}`);
  return parsed.document;
}

async function setStatus(
  created: TestWorkspace,
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return dispatchTool("plan_set_status", input, runtimeSettings(created.vault, overrides));
}

describe("plan_set_status", () => {
  it("performs an allowed transition, snapshots and journals it", async () => {
    const created = workspace();
    const outcome = await setStatus(created, {
      path: "centurion/backend/auth/session-store",
      status: "blocked",
      expected_revision: 4,
      accept_external: true,
    });
    expect(outcome.isError).toBeUndefined();
    expect(outcome.structuredContent).toMatchObject({
      ok: true,
      status: "blocked",
      previous_status: "in_progress",
      version: 2,
      revision: 5,
    });

    const node = documentOf(created, "Workspaces/centurion/backend/auth/session-store.md");
    expect(node.frontmatter.status).toBe("blocked");
    expect(node.frontmatter.status_by).toBe("agent");
    expect(node.frontmatter.tags).toContain("plan/status/blocked");
    expect(node.frontmatter.tags).not.toContain("plan/status/in_progress");
    expect(
      fs.existsSync(
        path.join(
          created.vault,
          "Workspaces/centurion/backend/auth/__history/session-store.v2.r4.md",
        ),
      ),
    ).toBe(true);

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain("plan_set_status");
    expect(journal).toContain("in_progress → blocked");
  });

  it("refuses an illegal transition and writes nothing", async () => {
    const created = workspace({
      "Workspaces/centurion/backend/auth/finished.md": DONE_LEAF,
    });
    const before = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/backend/auth/finished.md"),
      "utf-8",
    );

    const outcome = await setStatus(created, {
      path: "centurion/backend/auth/finished",
      status: "in_progress",
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("cannot go done → in_progress");
    expect(
      fs.readFileSync(
        path.join(created.vault, "Workspaces/centurion/backend/auth/finished.md"),
        "utf-8",
      ),
    ).toBe(before);
    expect(
      fs.existsSync(
        path.join(created.vault, "Workspaces/centurion/backend/auth/__history"),
      ),
    ).toBe(true); // fixture snapshot only
    expect(
      fs.existsSync(
        path.join(
          created.vault,
          "Workspaces/centurion/backend/auth/__history/finished.v1.r2.md",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a no-op transition", async () => {
    const created = workspace();
    const outcome = await setStatus(created, {
      path: "centurion/backend/auth/session-store",
      status: "in_progress",
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("cannot go in_progress → in_progress");
  });

  it("requires a reason to override a status the user set", async () => {
    const created = workspace();
    const refused = await setStatus(created, {
      path: "centurion/backend/auth/token-refresh",
      status: "claimed",
      accept_external: true,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("set by the user");

    const accepted = await setStatus(created, {
      path: "centurion/backend/auth/token-refresh",
      status: "claimed",
      reason: "picked up after the standup",
      accept_external: true,
    });
    expect(accepted.isError).toBeUndefined();

    const node = documentOf(created, "Workspaces/centurion/backend/auth/token-refresh.md");
    expect(node.frontmatter.status).toBe("claimed");
    expect(node.frontmatter.status_reason).toBe("picked up after the standup");
    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain("reason: picked up after the standup");
  });

  it("does not require a reason when the user performs the move", async () => {
    const created = workspace();
    const outcome = await setStatus(created, {
      path: "centurion/backend/auth/token-refresh",
      status: "claimed",
      actor: "user",
      accept_external: true,
    });
    expect(outcome.isError).toBeUndefined();
  });

  it("refuses an unknown status for the kind", async () => {
    const created = workspace();
    const outcome = await setStatus(created, {
      path: "centurion/backend/auth/token-refresh",
      status: "approved",
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("is not a status of a leaf");
  });

  it("refuses every status write when readOnly is on", async () => {
    const created = workspace();
    const outcome = await setStatus(
      created,
      { path: "centurion/backend/auth/session-store", status: "blocked" },
      { readOnly: true },
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/readOnly/);
    expect(
      documentOf(created, "Workspaces/centurion/backend/auth/session-store.md").frontmatter.status,
    ).toBe("in_progress");
  });
});
