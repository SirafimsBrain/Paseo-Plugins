import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { PLAN_FIXTURE } from "./plan-fixtures";

const workspaces: TestWorkspace[] = [];

function leafDocument(options: {
  id: string;
  name: string;
  parent: string;
  status?: string;
  influences?: string[];
}): string {
  const lines = [
    "---",
    `id: ${options.id}`,
    "schema: 1",
    "kind: leaf",
    `name: ${options.name}`,
    `status: ${options.status ?? "ready"}`,
    "version: 1",
    "revision: 1",
    `parent: "${options.parent}"`,
    "children: []",
  ];
  if (options.influences && options.influences.length > 0) {
    lines.push("influences:");
    for (const target of options.influences) {
      lines.push(`  - target: "${target}"`);
      lines.push("    status: active");
      lines.push("    impact: test edge");
      lines.push("    version: 1");
      lines.push("    revision: 1");
    }
  } else {
    lines.push("influences: []");
  }
  lines.push("created: 2026-11-18T10:00:00Z", "updated: 2026-11-18T10:00:00Z", "---", "", "# " + options.name, "");
  return lines.join("\n");
}

function planWorkspace(extra: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace({
    ...PLAN_FIXTURE,
    "Workspaces/centurion/backend/auth/token-refresh.md": leafDocument({
      id: "77d1a3b0-4c2e-4f88-9b11-3a6f5e2c8d90",
      name: "Token refresh",
      parent: "[[Workspaces/centurion/backend/auth/auth|auth]]",
      influences: ["[[Workspaces/centurion/backend/auth/session-store|session-store]]"],
    }),
    ...extra,
  });
  workspaces.push(created);
  return created;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

async function read(vault: string, input: Record<string, unknown>) {
  return dispatchTool("plan_read", input, runtimeSettings(vault));
}

describe("plan_read overview", () => {
  it("lists projects with their root, trunks and counts", async () => {
    const created = planWorkspace();
    const outcome = await read(created.vault, {});
    expect(outcome.isError).toBeUndefined();

    const result = outcome.structuredContent as {
      planning_available: boolean;
      root: string;
      documents: number;
      projects: Array<{
        project: string;
        root: { path: string; name: string } | null;
        trunks: Array<{ path: string; children: number }>;
        counts: { byKind: Record<string, number>; leaves: number };
        openIncidents: Array<{ path: string }>;
        goals: Array<{ path: string }>;
      }>;
    };

    expect(result.planning_available).toBe(true);
    expect(result.root).toBe("Workspaces");
    const centurion = result.projects.find((project) => project.project === "centurion")!;
    expect(centurion.root?.path).toBe("centurion/centurion.md");
    expect(centurion.root?.name).toBe("Centurion");
    expect(centurion.trunks.map((trunk) => trunk.path)).toEqual(["centurion/backend/backend.md"]);
    expect(centurion.counts.byKind.branch).toBe(1);
    expect(centurion.counts.leaves).toBe(2);
    expect(centurion.openIncidents.map((incident) => incident.path)).toEqual([
      "centurion/_incidents/inc-7-session-loss.md",
    ]);
    expect(centurion.goals.map((goal) => goal.path)).toEqual([
      "centurion/_goals/session-persistence.md",
    ]);
  });

  it("does not treat `_index.md` or a snapshot as a project node", async () => {
    const created = planWorkspace({ "Workspaces/_index.md": "# Planning\n" });
    const outcome = await read(created.vault, {});
    const result = outcome.structuredContent as {
      projects: Array<{ project: string }>;
      documents: number;
      skipped: string[];
    };
    expect(result.projects.map((project) => project.project)).toEqual(["centurion"]);
    expect(result.skipped).toEqual(["Workspaces/_index.md"]);
  });
});

describe("plan_read node context", () => {
  it("accepts a folder path and reads the node file inside it", async () => {
    const created = planWorkspace();
    const outcome = await read(created.vault, { path: "centurion" });
    expect(outcome.isError).toBeUndefined();
    const result = outcome.structuredContent as { node: { name: string; kind: string } };
    expect(result.node).toMatchObject({ name: "Centurion", kind: "root" });
  });

  it("returns the path from the root and the children of a branch", async () => {
    const created = planWorkspace();
    const outcome = await read(created.vault, { path: "centurion/backend/auth/auth" });
    const result = outcome.structuredContent as {
      node: { path: string; name: string };
      ancestors: Array<{ path: string }>;
      children: Array<{ path: string }>;
      siblings: unknown[];
      parent: { path: string };
    };

    expect(result.node.path).toBe("centurion/backend/auth/auth.md");
    expect(result.ancestors.map((node) => node.path)).toEqual([
      "centurion/centurion.md",
      "centurion/backend/backend.md",
    ]);
    expect(result.children.map((node) => node.path)).toEqual([
      "centurion/backend/auth/session-store.md",
      "centurion/backend/auth/token-refresh.md",
    ]);
    expect(result.parent.path).toBe("centurion/backend/backend.md");
    expect(result.siblings).toEqual([]);
  });

  it("resolves influences, blocking incidents and the reverse direction", async () => {
    const created = planWorkspace();
    const outcome = await read(created.vault, { path: "centurion/backend/auth/session-store" });
    const result = outcome.structuredContent as {
      influences: Array<{ target: { path: string }; status: string; impact: string }>;
      influencedBy: Array<{ source: { path: string }; status: string }>;
      blockedBy: Array<{ incident: { path: string }; status: string; blocking: boolean }>;
      siblings: Array<{ path: string }>;
      growth: unknown;
      goal: unknown;
    };

    expect(result.influences).toHaveLength(1);
    expect(result.influences[0]).toMatchObject({
      target: { path: "centurion/backend/auth/token-refresh.md" },
      status: "active",
      impact: "A rotation change invalidates the refresh flow assumptions",
    });
    expect(result.influencedBy.map((entry) => entry.source.path)).toEqual([
      "centurion/backend/auth/token-refresh.md",
    ]);
    expect(result.blockedBy).toEqual([
      {
        incident: expect.objectContaining({ path: "centurion/_incidents/inc-7-session-loss.md" }),
        status: "investigating",
        blocking: true,
      },
    ]);
    expect(result.siblings.map((node) => node.path)).toEqual([
      "centurion/backend/auth/token-refresh.md",
    ]);
    expect(result.growth).toBeNull();
    expect(result.goal).toBeNull();
  });

  it("reports a resolved influence that is not yet in the tree as unresolved", async () => {
    const created = planWorkspace();
    const outcome = await read(created.vault, { path: "centurion/backend/auth/token-refresh" });
    const result = outcome.structuredContent as { unresolved: string[] };
    expect(result.unresolved).toEqual([]);
  });

  it("closes an influence loop as beeCycle A→B→C→A", async () => {
    const created = planWorkspace({
      "Workspaces/loop/a.md": leafDocument({
        id: "a",
        name: "A",
        parent: "[[Workspaces/loop/loop|loop]]",
        influences: ["[[Workspaces/loop/b|b]]"],
      }),
      "Workspaces/loop/b.md": leafDocument({
        id: "b",
        name: "B",
        parent: "[[Workspaces/loop/loop|loop]]",
        influences: ["[[Workspaces/loop/c|c]]"],
      }),
      "Workspaces/loop/c.md": leafDocument({
        id: "c",
        name: "C",
        parent: "[[Workspaces/loop/loop|loop]]",
        influences: ["[[Workspaces/loop/a|a]]"],
      }),
    });

    const outcome = await read(created.vault, { path: "loop/a" });
    const result = outcome.structuredContent as { beeCycle: string[] | null };
    expect(result.beeCycle).toEqual(["loop/a.md", "loop/b.md", "loop/c.md", "loop/a.md"]);

    // The fixture pair genuinely loops: session-store → token-refresh → session-store.
    const pair = await read(created.vault, { path: "centurion/backend/auth/session-store" });
    expect((pair.structuredContent as { beeCycle: string[] | null }).beeCycle).toEqual([
      "centurion/backend/auth/session-store.md",
      "centurion/backend/auth/token-refresh.md",
      "centurion/backend/auth/session-store.md",
    ]);

    const noCycle = await read(created.vault, { path: "centurion/backend/auth/auth" });
    expect((noCycle.structuredContent as { beeCycle: string[] | null }).beeCycle).toBeNull();
  });
});

describe("plan_read refusals", () => {
  it("refuses a path outside the planning root or the vault", async () => {
    const created = planWorkspace();
    for (const value of ["../outside.md", "/etc/passwd", ".obsidian/app.json"]) {
      const outcome = await read(created.vault, { path: value });
      expect(outcome.isError, value).toBe(true);
    }
  });

  it("refuses history and archive, pointing at plan_history", async () => {
    const created = planWorkspace();
    for (const value of [
      "centurion/backend/auth/__history/session-store.v1.r3.md",
      "_archive/old/old.md",
    ]) {
      const outcome = await read(created.vault, { path: value });
      expect(outcome.isError, value).toBe(true);
      expect(outcome.text, value).toContain("plan_history");
    }
  });

  it("suggests real nodes for an unknown path", async () => {
    const created = planWorkspace();
    const outcome = await read(created.vault, { path: "centurion/backend/auth/session" });
    expect(outcome.isError).toBe(true);
    const result = outcome.structuredContent as {
      suggestions: Array<{ path: string }>;
    };
    expect(result.suggestions.map((node) => node.path)).toContain(
      "centurion/backend/auth/session-store.md",
    );
  });

  it("reports planning as unavailable instead of reading an empty root", async () => {
    const created = makeWorkspace({ "A.md": "# A\n" });
    workspaces.push(created);
    const outcome = await read(created.vault, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.structuredContent).toMatchObject({
      planning_available: false,
      reason: "missing",
    });
  });
});
