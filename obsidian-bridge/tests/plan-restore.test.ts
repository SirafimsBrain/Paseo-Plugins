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

const LEAF = "Workspaces/centurion/backend/auth/session-store.md";
const ORIGINAL_DESCRIPTION =
  "Refresh tokens are stored as SHA-256 hashes; the plaintext exists only in the cookie. " +
  "A rotation writes a new row and revokes the previous one.";

describe("plan_restore", () => {
  it("writes a snapshot as a new revision and keeps relations", async () => {
    const created = workspace();
    const updated = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/session-store",
      description: "Wrong rewrite of the description.",
      accept_external: true,
    });
    expectOk(updated);
    expect(documentOf(created, LEAF).frontmatter.revision).toBe(5);

    const outcome = await call(created, "plan_restore", {
      path: "centurion/backend/auth/session-store",
      version: 2,
      revision: 4,
      actor: "codex",
    });
    expectOk(outcome);
    const result = outcome.structuredContent as {
      action: string;
      restored_from: string;
      version: number;
      revision: number;
      snapshot: string;
    };
    expect(result).toMatchObject({
      action: "restored",
      restored_from: "v2 r4",
      version: 2,
      revision: 6,
      snapshot: "Workspaces/centurion/backend/auth/__history/session-store.v2.r5.md",
    });

    const live = documentOf(created, LEAF);
    expect(String(live.frontmatter.description).trim()).toBe(ORIGINAL_DESCRIPTION);
    expect(live.frontmatter.restored_from).toBe("v2 r4");
    expect(live.frontmatter.version).toBe(2);
    expect(live.frontmatter.revision).toBe(6);

    // A restore is content-only: the graph stays as the live file had it.
    expect(live.frontmatter.parent).toBe("[[Workspaces/centurion/backend/auth/auth|auth]]");
    expect(live.frontmatter.influences).toHaveLength(1);
    expect(live.frontmatter.blocked_by).toHaveLength(1);
    expect(fs.existsSync(path.join(created.vault, "Workspaces/centurion/backend/auth/__history/session-store.v2.r5.md"))).toBe(true);

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain("plan_restore");
    expect(journal).toContain("restored v2 r4");
  });

  it("restores the notes text a snapshot kept", async () => {
    const created = workspace();
    expectOk(
      await call(created, "plan_create_node", {
        path: "centurion/backend/auth/notes-probe",
        kind: "leaf",
        name: "Notes probe",
        notes: "Original notes.",
      }),
    );
    expectOk(
      await call(created, "plan_update_node", {
        path: "centurion/backend/auth/notes-probe",
        notes: "Changed notes.",
      }),
    );

    const outcome = await call(created, "plan_restore", {
      path: "centurion/backend/auth/notes-probe",
      version: 1,
      revision: 1,
    });
    expectOk(outcome);
    const live = documentOf(created, "Workspaces/centurion/backend/auth/notes-probe.md");
    expect(live.body).toContain("Original notes.");
    expect(live.body).not.toContain("Changed notes.");
  });

  it("refuses a snapshot that does not exist", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_restore", {
      path: "centurion/backend/auth/session-store",
      version: 9,
      revision: 9,
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("no snapshot v9 r9");
    expect(documentOf(created, LEAF).frontmatter.revision).toBe(4);
  });

  it("requires version and revision and refuses a snapshot path as the target", async () => {
    const created = workspace();
    const missing = await call(created, "plan_restore", {
      path: "centurion/backend/auth/session-store",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("`version` and `revision` are required");

    const snapshot = await call(created, "plan_restore", {
      path: "centurion/backend/auth/__history/session-store.v1.r3.md",
      version: 1,
      revision: 3,
    });
    expect(snapshot.isError).toBe(true);
    expect(snapshot.text).toContain("snapshot");
  });

  it("refuses a snapshot taken before a kind change", async () => {
    const created = workspace();
    const moved = "Workspaces/centurion/backend/auth/session-store/session-store.md";
    expectOk(
      await call(created, "plan_update_node", {
        path: "centurion/backend/auth/session-store",
        kind: "subbranch",
        accept_external: true,
      }),
    );
    const live = documentOf(created, moved);
    expect(live.frontmatter.version).toBe(3);
    expect(live.frontmatter.revision).toBe(1);
    // The snapshots moved with the file, so v2 r4 is still reachable.
    expect(
      fs.existsSync(
        path.join(
          created.vault,
          "Workspaces/centurion/backend/auth/session-store/__history/session-store.v2.r4.md",
        ),
      ),
    ).toBe(true);

    const outcome = await call(created, "plan_restore", {
      path: "centurion/backend/auth/session-store",
      version: 2,
      revision: 4,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not a revision");
    expect(documentOf(created, moved).frontmatter.version).toBe(3);
  });
});
