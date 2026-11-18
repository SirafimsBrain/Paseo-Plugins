import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { parsePlanDocument } from "../server/plan/frontmatter";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { planFiles, SECOND_PROJECT } from "./plan-fixtures";

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

interface BlockedByRow {
  incident: { path: string };
  status: string | null;
  blocking: boolean;
}

async function blockedBy(created: TestWorkspace, nodePath: string): Promise<BlockedByRow[]> {
  const outcome = await call(created, "plan_read", { path: nodePath });
  expectOk(outcome);
  return (outcome.structuredContent as { blockedBy?: BlockedByRow[] }).blockedBy ?? [];
}

const INCIDENT = "centurion/_incidents/inc-8-token-leak";

describe("plan_incident", () => {
  it("creates the incident and links it from both sides", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_incident", {
      path: INCIDENT,
      name: "INC-8 token leak",
      description: "Refresh tokens appear in the debug log.",
      severity: "critical",
      blocks: ["centurion/backend/auth/session-store"],
      accept_external: true,
      actor: "codex",
    });
    expectOk(outcome);
    const result = outcome.structuredContent as {
      ok: boolean;
      action: string;
      status: string;
      severity: string;
      blocks: Array<{ path: string }>;
      attached: Array<{ path: string }>;
    };
    expect(result).toMatchObject({ ok: true, action: "created", status: "open", severity: "critical" });
    expect(result.blocks.map((row) => row.path)).toEqual([
      "centurion/backend/auth/session-store.md",
    ]);
    expect(result.attached.map((row) => row.path)).toEqual([
      "centurion/backend/auth/session-store.md",
    ]);

    const incident = documentOf(created, "Workspaces/centurion/_incidents/inc-8-token-leak.md");
    expect(incident.frontmatter).toMatchObject({
      kind: "incident",
      severity: "critical",
      status: "open",
      revision: 1,
      blocks: ["[[Workspaces/centurion/backend/auth/session-store|session-store]]"],
    });
    expect(incident.body).toContain("## Заметки");

    const leaf = documentOf(created, "Workspaces/centurion/backend/auth/session-store.md");
    expect(leaf.frontmatter.revision).toBe(5);
    expect(leaf.frontmatter.blocked_by).toContain(
      "[[Workspaces/centurion/_incidents/inc-8-token-leak|inc-8-token-leak]]",
    );
    expect(
      fs.existsSync(
        path.join(
          created.vault,
          "Workspaces/centurion/backend/auth/__history/session-store.v2.r4.md",
        ),
      ),
    ).toBe(true);

    const rows = await blockedBy(created, "centurion/backend/auth/session-store");
    const row = rows.find((entry) => entry.incident.path === `${INCIDENT}.md`);
    expect(row).toMatchObject({ status: "open", blocking: true });

    const forward = await call(created, "plan_read", { path: INCIDENT });
    const blocks = (forward.structuredContent as { blocks?: Array<{ target: { path: string } }> })
      .blocks;
    expect(blocks?.map((entry) => entry.target.path)).toContain(
      "centurion/backend/auth/session-store.md",
    );

    const journal = fs.readFileSync(
      path.join(created.vault, "Workspaces/centurion/_journal.md"),
      "utf-8",
    );
    expect(journal).toContain("plan_incident");
  });

  it("refuses a leaf from another project and writes nothing", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_incident", {
      path: INCIDENT,
      name: "INC-8 token leak",
      blocks: ["helios/core/cache"],
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("another project");
    expect(
      fs.existsSync(path.join(created.vault, "Workspaces/centurion/_incidents/inc-8-token-leak.md")),
    ).toBe(false);
  });

  it("refuses an incident outside _incidents", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_incident", {
      path: "centurion/token-leak",
      name: "Token leak",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("_incidents");
  });

  it("attaches and detaches leaves on update", async () => {
    const created = workspace();
    await call(created, "plan_incident", {
      path: INCIDENT,
      name: "INC-8 token leak",
      blocks: ["centurion/backend/auth/session-store"],
      accept_external: true,
    });

    // A leaf the tools created: it needs no `accept_external`.
    const leaf = await call(created, "plan_create_node", {
      path: "centurion/backend/auth/rotate-tokens",
      kind: "leaf",
      name: "Rotate tokens",
    });
    expectOk(leaf);

    const moved = await call(created, "plan_incident", {
      path: INCIDENT,
      blocks: ["centurion/backend/auth/rotate-tokens"],
      unblock: ["centurion/backend/auth/session-store"],
      accept_external: true,
      notes: "Rotating tokens fixes the leak; the store is no longer affected.",
    });
    expectOk(moved);
    const result = moved.structuredContent as {
      attached: Array<{ path: string }>;
      detached: Array<{ path: string }>;
      blocks: Array<{ path: string }>;
    };
    expect(result.attached.map((row) => row.path)).toEqual([
      "centurion/backend/auth/rotate-tokens.md",
    ]);
    expect(result.detached.map((row) => row.path)).toEqual([
      "centurion/backend/auth/session-store.md",
    ]);
    expect(result.blocks.map((row) => row.path)).toEqual([
      "centurion/backend/auth/rotate-tokens.md",
    ]);

    const incident = documentOf(created, "Workspaces/centurion/_incidents/inc-8-token-leak.md");
    expect(incident.frontmatter.blocks).toEqual([
      "[[Workspaces/centurion/backend/auth/rotate-tokens|rotate-tokens]]",
    ]);
    expect(incident.body).toContain("Rotating tokens fixes the leak");

    const sessionStore = documentOf(
      created,
      "Workspaces/centurion/backend/auth/session-store.md",
    );
    expect(
      (sessionStore.frontmatter.blocked_by as string[]).some((entry) =>
        entry.includes("inc-8-token-leak"),
      ),
    ).toBe(false);

    const rotated = documentOf(created, "Workspaces/centurion/backend/auth/rotate-tokens.md");
    expect(rotated.frontmatter.blocked_by).toEqual([
      "[[Workspaces/centurion/_incidents/inc-8-token-leak|inc-8-token-leak]]",
    ]);
  });

  it("leaves the status to plan_set_status", async () => {
    const created = workspace();
    await call(created, "plan_incident", { path: INCIDENT, name: "INC-8 token leak" });
    const outcome = await call(created, "plan_incident", { path: INCIDENT, status: "resolved" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("plan_set_status");
    expect(
      documentOf(created, "Workspaces/centurion/_incidents/inc-8-token-leak.md").frontmatter.status,
    ).toBe("open");
  });

  it("stops blocking a leaf once the incident is resolved", async () => {
    const created = workspace();
    await call(created, "plan_incident", {
      path: INCIDENT,
      name: "INC-8 token leak",
      blocks: ["centurion/backend/auth/session-store"],
      accept_external: true,
    });
    const resolved = await call(created, "plan_set_status", {
      path: INCIDENT,
      status: "resolved",
    });
    expectOk(resolved);

    const rows = await blockedBy(created, "centurion/backend/auth/session-store");
    const row = rows.find((entry) => entry.incident.path === `${INCIDENT}.md`);
    expect(row).toMatchObject({ status: "resolved", blocking: false });
  });
});
