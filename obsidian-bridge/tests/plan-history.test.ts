import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
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

async function history(created: TestWorkspace, input: Record<string, unknown>) {
  return dispatchTool("plan_history", input, runtimeSettings(created.vault));
}

describe("plan_history", () => {
  it("marks snapshots taken under another kind as not restorable", async () => {
    const created = workspace();
    const changed = await dispatchTool(
      "plan_update_node",
      { path: "centurion/backend/auth/session-store", kind: "subbranch", accept_external: true },
      runtimeSettings(created.vault),
    );
    expect(changed.isError).toBeUndefined();

    const outcome = await history(created, { path: "centurion/backend/auth/session-store" });
    expect(outcome.isError).toBeUndefined();
    const result = outcome.structuredContent as {
      kind: string;
      restorable_count: number;
      snapshots: Array<{ kind: string | null; restorable: boolean; restore_blocked: string | null }>;
    };
    expect(result.kind).toBe("subbranch");
    const beforeKindChange = result.snapshots.find((entry) => entry.kind === "leaf");
    expect(beforeKindChange).toMatchObject({ restorable: false });
    expect(beforeKindChange?.restore_blocked).toContain("kind change");
    expect(result.restorable_count).toBeLessThan(result.snapshots.length);
  });

  it("lists the snapshots a write produced, oldest first", async () => {
    const created = workspace();
    await dispatchTool(
      "plan_create_node",
      { path: "centurion/backend/auth/rotate-tokens", kind: "leaf", name: "Rotate tokens" },
      runtimeSettings(created.vault),
    );
    await dispatchTool(
      "plan_update_node",
      {
        path: "centurion/backend/auth/rotate-tokens",
        description: "first edit",
      },
      runtimeSettings(created.vault),
    );
    await dispatchTool(
      "plan_update_node",
      {
        path: "centurion/backend/auth/rotate-tokens",
        description: "second edit",
      },
      runtimeSettings(created.vault),
    );

    const outcome = await history(created, { path: "centurion/backend/auth/rotate-tokens" });
    expect(outcome.isError).toBeUndefined();
    const result = outcome.structuredContent as {
      count: number;
      snapshots: Array<{ version: number; revision: number; reason: string; path: string }>;
    };
    expect(result.count).toBe(2);
    expect(result.snapshots.map((entry) => `${entry.version}.${entry.revision}`)).toEqual([
      "1.1",
      "1.2",
    ]);
    expect(result.snapshots.every((entry) => entry.reason === "content_update")).toBe(true);
    expect(result.snapshots[0].path).toBe(
      "Workspaces/centurion/backend/auth/__history/rotate-tokens.v1.r1.md",
    );
  });

  it("reads one snapshot by version and revision", async () => {
    const created = workspace();
    const outcome = await history(created, {
      path: "centurion/backend/auth/session-store",
      version: 1,
      revision: 3,
    });
    expect(outcome.isError).toBeUndefined();
    const result = outcome.structuredContent as {
      snapshot: { path: string; frontmatter: Record<string, unknown> };
      body: string;
    };
    expect(result.snapshot.path).toBe(
      "Workspaces/centurion/backend/auth/__history/session-store.v1.r3.md",
    );
    expect(result.snapshot.frontmatter).toMatchObject({
      is_snapshot: true,
      snapshot_reason: "status_change",
      status: "ready",
    });
    expect(result.body).toContain("# Session store");
  });

  it("reports a missing snapshot with the ones that exist", async () => {
    const created = workspace();
    const outcome = await history(created, {
      path: "centurion/backend/auth/session-store",
      version: 9,
      revision: 9,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("No snapshot");
    const result = outcome.structuredContent as { snapshots: Array<{ revision: number }> };
    expect(result.snapshots.length).toBeGreaterThan(0);
  });

  it("says so when there is no history yet", async () => {
    const created = workspace();
    const outcome = await history(created, { path: "centurion/backend/auth/token-refresh" });
    const result = outcome.structuredContent as { count: number; note: string | null };
    expect(result.count).toBe(0);
    expect(result.note).toContain("No snapshots yet");
  });

  it("accepts the folder path of a branching node", async () => {
    const created = workspace();
    await dispatchTool(
      "plan_create_node",
      { path: "centurion/backend/auth/flows", kind: "subbranch", name: "Flows" },
      runtimeSettings(created.vault),
    );
    await dispatchTool(
      "plan_update_node",
      { path: "centurion/backend/auth/flows", description: "first edit" },
      runtimeSettings(created.vault),
    );

    const outcome = await history(created, { path: "centurion/backend/auth/flows" });
    expect(outcome.isError).toBeUndefined();
    const result = outcome.structuredContent as {
      count: number;
      snapshots: Array<{ path: string; revision: number }>;
    };
    expect(result.count).toBe(1);
    expect(result.snapshots[0].path).toBe(
      "Workspaces/centurion/backend/auth/flows/__history/flows.v1.r1.md",
    );
  });

  it("refuses a node that does not exist instead of answering zero", async () => {
    const created = workspace();
    const outcome = await history(created, { path: "centurion/backend/auth/not-a-node" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not a plan node");
  });

  it("refuses a snapshot or archived path as the subject", async () => {
    const created = workspace();
    for (const value of [
      "centurion/backend/auth/__history/session-store.v1.r3.md",
      "_archive/old/old.md",
    ]) {
      const outcome = await history(created, { path: value });
      expect(outcome.isError, value).toBe(true);
    }
  });

  it("never writes, so readOnly does not block it", async () => {
    const created = workspace();
    const outcome = await dispatchTool(
      "plan_history",
      { path: "centurion/backend/auth/session-store" },
      runtimeSettings(created.vault, { readOnly: true }),
    );
    expect(outcome.isError).toBeUndefined();
    expect((outcome.structuredContent as { count: number }).count).toBe(1);
  });
});
