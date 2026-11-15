import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchMcpTool } from "../server/mcp-tools";
import {
  agentWorkspaceKey,
  resolveProjectKey,
  workspaceProjectKey,
} from "../server/project-key";
import { LuckPlannerStore } from "../server/store";

/**
 * 0.52.3 acceptance: a tool call cannot land in a tree the dashboard does not
 * read.
 *
 * The defect this suite exists for was observed on a real workspace: an agent
 * wrote `projectKey: "centurion"` while the panel and dashboard address
 * `/DISK1/projects/centurion`, so an entire plan (and an approved goal) went
 * into a second, invisible project. `server/project-key.ts` derives the
 * session's key from the daemon's own files and resolves a relative spelling
 * onto it.
 */

const P = "/projects/centurion";
const OTHER = "/projects/other";

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-project-key-"));
  dirs.push(dir);
  return dir;
}

function openStore(): LuckPlannerStore {
  const store = new LuckPlannerStore({
    dbPath: path.join(tempDir(), "luck-planner.db"),
  });
  stores.push(store);
  return store;
}

/** A minimal daemon home: one agent record and two workspaces. */
function fakeHome(): string {
  const home = tempDir();
  mkdirSync(path.join(home, "projects"), { recursive: true });
  mkdirSync(path.join(home, "agents", "projects-centurion"), { recursive: true });
  writeFileSync(
    path.join(home, "projects", "workspaces.json"),
    JSON.stringify([
      {
        workspaceId: "wks_main",
        cwd: P,
        worktreeRoot: P,
        kind: "local_checkout",
      },
      {
        // A Paseo-owned worktree: the panel keys it by the worktree root, so
        // that is what a session there must write to.
        workspaceId: "wks_tree",
        cwd: "/projects/centurion/src",
        worktreeRoot: "/projects/centurion/.worktrees/fix-search",
        kind: "paseo_worktree",
      },
    ]),
    "utf-8",
  );
  writeFileSync(
    path.join(home, "agents", "projects-centurion", "agent-1.json"),
    JSON.stringify({
      id: "agent-1",
      cwd: P,
      workspaceId: "wks_main",
      config: { mcpServers: {} },
    }),
    "utf-8",
  );
  writeFileSync(
    path.join(home, "agents", "projects-centurion", "agent-tree.json"),
    JSON.stringify({ id: "agent-tree", cwd: "/projects/centurion/src", workspaceId: "wks_tree" }),
    "utf-8",
  );
  return home;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("resolveProjectKey", () => {
  it("scopes a call that omits projectKey to the session key", () => {
    expect(resolveProjectKey(undefined, P)).toEqual({ projectKey: P, note: null });
    expect(resolveProjectKey("", P)).toEqual({ projectKey: P, note: null });
    expect(resolveProjectKey("   ", P)).toEqual({ projectKey: P, note: null });
  });

  it("corrects a relative tail of the session key, and says so", () => {
    const resolved = resolveProjectKey("centurion", P);
    expect(resolved.projectKey).toBe(P);
    expect(resolved.note).toContain("'centurion'");
    expect(resolved.note).toContain(`'${P}'`);
  });

  it("corrects the same directory spelled differently", () => {
    expect(resolveProjectKey(`${P}/`, P)).toEqual({ projectKey: P, note: null });
    expect(resolveProjectKey("/projects/./centurion", P)).toMatchObject({
      projectKey: P,
    });
    expect(resolveProjectKey("/projects/centurion/src/..", P)).toMatchObject({
      projectKey: P,
    });
  });

  it("leaves another absolute project alone (explicit cross-project work)", () => {
    expect(resolveProjectKey(OTHER, P)).toEqual({
      projectKey: OTHER,
      note: null,
    });
  });

  it("does not resolve a tail that is not this workspace", () => {
    expect(resolveProjectKey("other", P)).toEqual({
      projectKey: "other",
      note: null,
    });
  });

  it("returns an empty key when neither a key nor a session key exists", () => {
    // The tool's own validation refuses it (the pre-0.52.3 contract); the
    // resolver never invents a project to write to.
    expect(resolveProjectKey(undefined, null)).toEqual({
      projectKey: "",
      note: null,
    });
  });
});

describe("workspace key from the daemon's files", () => {
  it("reads the workspace registry, preferring the worktree root", () => {
    const home = fakeHome();
    expect(workspaceProjectKey("wks_main", home)).toBe(P);
    expect(workspaceProjectKey("wks_tree", home)).toBe(
      "/projects/centurion/.worktrees/fix-search",
    );
    expect(workspaceProjectKey("wks_unknown", home)).toBeNull();
  });

  it("answers null for a home without a registry", () => {
    expect(workspaceProjectKey("wks_main", tempDir())).toBeNull();
    expect(workspaceProjectKey(null, tempDir())).toBeNull();
  });

  it("resolves an agent's workspace through its record", () => {
    const home = fakeHome();
    expect(agentWorkspaceKey("agent-1", home)).toBe(P);
    expect(agentWorkspaceKey("agent-tree", home)).toBe(
      "/projects/centurion/.worktrees/fix-search",
    );
    expect(agentWorkspaceKey("agent-missing", home)).toBeNull();
  });
});

describe("dispatch with a session project key", () => {
  function call(
    store: LuckPlannerStore,
    args: Record<string, unknown>,
  ): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
    return dispatchMcpTool("luck_tree_upsert_leaf", args, {
      store,
      defaultActor: "agent:coder",
      defaultProjectKey: P,
    });
  }

  it("writes an omitted projectKey into the session's project", () => {
    const store = openStore();
    const result = call(store, { name: "first fact" });
    expect(result.isError).toBeUndefined();
    // One answer, no correction note: nothing had to be resolved.
    expect(result.content).toHaveLength(1);
    expect(store.listChildren(P, null)).toHaveLength(1);
    expect(store.listChildren("centurion", null)).toHaveLength(0);
  });

  it("writes a relative projectKey into the session's project and reports it", () => {
    const store = openStore();
    const result = call(store, { projectKey: "centurion", name: "first fact" });
    expect(result.isError).toBeUndefined();
    expect(store.listChildren(P, null)).toHaveLength(1);
    // The invisible second tree that caused the bug must not be created.
    expect(store.listChildren("centurion", null)).toHaveLength(0);
    expect(result.content.at(-1)?.text).toMatch(
      /relative tail of this session's workspace key/,
    );
  });
});
