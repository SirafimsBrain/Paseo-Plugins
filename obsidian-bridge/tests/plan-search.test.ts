import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { indexPathFor } from "../server/paths";
import { scanVault } from "../server/scan";
import { BridgeStore } from "../server/store";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { PLAN_FIXTURE } from "./plan-fixtures";

const workspaces: TestWorkspace[] = [];

function searchableWorkspace(extra: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace({
    ...PLAN_FIXTURE,
    // Outside the planning root, same words: must never be returned.
    "Notes/refresh-tokens.md": "# Refresh tokens\n\nRefresh tokens rotated in the auth service.\n",
    // Inside the root but not a plan: indexed, then skipped by the reader.
    "Workspaces/centurion/scratch.md":
      "# Scratch\n\nRefresh tokens notes without frontmatter.\n",
    // Archived and history: excluded from the index in the first place.
    "Workspaces/_archive/old/session.md":
      "---\nkind: leaf\nname: Old session notes\nstatus: done\n---\n\nRefresh tokens archived.\n",
    ...extra,
  });
  workspaces.push(created);
  return created;
}

function index(created: TestWorkspace) {
  const settings = runtimeSettings(created.vault);
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  scanVault({ root: created.vault, store, settings, force: true });
  store.close();
  return settings;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

type Hit = {
  path: string;
  kind: string;
  status: string | null;
  project: string | null;
  name: string;
};

async function search(
  settings: ReturnType<typeof runtimeSettings>,
  input: Record<string, unknown>,
) {
  return dispatchTool("plan_search", input, settings);
}

function hitsOf(outcome: { structuredContent?: unknown }): Hit[] {
  return (outcome.structuredContent as { hits: Hit[] }).hits;
}

describe("plan_search", () => {
  it("finds a plan node by its body", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const outcome = await search(settings, { query: "refresh tokens" });
    expect(outcome.isError).toBeUndefined();

    const paths = hitsOf(outcome).map((hit) => hit.path);
    expect(paths).toContain("centurion/backend/auth/session-store.md");
  });

  it("never returns a note outside the planning root", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const outcome = await search(settings, { query: "refresh tokens" });
    const paths = hitsOf(outcome).map((hit) => hit.path);
    expect(paths.some((path) => path.startsWith("Notes/"))).toBe(false);
    expect(paths.every((path) => path.startsWith("centurion/") || path.startsWith("loop/"))).toBe(
      true,
    );
  });

  it("never returns a snapshot or an archived node", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const outcome = await search(settings, { query: "refresh tokens" });
    const paths = hitsOf(outcome).map((hit) => hit.path);
    expect(paths.some((path) => path.includes("__history"))).toBe(false);
    expect(paths.some((path) => path.includes("_archive"))).toBe(false);
  });

  it("skips a file inside the root that is not a plan", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const outcome = await search(settings, { query: "refresh tokens notes without frontmatter" });
    const paths = hitsOf(outcome).map((hit) => hit.path);
    expect(paths).not.toContain("centurion/scratch.md");
    expect((outcome.structuredContent as { skipped: number }).skipped).toBeGreaterThanOrEqual(1);
  });

  it("filters by kind from frontmatter", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const outcome = await search(settings, { query: "sessions", kind: "goal" });
    const hits = hitsOf(outcome);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.kind === "goal")).toBe(true);
    expect(hits.map((hit) => hit.path)).toContain("centurion/_goals/session-persistence.md");
  });

  it("filters by status from frontmatter, not from the text", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const proposed = await search(settings, { query: "sessions", status: "proposed" });
    const hits = hitsOf(proposed);
    expect(hits.map((hit) => hit.path)).toEqual(["centurion/_goals/session-persistence.md"]);

    const inProgress = await search(settings, { query: "refresh tokens", status: "in_progress" });
    expect(hitsOf(inProgress).every((hit) => hit.status === "in_progress")).toBe(true);
  });

  it("filters by project", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const outcome = await search(settings, { query: "refresh tokens", project: "centurion" });
    const hits = hitsOf(outcome);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.project === "centurion")).toBe(true);
  });

  it("returns one row per note and respects the limit", async () => {
    const created = searchableWorkspace();
    const settings = index(created);
    const outcome = await search(settings, { query: "refresh tokens", limit: 1 });
    const hits = hitsOf(outcome);
    expect(hits).toHaveLength(1);
    const paths = hits.map((hit) => hit.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("reports an empty index instead of pretending there is no plan", async () => {
    const created = searchableWorkspace();
    const settings = runtimeSettings(created.vault);
    const outcome = await search(settings, { query: "refresh tokens" });
    expect(outcome.isError).toBeUndefined();
    expect(outcome.text).toContain("index is empty");
  });

  it("reports an empty root as ready when the directory did not exist", async () => {
    const created = makeWorkspace({ "A.md": "# A\n" });
    workspaces.push(created);
    const outcome = await search(runtimeSettings(created.vault), { query: "x" });
    expect(outcome.isError).toBeUndefined();
    expect(outcome.structuredContent).toMatchObject({
      planning_available: true,
      hits: [],
      root: "Workspaces",
    });
  });
});
