import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUpsertLeafTool } from "../server/agent-tool";
import { LuckPlannerStore } from "../server/store";

/**
 * The native `luck_tree_upsert_leaf` agent tool (`__doc.md` §10.8 item 2): the
 * fallback surface for providers that do not speak MCP (Codex, Claude Code
 * headless), built on `defineAgentTool` exactly like the `command_center_run`
 * precedent in command-center. The contract that matters:
 *
 * - it publishes the **same tool name and input schema** the MCP server
 *   exposes, so the README's tool list stays true for every provider;
 * - it writes through the **same dispatcher and store** as MCP (shared
 *   validation, shared skeleton bootstrap, shared history) — the tree must
 *   not diverge depending on which transport recorded the fact;
 * - the audit actor defaults to the **calling agent's id**, supplied by the
 *   host at execute time (`context.agent.id`).
 */

const AGENT_ID = "agent-tester";
const P = "/projects/luck-agent-tool";

interface ExecResult {
  text: string;
  isError?: boolean;
}

let dir: string;
let store: LuckPlannerStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "luck-agent-tool-"));
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Execute with the context shape the host supplies at call time. */
function exec(
  tool: ReturnType<typeof createUpsertLeafTool>,
  input: unknown,
): Promise<ExecResult> {
  return tool.execute(input, { agent: { id: AGENT_ID } } as never) as Promise<
    ExecResult
  >;
}

describe("createUpsertLeafTool", () => {
  it("publishes the MCP tool name, title and description (README parity)", () => {
    const tool = createUpsertLeafTool(store);
    expect(tool.name).toBe("luck_tree_upsert_leaf");
    expect(tool.title).toBe("Create or update a fact leaf");
    expect(tool.description).toContain("cannot load MCP servers");
    expect(tool.description).toContain("same audit trail");
    // The schema the host validates against is the shared MCP schema itself.
    expect(tool.input.safeParse({ projectKey: P, name: "parity" }).success).toBe(
      true,
    );
    expect(tool.input.safeParse({ name: "no project key" }).success).toBe(false);
  });

  it("writes through the shared store and stamps the agent id as actor", async () => {
    const tool = createUpsertLeafTool(store);
    const result = await exec(tool, {
      projectKey: P,
      name: "first fact",
      description: "written by the native tool",
    });
    expect(result.isError).toBeFalsy();

    const hits = store.search("first fact", { projectKey: P });
    const leaf = hits.find((hit) => hit.node.name === "first fact");
    expect(leaf, "the fact must land in the shared store").toBeDefined();

    const history = store.listHistory(P, leaf!.node.id);
    expect(
      history.some((entry) => entry.actor === AGENT_ID),
      "the audit trail must name the agent",
    ).toBe(true);
  });

  it("bootstraps the skeleton like the MCP path (same dispatcher, same store)", async () => {
    const tool = createUpsertLeafTool(store);
    await exec(tool, { projectKey: P, name: "bootstrap leaf" });
    // root → trunk → branch exist after a first upsert (stage D3 contract).
    const roots = store.listChildren(P, null);
    expect(roots.length).toBe(1);
    expect(roots[0]!.kind).toBe("root");
    const trunks = store.listChildren(P, roots[0]!.id);
    expect(trunks[0]!.kind).toBe("trunk");
  });

  it("rejects invalid input through the shared validation (isError, not a throw)", async () => {
    const tool = createUpsertLeafTool(store);
    const result = await exec(tool, {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid input");
    // Nothing was written.
    expect(store.listChildren(P, null)).toEqual([]);
  });
});
