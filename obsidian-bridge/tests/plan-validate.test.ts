import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { parsePlanDocument } from "../server/plan/frontmatter";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { planFiles } from "./plan-fixtures";

/*
 * `plan_validate` is the file model's only foreign key. Every test breaks one
 * invariant and checks that the report names it with the file to fix.
 */
const workspaces: TestWorkspace[] = [];

function workspace(extra: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace({ ...planFiles(extra), ...extra });
  workspaces.push(created);
  return created;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function expectOk(outcome: { isError?: boolean; text: string }) {
  if (outcome.isError) throw new Error(outcome.text);
}

async function call(
  created: TestWorkspace,
  name: string,
  input: Record<string, unknown> = {},
) {
  return dispatchTool(name, input, runtimeSettings(created.vault));
}

interface Report {
  valid: boolean;
  issue_count: number;
  issues: Array<{ kind: string; path?: string; message: string; data?: Record<string, unknown> }>;
  counts: { byKind: Record<string, number> };
}

async function report(created: TestWorkspace, input: Record<string, unknown> = {}): Promise<Report> {
  const outcome = await call(created, "plan_validate", input);
  expectOk(outcome);
  return outcome.structuredContent as Report;
}

function kinds(result: Report): string[] {
  return result.issues.map((issue) => issue.kind);
}

describe("plan_validate", () => {
  it("passes a tree the tools wrote themselves", async () => {
    const created = workspace();
    for (const [nodePath, kind, name] of [
      ["atlas", "root", "Atlas"],
      ["atlas/core", "trunk", "Core"],
      ["atlas/core/api", "branch", "API"],
      ["atlas/core/api/handler", "leaf", "Handler"],
    ] as const) {
      expectOk(await call(created, "plan_create_node", { path: nodePath, kind, name }));
    }

    const result = await report(created, { project: "atlas" });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.counts.byKind).toMatchObject({ root: 1, trunk: 1, branch: 1, leaf: 1 });
  });

  it("names a dangling link, an orphan and a file that is not a plan", async () => {
    const created = workspace({
      "Workspaces/centurion/backend/auth/ghost-leaf.md": [
        "---",
        "id: 11111111-2222-4333-8444-555555555555",
        "schema: 1",
        "kind: leaf",
        "name: Ghost",
        "status: draft",
        "version: 1",
        "revision: 1",
        "parent: null",
        'influences:',
        '  - target: "[[Workspaces/centurion/nowhere|nowhere]]"',
        "tags: [plan/leaf]",
        "---",
        "",
        "# Ghost",
        "",
        "## Заметки",
        "",
        "—",
        "",
      ].join("\n"),
      "Workspaces/centurion/notes/misc.md": "# Not a plan\n",
    });

    const result = await report(created);
    expect(result.valid).toBe(false);
    expect(kinds(result)).toContain("unresolved_link");
    expect(kinds(result)).toContain("orphan");
    expect(kinds(result)).toContain("not_a_plan");
    const unresolved = result.issues.find((issue) => issue.kind === "unresolved_link");
    expect(unresolved?.data).toMatchObject({ target: "[[Workspaces/centurion/nowhere|nowhere]]" });
  });

  it("reports a body that no longer matches its frontmatter", async () => {
    const text = planFiles()["Workspaces/centurion/backend/auth/token-refresh.md"].replace(
      "## Заметки",
      "## Заметки\n\nA hand edit that the frontmatter does not know about.",
    );
    const created = workspace({
      "Workspaces/centurion/backend/auth/token-refresh.md": text,
    });
    const result = await report(created, { project: "centurion" });
    expect(kinds(result)).toContain("body_divergence");
  });

  it("reports a kind whose path or tag disagrees with it", async () => {
    const text = planFiles()["Workspaces/centurion/backend/auth/token-refresh.md"]
      .replace("kind: leaf", "kind: subbranch")
      .replace("updated_by: user\n---", "updated_by: user\ntags: [plan/leaf]\n---");
    const created = workspace({
      "Workspaces/centurion/backend/auth/token-refresh.md": text,
    });
    const result = await report(created, { project: "centurion" });
    expect(kinds(result)).toContain("layout_mismatch");
    expect(kinds(result)).toContain("kind_tag_mismatch");
  });

  it("finds an operation that started and never finished", async () => {
    const created = workspace({
      "Workspaces/centurion/_journal.md": [
        "2026-11-18T10:00:00.000Z · op:start 0f8f7c1e-4d1f-4c55-9a5a-2b0e6d7c1234 · [[Workspaces/centurion/backend/auth/session-store|session-store]] · plan_move_node · pending · actor: codex",
        "",
      ].join("\n"),
    });
    const result = await report(created);
    const issue = result.issues.find((candidate) => candidate.kind === "unfinished_operation");
    expect(issue?.data).toMatchObject({ op_id: "0f8f7c1e-4d1f-4c55-9a5a-2b0e6d7c1234" });
  });

  it("reports a duplicated id", async () => {
    const original = planFiles()["Workspaces/centurion/backend/auth/token-refresh.md"];
    const created = workspace({
      "Workspaces/centurion/backend/auth/token-refresh-copy.md": original,
    });
    const result = await report(created);
    const issue = result.issues.find((candidate) => candidate.kind === "duplicate_id");
    expect(issue).toBeDefined();
    expect((issue?.data?.paths as string[]).length).toBe(2);
  });

  it("reports a cycle only once, with the loop it found", async () => {
    const created = workspace();
    const first = await call(created, "plan_link", {
      source: "centurion/backend/auth/session-store",
      target: "centurion/backend/auth/token-refresh",
      impact: "store writes tokens",
      accept_external: true,
    });
    expectOk(first);
    const second = await call(created, "plan_link", {
      source: "centurion/backend/auth/token-refresh",
      target: "centurion/backend/auth/session-store",
      impact: "refresh rotates the session row",
      accept_external: true,
    });
    expectOk(second);

    const result = await report(created);
    const cycles = result.issues.filter((issue) => issue.kind === "bee_cycle");
    expect(cycles.length).toBe(1);
    expect((cycles[0].data?.cycle as string[]).length).toBeGreaterThanOrEqual(2);
  });

  it("limits its answer without hiding the total", async () => {
    const created = workspace({
      "Workspaces/centurion/notes/one.md": "# not a plan\n",
      "Workspaces/centurion/notes/two.md": "# not a plan either\n",
    });
    const outcome = await call(created, "plan_validate", { limit: 1 });
    expectOk(outcome);
    const result = outcome.structuredContent as Report & {
      truncated: boolean;
      truncated_count: number;
      continuation: { call: { tool: string; arguments: Record<string, unknown> } } | null;
    };
    expect(result.issues.length).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.truncated_count).toBeGreaterThanOrEqual(1);
    expect(result.continuation?.call.tool).toBe("plan_validate");
    expect(result.continuation?.call.arguments.offset).toBe(1);
  });

  it("reads and never writes", async () => {
    const created = workspace();
    const before = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/backend/auth/session-store.md"),
    );
    await report(created);
    const after = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/backend/auth/session-store.md"),
    );
    expect(after).toEqual(before);
    const node = parsePlanDocument(after.toString("utf-8"));
    expect("document" in node && node.document.frontmatter.revision).toBe(4);
  });
});
