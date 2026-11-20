import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { indexPathFor } from "../server/paths";
import { parsePlanDocument } from "../server/plan/frontmatter";
import { scanVault } from "../server/scan";
import { BridgeStore } from "../server/store";
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

/** A full scan, the same pass `obsidian_index` runs for the plugin. */
function indexVault(created: TestWorkspace) {
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  try {
    return scanVault({
      root: created.vault,
      store,
      settings: runtimeSettings(created.vault),
      force: true,
    });
  } finally {
    store.close();
  }
}

describe("plan_archive_node", () => {
  it("moves a subtree into _archive, marks it and unlists it", async () => {
    const created = workspace();
    // Index the live tree first: after the archive, a scan has rows to drop.
    indexVault(created);
    const outcome = await call(created, "plan_archive_node", {
      path: "centurion/backend/auth",
      accept_external: true,
      actor: "codex",
    });
    expectOk(outcome);
    const result = outcome.structuredContent as {
      action: string;
      archive_path: string;
      vault_path: string;
      nodes: number;
      op_id: string;
    };
    expect(result).toMatchObject({
      action: "archived",
      archive_path: "centurion/_archive/auth",
      vault_path: "Workspaces/centurion/_archive/auth/auth.md",
    });
    expect(result.nodes).toBeGreaterThanOrEqual(3);

    expect(
      fs.existsSync(path.join(created.vault, "Workspaces/centurion/_archive/auth/auth.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(created.vault, "Workspaces/centurion/backend/auth"))).toBe(false);

    const archived = documentOf(created, "Workspaces/centurion/_archive/auth/auth.md");
    expect(archived.frontmatter.archived).toBeTruthy();
    // Internal links follow the subtree into the archive instead of pointing
    // back at live paths that may later disappear.
    expect(archived.frontmatter.children).toEqual([
      "[[Workspaces/centurion/_archive/auth/session-store|session-store]]",
      "[[Workspaces/centurion/_archive/auth/token-refresh|token-refresh]]",
    ]);
    const archivedLeaf = documentOf(
      created,
      "Workspaces/centurion/_archive/auth/session-store.md",
    );
    const edge = (archivedLeaf.frontmatter.influences as Array<Record<string, unknown>>)[0];
    expect(edge.target).toBe(
      "[[Workspaces/centurion/_archive/auth/token-refresh|token-refresh]]",
    );
    expect(archivedLeaf.frontmatter.parent).toBe(
      "[[Workspaces/centurion/_archive/auth/auth|auth]]",
    );

    const backend = documentOf(created, "Workspaces/centurion/backend/backend.md");
    expect(backend.frontmatter.children).toEqual([]);

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain(`op:start ${result.op_id}`);
    expect(journal).toContain(`op:done ${result.op_id}`);

    // Archived files leave the plan: neither the tree nor search reaches them.
    const read = await call(created, "plan_read", { path: "centurion/backend/auth" });
    expect(read.isError).toBe(true);

    // The rescan drops the three rows that moved into `_archive`.
    const rescan = indexVault(created);
    expect(rescan.removed).toBe(3);
    // Four live documents remain, plus the `_journal.md` line the archive wrote.
    expect(rescan.notes).toBe(5);

    // Text that only the archived leaves carry must find nothing.
    const archivedOnly = await call(created, "plan_search", { query: "SHA-256" });
    expectOk(archivedOnly);
    expect((archivedOnly.structuredContent as { hits?: unknown[] }).hits ?? []).toEqual([]);

    // A live query still works and never answers with an archived path.
    const search = await call(created, "plan_search", { query: "Centurion" });
    expectOk(search);
    const hits = (search.structuredContent as { hits?: Array<{ path: string }> }).hits ?? [];
    expect(hits.length, JSON.stringify(search.structuredContent)).toBeGreaterThan(0);
    expect(hits.every((hit) => !hit.path.includes("_archive") && !hit.path.includes("__history"))).toBe(
      true,
    );
  });

  it("keeps the history of the archived subtree", async () => {
    const created = workspace();
    expectOk(
      await call(created, "plan_archive_node", {
        path: "centurion/backend/auth",
        accept_external: true,
      }),
    );
    expect(
      fs.existsSync(
        path.join(
          created.vault,
          "Workspaces/centurion/_archive/auth/__history/session-store.v1.r3.md",
        ),
      ),
    ).toBe(true);
  });

  it("refuses a node whose kind and folder disagree instead of archiving the parent", async () => {
    const created = workspace();
    const relative = "Workspaces/centurion/backend/auth/token-refresh.md";
    const text = fs.readFileSync(path.join(created.vault, relative), "utf-8");
    fs.writeFileSync(
      path.join(created.vault, relative),
      text.replace("kind: leaf", "kind: subbranch"),
      "utf-8",
    );

    const outcome = await call(created, "plan_archive_node", {
      path: "centurion/backend/auth/token-refresh",
      accept_external: true,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("kind and path disagree");
    // The siblings and their history are untouched: nothing under `auth/` moved.
    expect(
      fs.existsSync(path.join(created.vault, "Workspaces/centurion/backend/auth/session-store.md")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(created.vault, "Workspaces/centurion/backend/auth/__history/session-store.v1.r3.md"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(created.vault, "Workspaces/centurion/_archive"))).toBe(false);
  });

  it("refuses the project root and a second archive of the same name", async () => {
    const created = workspace();
    const root = await call(created, "plan_archive_node", { path: "centurion" });
    expect(root.isError).toBe(true);
    expect(root.text).toContain("project root");

    expectOk(
      await call(created, "plan_archive_node", {
        path: "centurion/backend/auth",
        accept_external: true,
      }),
    );

    const again = await call(created, "plan_archive_node", {
      path: "centurion/backend/backend",
      accept_external: true,
    });
    // `backend` archives fine; the taken `_archive/auth` is what must not collide.
    expectOk(again);
    expect(
      fs.existsSync(path.join(created.vault, "Workspaces/centurion/_archive/backend/backend.md")),
    ).toBe(true);
  });
});
