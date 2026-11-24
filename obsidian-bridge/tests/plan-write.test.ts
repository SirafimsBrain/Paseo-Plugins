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

async function call(
  created: TestWorkspace,
  name: string,
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return dispatchTool(name, input, runtimeSettings(created.vault, overrides));
}

describe("plan_create_node", () => {
  it("names the leaf in the way when a child path points below one", async () => {
    const created = workspace();
    await call(created, "plan_create_node", {
      path: "centurion/backend/auth/extra",
      kind: "leaf",
      name: "Extra",
    });
    const refused = await call(created, "plan_create_node", {
      path: "centurion/backend/auth/extra/child",
      kind: "leaf",
      name: "Child",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("'centurion/backend/auth/extra.md' is a leaf and cannot have children");
  });

  it("creates a trunk as v1 r1, links it into the root and journals it", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_create_node", {
      path: "centurion/devops",
      kind: "trunk",
      name: "DevOps",
      description: "CI and deployment",
      notes: "Runs on the same host.",
    });
    expect(outcome.isError).toBeUndefined();
    const result = outcome.structuredContent as {
      ok: boolean;
      path: string;
      version: number;
      revision: number;
      id: string;
    };
    expect(result).toMatchObject({ ok: true, path: "centurion/devops/devops.md", version: 1, revision: 1 });
    expect(result.id).toBeTruthy();

    const node = documentOf(created, "Workspaces/centurion/devops/devops.md");
    expect(node.frontmatter).toMatchObject({
      kind: "trunk",
      name: "DevOps",
      version: 1,
      revision: 1,
      status: "draft",
      parent: "[[Workspaces/centurion/centurion|centurion]]",
      children: [],
    });
    expect(node.body).toContain("## Заметки");
    expect(node.body).toContain("Runs on the same host.");

    const root = documentOf(created, "Workspaces/centurion/centurion.md");
    expect(root.frontmatter.children).toContain(
      "[[Workspaces/centurion/devops/devops|devops]]",
    );
    expect(root.frontmatter.revision).toBe(13);
    expect(
      fs.existsSync(
        path.join(created.vault, "Workspaces/centurion/__history/centurion.v3.r12.md"),
      ),
    ).toBe(true);

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain("plan_create_node");
    expect(journal).toContain("v1 r1");
  });

  it("puts a leaf in the parent's folder and links it from that parent", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_create_node", {
      path: "centurion/backend/auth/rotate-tokens",
      kind: "leaf",
      name: "Rotate tokens on use",
      description: "Every refresh rotates the token.",
    });
    expect(outcome.isError).toBeUndefined();
    expect((outcome.structuredContent as { path: string }).path).toBe(
      "centurion/backend/auth/rotate-tokens.md",
    );

    const node = documentOf(created, "Workspaces/centurion/backend/auth/rotate-tokens.md");
    expect(node.frontmatter.parent).toBe("[[Workspaces/centurion/backend/auth/auth|auth]]");

    const auth = documentOf(created, "Workspaces/centurion/backend/auth/auth.md");
    expect(auth.frontmatter.children).toContain(
      "[[Workspaces/centurion/backend/auth/rotate-tokens|rotate-tokens]]",
    );
  });

  it("refuses a second file at the same path", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_create_node", {
      path: "centurion/devops",
      kind: "trunk",
      name: "DevOps",
    });
    expect(outcome.isError).toBeUndefined();
    const again = await call(created, "plan_create_node", {
      path: "centurion/devops",
      kind: "trunk",
      name: "DevOps again",
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already exists");
    expect(documentOf(created, "Workspaces/centurion/devops/devops.md").frontmatter.name).toBe(
      "DevOps",
    );
  });

  it("refuses a child kind the parent does not allow", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_create_node", {
      path: "centurion/backend/leaf",
      kind: "leaf",
      name: "Orphan leaf",
      parent: "centurion/backend",
    });
    // A trunk accepts only branches.
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("cannot have a leaf child");
    expect(fs.existsSync(path.join(created.vault, "Workspaces/centurion/backend/leaf/leaf.md"))).toBe(
      false,
    );
  });

  it("refuses a non-root node without a parent", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_create_node", {
      path: "loose",
      kind: "branch",
      name: "Loose",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("would have no parent");
  });

  it("refuses incident and goal kinds and points at their tools", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_create_node", {
      path: "centurion/_incidents/inc-9",
      kind: "incident",
      name: "INC-9",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("plan_incident");
  });

  it("refuses every create when readOnly is on", async () => {
    const created = workspace();
    const outcome = await call(
      created,
      "plan_create_node",
      { path: "centurion/devops", kind: "trunk", name: "DevOps" },
      { readOnly: true },
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/readOnly/);
    expect(fs.existsSync(path.join(created.vault, "Workspaces/centurion/devops"))).toBe(false);
  });
});

describe("plan_update_node", () => {
  it("snapshots the previous state and raises the revision", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/session-store",
      description: "Refresh tokens are stored hashed and rotated per use.",
      accept_external: true,
    });
    expect(outcome.isError).toBeUndefined();
    const result = outcome.structuredContent as {
      version: number;
      revision: number;
      snapshot: string;
    };
    expect(result).toMatchObject({ version: 2, revision: 5 });
    expect(result.snapshot).toBe(
      "Workspaces/centurion/backend/auth/__history/session-store.v2.r4.md",
    );

    const node = documentOf(created, "Workspaces/centurion/backend/auth/session-store.md");
    expect(node.frontmatter.description).toBe(
      "Refresh tokens are stored hashed and rotated per use.",
    );
    expect(node.frontmatter.version).toBe(2);
    expect(node.frontmatter.revision).toBe(5);
    expect(node.body).toContain("## Влияния");
  });

  it("creates v1 r1 → snapshot v1 r1 → r2 on a freshly created node", async () => {
    const created = workspace();
    const createdNode = await call(created, "plan_create_node", {
      path: "centurion/backend/auth/rotate-tokens",
      kind: "leaf",
      name: "Rotate tokens",
    });
    expect(createdNode.isError).toBeUndefined();

    const updated = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/rotate-tokens",
      description: "Rotate on every refresh, revoke the previous row.",
      notes: "TTL lives in settings.py.",
    });
    expect(updated.isError).toBeUndefined();
    expect(updated.structuredContent).toMatchObject({ version: 1, revision: 2 });
    expect((updated.structuredContent as { snapshot: string }).snapshot).toBe(
      "Workspaces/centurion/backend/auth/__history/rotate-tokens.v1.r1.md",
    );

    const snapshot = documentOf(
      created,
      "Workspaces/centurion/backend/auth/__history/rotate-tokens.v1.r1.md",
    );
    expect(snapshot.frontmatter).toMatchObject({
      is_snapshot: true,
      snapshot_reason: "content_update",
      version: 1,
      revision: 1,
    });
    expect(snapshot.frontmatter).not.toHaveProperty("parent");
  });

  it("updates only the `## Заметки` section", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/session-store",
      notes: "A notes-only update.",
      accept_external: true,
    });
    expect(outcome.isError).toBeUndefined();
    expect(outcome.structuredContent).toMatchObject({ version: 2, revision: 5 });
    expect((outcome.structuredContent as { snapshot: string }).snapshot).toBe(
      "Workspaces/centurion/backend/auth/__history/session-store.v2.r4.md",
    );

    const node = documentOf(created, "Workspaces/centurion/backend/auth/session-store.md");
    expect(node.body).toContain("A notes-only update.");
    expect(node.body).not.toContain("Хэш считается");
    expect(node.frontmatter.description).toContain("Refresh tokens are stored");
  });

  it("raises the version, resets the revision, retags and moves the file on a kind change", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/token-refresh",
      kind: "subbranch",
      accept_external: true,
    });
    expect(outcome.isError).toBeUndefined();
    expect(outcome.structuredContent).toMatchObject({
      version: 2,
      revision: 1,
      files_changed: 2,
    });

    const node = documentOf(
      created,
      "Workspaces/centurion/backend/auth/token-refresh/token-refresh.md",
    );
    expect(node.frontmatter.kind).toBe("subbranch");
    expect(node.frontmatter.version).toBe(2);
    expect(node.frontmatter.revision).toBe(1);
    // The tag follows the kind instead of staying `plan/leaf` forever (P3).
    expect(node.frontmatter.tags).toEqual(["plan/subbranch"]);
    // The leaf layout is gone, the snapshots moved with the file (P2/P3).
    expect(
      fs.existsSync(path.join(created.vault, "Workspaces/centurion/backend/auth/token-refresh.md")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          created.vault,
          "Workspaces/centurion/backend/auth/token-refresh/__history/token-refresh.v1.r1.md",
        ),
      ),
    ).toBe(true);
    // The parent's `children` entry follows the new address.
    const auth = documentOf(created, "Workspaces/centurion/backend/auth/auth.md");
    expect(auth.frontmatter.children).toContain(
      "[[Workspaces/centurion/backend/auth/token-refresh/token-refresh|token-refresh]]",
    );
  });

  it("refuses a kind change that would orphan children", async () => {
    const created = workspace();
    expect(
      (
        await call(created, "plan_create_node", {
          path: "centurion/backend/auth/flows",
          kind: "subbranch",
          name: "Flows",
        })
      ).isError,
    ).toBeUndefined();
    expect(
      (
        await call(created, "plan_create_node", {
          path: "centurion/backend/auth/flows/refresh",
          kind: "leaf",
          name: "Refresh",
        })
      ).isError,
    ).toBeUndefined();

    const outcome = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/flows",
      kind: "leaf",
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("cannot become a leaf");
  });

  it("refuses a stale expected_revision and writes nothing", async () => {
    const created = workspace();
    const before = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/backend/auth/token-refresh.md"),
      "utf-8",
    );
    const outcome = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/token-refresh",
      description: "new",
      expected_revision: 99,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("v1 r1");
    expect(
      fs.readFileSync(
        path.join(created.vault, "Workspaces/centurion/backend/auth/token-refresh.md"),
        "utf-8",
      ),
    ).toBe(before);
    expect(
      fs.existsSync(
        path.join(
          created.vault,
          "Workspaces/centurion/backend/auth/__history/token-refresh.v1.r1.md",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a file changed outside the tools unless accept_external is set", async () => {
    const created = workspace();
    const absolute = path.join(created.vault, "Workspaces/centurion/backend/auth/session-store.md");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(absolute, future, future);

    const refused = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/session-store",
      description: "changed outside",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("changed on disk");

    const accepted = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/session-store",
      description: "changed outside",
      accept_external: true,
    });
    expect(accepted.isError).toBeUndefined();
  });

  it("refuses an update with nothing to change", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/session-store",
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Nothing to update");
  });

  it("refuses history and the archive", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_update_node", {
      path: "centurion/backend/auth/__history/session-store.v1.r3.md",
      description: "rewrite the past",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/history|snapshot/i);
  });
});
