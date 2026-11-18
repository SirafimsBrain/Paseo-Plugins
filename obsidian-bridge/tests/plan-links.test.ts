import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { parsePlanDocument } from "../server/plan/frontmatter";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { planFiles, SECOND_PROJECT } from "./plan-fixtures";

/*
 * `SECOND_PROJECT` gives the cross-project rule a real second tree to refuse.
 */
const workspaces: TestWorkspace[] = [];

function workspace(extra: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace({ ...planFiles(extra), ...SECOND_PROJECT });
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

async function readNode(created: TestWorkspace, nodePath: string) {
  const outcome = await call(created, "plan_read", { path: nodePath });
  expectOk(outcome);
  return outcome.structuredContent as {
    influences?: Array<{ target: { path: string }; status: string | null; impact: string | null }>;
    influencedBy?: Array<{ source: { path: string }; status: string | null }>;
    beeCycle?: string[] | null;
  };
}

/** A leaf the tools created, so no hand edit needs `accept_external`. */
async function freshLeaf(created: TestWorkspace, slug: string): Promise<string> {
  const outcome = await call(created, "plan_create_node", {
    path: `centurion/backend/auth/${slug}`,
    kind: "leaf",
    name: slug,
    description: `Fixture leaf ${slug}`,
  });
  expectOk(outcome);
  return `centurion/backend/auth/${slug}`;
}

describe("plan_link", () => {
  it("writes the edge on the source and shows it from both sides", async () => {
    const created = workspace();
    const source = await freshLeaf(created, "rotate-tokens");

    const outcome = await call(created, "plan_link", {
      source,
      target: "centurion/backend/auth/token-refresh",
      impact: "A rotation change invalidates the refresh assumptions",
      actor: "codex",
    });
    expectOk(outcome);
    const result = outcome.structuredContent as {
      action: string;
      status: string;
      revision: number;
      snapshot: string;
    };
    expect(result).toMatchObject({ action: "created", status: "active", revision: 2 });
    expect(result.snapshot).toBe(
      "Workspaces/centurion/backend/auth/__history/rotate-tokens.v1.r1.md",
    );

    const written = documentOf(created, "Workspaces/centurion/backend/auth/rotate-tokens.md");
    expect(written.frontmatter.influences).toEqual([
      {
        target: "[[Workspaces/centurion/backend/auth/token-refresh|token-refresh]]",
        status: "active",
        impact: "A rotation change invalidates the refresh assumptions",
        version: 1,
        revision: 1,
      },
    ]);
    expect(written.body).toContain("## Влияния");
    expect(written.body).toContain("token-refresh");

    const forward = await readNode(created, source);
    expect(forward.influences?.[0]).toMatchObject({
      status: "active",
      impact: "A rotation change invalidates the refresh assumptions",
    });
    const backward = await readNode(created, "centurion/backend/auth/token-refresh");
    expect(backward.influencedBy?.map((edge) => edge.source.path)).toContain(
      "centurion/backend/auth/rotate-tokens.md",
    );

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain("plan_link");
    expect(journal).toContain("rotate-tokens");
  });

  it("refuses a self-loop without writing", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_link", {
      source: "centurion/backend/auth/session-store",
      target: "centurion/backend/auth/session-store",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("cannot influence itself");
    expect(
      documentOf(created, "Workspaces/centurion/backend/auth/session-store.md").frontmatter.revision,
    ).toBe(4);
  });

  it("refuses leaves from different projects", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_link", {
      source: "centurion/backend/auth/session-store",
      target: "helios/core/cache",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("different projects");
    expect(
      documentOf(created, "Workspaces/centurion/backend/auth/session-store.md").frontmatter
        .influences,
    ).toHaveLength(1);
  });

  it("refuses a non-leaf end", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_link", {
      source: "centurion/backend/auth",
      target: "centurion/backend/auth/token-refresh",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not a leaf");
  });

  it("updates status and impact, then refuses an illegal transition", async () => {
    const created = workspace();
    const source = await freshLeaf(created, "rotate-tokens");
    await call(created, "plan_link", { source, target: "centurion/backend/auth/token-refresh" });

    const watching = await call(created, "plan_link", {
      source,
      target: "centurion/backend/auth/token-refresh",
      status: "watching",
      impact: "Now only an assumption",
    });
    expectOk(watching);
    expect((watching.structuredContent as { action: string }).action).toBe("updated");

    const resolved = await call(created, "plan_link", {
      source,
      target: "centurion/backend/auth/token-refresh",
      status: "resolved",
    });
    expectOk(resolved);

    const illegal = await call(created, "plan_link", {
      source,
      target: "centurion/backend/auth/token-refresh",
      status: "watching",
    });
    expect(illegal.isError).toBe(true);
    expect(illegal.text).toContain("cannot go resolved → watching");

    const written = documentOf(created, "Workspaces/centurion/backend/auth/rotate-tokens.md");
    const edge = (written.frontmatter.influences as Array<Record<string, unknown>>)[0];
    expect(edge.status).toBe("resolved");
    expect(edge.impact).toBe("Now only an assumption");
  });

  it("removes the edge and treats a second removal as a no-op", async () => {
    const created = workspace();
    const source = await freshLeaf(created, "rotate-tokens");
    await call(created, "plan_link", { source, target: "centurion/backend/auth/token-refresh" });

    const removed = await call(created, "plan_link", {
      source,
      target: "centurion/backend/auth/token-refresh",
      remove: true,
    });
    expectOk(removed);
    expect(removed.structuredContent).toMatchObject({ action: "removed", removed: true });
    expect(
      documentOf(created, "Workspaces/centurion/backend/auth/rotate-tokens.md").frontmatter
        .influences,
    ).toEqual([]);

    const again = await call(created, "plan_link", {
      source,
      target: "centurion/backend/auth/token-refresh",
      remove: true,
    });
    expectOk(again);
    expect(again.structuredContent).toMatchObject({ action: "unchanged", removed: false });
  });

  it("still reports a cycle when the new edge closes it", async () => {
    const created = workspace();
    const source = await freshLeaf(created, "rotate-tokens");
    // session-store → token-refresh exists in the fixture; the two new edges
    // close the loop rotate-tokens → session-store → token-refresh → rotate-tokens.
    const forward = await call(created, "plan_link", {
      source,
      target: "centurion/backend/auth/session-store",
    });
    expectOk(forward);
    const closing = await call(created, "plan_link", {
      source: "centurion/backend/auth/token-refresh",
      target: source,
      accept_external: true,
    });
    expectOk(closing);

    const context = await readNode(created, source);
    expect(context.beeCycle).toEqual([
      "centurion/backend/auth/rotate-tokens.md",
      "centurion/backend/auth/session-store.md",
      "centurion/backend/auth/token-refresh.md",
      "centurion/backend/auth/rotate-tokens.md",
    ]);
  });
});
