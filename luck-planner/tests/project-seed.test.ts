import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SEED_ACTOR,
  normalizeProjectKey,
  seedProjectTree,
} from "../server/project-seed";
import { LuckPlannerStore } from "../server/store";

/**
 * Project seeding (`__doc.md` §10.11 items 2/3).
 *
 * The hooks run while Paseo creates a worktree, a workspace or an agent, so
 * the two properties that matter are: the skeleton appears for a project that
 * has no tree, and the call is *idempotent and never throws* — a second agent
 * in the same workspace, or a project an agent already bootstrapped, must
 * leave the tree exactly as it is.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

function openStore(): LuckPlannerStore {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-seed-"));
  dirs.push(dir);
  const store = new LuckPlannerStore({ dbPath: path.join(dir, "luck-planner.db") });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("normalizeProjectKey", () => {
  it("trims and drops trailing separators", () => {
    expect(normalizeProjectKey("  /projects/demo/  ")).toBe("/projects/demo");
    expect(normalizeProjectKey("/projects/demo")).toBe("/projects/demo");
    expect(normalizeProjectKey("C:\\work\\demo\\")).toBe("C:\\work\\demo");
  });

  it("keeps the filesystem root usable", () => {
    expect(normalizeProjectKey("/")).toBe("/");
  });

  it("rejects blank input instead of seeding an empty key", () => {
    expect(normalizeProjectKey("")).toBeNull();
    expect(normalizeProjectKey("   ")).toBeNull();
    expect(normalizeProjectKey(undefined)).toBeNull();
    expect(normalizeProjectKey(null)).toBeNull();
  });
});

describe("seedProjectTree", () => {
  it("creates root → trunk → 'General' for an empty project", () => {
    const store = openStore();
    const result = seedProjectTree(store, { projectKey: "/projects/demo" });
    expect(result.created).toBe(true);
    expect(result.projectKey).toBe("/projects/demo");

    const roots = store.listChildren("/projects/demo", null);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe("root");
    const trunks = store.listChildren("/projects/demo", roots[0]!.id);
    expect(trunks.map((node) => node.name)).toEqual(["Trunk"]);
    const branches = store.listChildren("/projects/demo", trunks[0]!.id);
    expect(branches.map((node) => node.name)).toEqual(["General"]);
  });

  it("records the seeding in the audit trail under its own actor", () => {
    const store = openStore();
    const result = seedProjectTree(store, { projectKey: "/projects/demo" });
    expect(result.created).toBe(true);
    const root = store.listChildren("/projects/demo", null)[0]!;
    const history = store.listHistory("/projects/demo", root.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe("create");
    expect(history[0]?.actor).toBe(SEED_ACTOR);
  });

  it("is idempotent: a second call leaves the tree alone", () => {
    const store = openStore();
    seedProjectTree(store, { projectKey: "/projects/demo" });
    const before = store.stats("/projects/demo");
    const second = seedProjectTree(store, { projectKey: "/projects/demo" });
    expect(second.created).toBe(false);
    expect(second.why).toContain("already has a tree");
    expect(store.stats("/projects/demo")).toEqual(before);
  });

  it("never throws when the store rejects the write", () => {
    const store = openStore();
    // A tree the plugin did not create: the store's bootstrap path refuses.
    store.createNode({
      projectKey: "/projects/demo",
      parentId: null,
      kind: "root",
      name: "Hand-written root",
      actor: "user",
    });
    const result = seedProjectTree(store, { projectKey: "/projects/demo" });
    expect(result.created).toBe(false);
    expect(result.why).toContain("already has a tree");
  });

  it("normalises the key so a trailing slash cannot seed a second tree", () => {
    const store = openStore();
    seedProjectTree(store, { projectKey: "/projects/demo" });
    const result = seedProjectTree(store, { projectKey: "/projects/demo/" });
    expect(result.created).toBe(false);
    expect(result.projectKey).toBe("/projects/demo");
  });

  it("ignores a payload without a project key", () => {
    const store = openStore();
    const result = seedProjectTree(store, { projectKey: "  " });
    expect(result.created).toBe(false);
    expect(result.projectKey).toBe("");
    expect(result.why).toContain("no project key");
  });

  it("keeps the documented actor override", () => {
    const store = openStore();
    seedProjectTree(store, { projectKey: "/projects/demo", actor: "agent:planner" });
    const root = store.listChildren("/projects/demo", null)[0]!;
    expect(store.listHistory("/projects/demo", root.id)[0]?.actor).toBe("agent:planner");
  });
});
