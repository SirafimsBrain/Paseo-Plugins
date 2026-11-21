import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { acquirePlanWriteLock, planLockPath } from "../server/plan/lock";
import type { PlanRoot } from "../server/plan/paths";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";
import { planFiles } from "./plan-fixtures";

/**
 * 0.21.17: planning writes are serialized per tree, like SQLite's single
 * writer. These tests model two agents as two calls in one process; the lock is
 * a directory, so the same mechanism is what a second MCP process sees.
 */

const workspaces: TestWorkspace[] = [];

function workspace(): TestWorkspace {
  const created = makeWorkspace(planFiles());
  workspaces.push(created);
  return created;
}

afterEach(() => {
  delete process.env.OBSIDIAN_BRIDGE_LOCK_WAIT_MS;
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function rootFor(created: TestWorkspace): PlanRoot {
  return {
    vaultRoot: created.vault,
    relPath: "Workspaces",
    absolute: path.join(created.vault, "Workspaces"),
    project: null,
    workspaceId: null,
  };
}

function locksDir(created: TestWorkspace): string {
  return path.join(created.home, "locks");
}

/** Takes a lock and fails the test if the lock answered `busy`. */
async function hold(
  root: PlanRoot,
  created: TestWorkspace,
  tool = "plan_growth",
): Promise<{ release: () => void }> {
  const held = await acquirePlanWriteLock(
    root,
    { tool, actor: "codex" },
    { locksRoot: locksDir(created), waitMs: 0 },
  );
  if (!("release" in held)) throw new Error(held.busy);
  return held;
}

describe("plan write lock", () => {
  it("is exclusive: a second writer is refused with a 10-second instruction", async () => {
    const created = workspace();
    const root = rootFor(created);
    const first = await hold(root, created);

    const busy = await acquirePlanWriteLock(
      root,
      { tool: "plan_set_status", actor: "claude" },
      { locksRoot: locksDir(created), waitMs: 0 },
    );
    expect("busy" in busy).toBe(true);
    if (!("busy" in busy)) return;
    expect(busy.busy).toContain("plan_growth");
    expect(busy.busy).toContain("codex");
    expect(busy.busy).toContain("Nothing was written");
    expect(busy.busy).toContain("Wait 10 seconds");
    expect(busy.holder?.pid).toBe(process.pid);

    first.release();
    expect(fs.existsSync(planLockPath(root, locksDir(created)))).toBe(false);

    const again = await acquirePlanWriteLock(
      root,
      { tool: "plan_set_status", actor: "claude" },
      { locksRoot: locksDir(created), waitMs: 0 },
    );
    expect("release" in again).toBe(true);
    if ("release" in again) again.release();
  });

  it("waits for the writer instead of refusing when it finishes inside the timeout", async () => {
    const created = workspace();
    const root = rootFor(created);
    const first = await hold(root, created);
    setTimeout(() => first.release(), 120);

    const waited = await acquirePlanWriteLock(
      root,
      { tool: "plan_update_node", actor: "claude" },
      { locksRoot: locksDir(created), waitMs: 2_000 },
    );
    expect("release" in waited).toBe(true);
    if (!("release" in waited)) return;
    expect(waited.waitedMs).toBeGreaterThan(0);
    waited.release();
  });

  it("recovers a lock left by a crashed process on this host", async () => {
    const created = workspace();
    const root = rootFor(created);
    const dir = planLockPath(root, locksDir(created));
    fs.mkdirSync(dir, { recursive: true });
    const child = spawnSync(process.execPath, ["-e", "0"]);
    expect(typeof child.pid).toBe("number");
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        pid: child.pid,
        host: os.hostname(),
        tool: "plan_import",
        actor: "codex",
        started_at: new Date().toISOString(),
        root: "Workspaces",
      }),
    );

    const recovered = await acquirePlanWriteLock(
      root,
      { tool: "plan_growth", actor: "claude" },
      { locksRoot: locksDir(created), waitMs: 0 },
    );
    expect("release" in recovered).toBe(true);
    if ("release" in recovered) recovered.release();
  });

  it("recovers an expired lock even when the holder is on another host", async () => {
    const created = workspace();
    const root = rootFor(created);
    const dir = planLockPath(root, locksDir(created));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        pid: 1,
        host: "another-machine",
        tool: "plan_import",
        actor: "codex",
        started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        root: "Workspaces",
      }),
    );

    const recovered = await acquirePlanWriteLock(
      root,
      { tool: "plan_growth", actor: "claude" },
      { locksRoot: locksDir(created), waitMs: 0, staleMs: 60_000 },
    );
    expect("release" in recovered).toBe(true);
    if ("release" in recovered) recovered.release();
  });

  it("refuses a tool call while another agent holds the tree, then releases its own", async () => {
    const created = workspace();
    const settings = runtimeSettings(created.vault);
    process.env.OBSIDIAN_BRIDGE_LOCK_WAIT_MS = "50";

    // Default lock root, the one dispatch uses: the plugin data directory under
    // the test's PASEO_HOME.
    const held = await acquirePlanWriteLock(rootFor(created), {
      tool: "plan_growth",
      actor: "codex",
    });
    if (!("release" in held)) throw new Error(held.busy);

    const blocked = await dispatchTool(
      "plan_growth",
      { path: "centurion/backend/auth/session-store", progress: 55, accept_external: true },
      settings,
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("Another agent is writing");
    expect(blocked.structuredContent).toMatchObject({
      ok: false,
      reason: "locked",
      retry_after_seconds: 10,
    });

    held.release();

    const written = await dispatchTool(
      "plan_growth",
      { path: "centurion/backend/auth/session-store", progress: 55, accept_external: true },
      settings,
    );
    expect(written.isError).toBeUndefined();
    expect(written.structuredContent).toMatchObject({ ok: true, revision: 5 });

    const locks = path.join(created.home, "plugins", "obsidian-bridge", "locks");
    expect(fs.readdirSync(locks)).toEqual([]);
  });
});
