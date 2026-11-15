import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEAF_REFERENCE_MARKER,
  leafAgentInstruction,
  leafBriefSchema,
  leafBriefText,
  leafReference,
  payloadWithBrief,
  readLeafBrief,
  type LeafBrief,
} from "../shared/brief";
import { MCP_TOOLS, dispatchMcpTool } from "../server/mcp-tools";
import { LuckPlannerStore } from "../server/store";

/**
 * 0.53.0 acceptance: a leaf is an execution brief.
 *
 * The failure this suite pins down was measured on a real task: a person
 * copied a leaf from the dashboard into a prompt, the agent did not recognise
 * it, searched the daemon's files and the source document, and burned the
 * tokens the tree was supposed to save. Two things were missing — the leaf
 * carried no plan, and the reader had no way to see one. These tests assert
 * both halves: the brief round-trips through the MCP surface (upsert → get
 * context) and the copied instruction is self-describing.
 */

const P = "/projects/centurion";
const BRIEF: LeafBrief = {
  entryPoint: "centurion/rag/search.py:118 search()",
  steps: [
    "Add a lemmatiser before the FTS query is built",
    "Lemmatise stored terms and query terms",
    "Add the dependency to requirements.txt",
  ],
  files: ["centurion/rag/search.py", "centurion/requirements.txt"],
  acceptance: ["Query «нечёткие» finds the document with «нечёткий»"],
  established: ["The FTS5 index is rebuilt nightly — no migration needed"],
  source: "Report on Primuspilus search, §5 stage A",
};

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

function openStore(): LuckPlannerStore {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-brief-"));
  dirs.push(dir);
  const store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function call(store: LuckPlannerStore, name: string, args: Record<string, unknown>): ToolResult {
  return dispatchMcpTool(name, args, { store, defaultActor: "agent:coder", defaultProjectKey: P });
}

function payload<T>(result: ToolResult): T {
  if (result.isError) throw new Error(`unexpected tool error: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text) as T;
}

describe("the brief schema", () => {
  it("requires ordered steps and accepts the rest as optional prose", () => {
    expect(leafBriefSchema.safeParse(BRIEF).success).toBe(true);
    expect(
      leafBriefSchema.safeParse({ entryPoint: "a.py:1" }).success,
      "a brief without steps is not a plan",
    ).toBe(false);
    expect(leafBriefSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(leafBriefSchema.safeParse({ steps: ["do it"] }).success).toBe(true);
  });

  it("reads a brief out of a payload and tolerates everything else", () => {
    expect(readLeafBrief({ brief: BRIEF })).toEqual(BRIEF);
    expect(readLeafBrief({})).toBeNull();
    expect(readLeafBrief(null)).toBeNull();
    // An old or hand-written payload must not break a read path.
    expect(readLeafBrief({ brief: { steps: "not an array" } })).toBeNull();
    expect(readLeafBrief({ brief: { steps: [] } })).toBeNull();
  });

  it("merges a brief into a payload without dropping its other keys", () => {
    expect(
      payloadWithBrief({
        brief: BRIEF,
        previous: { plan: "keep me", fact: "and me" },
      }),
    ).toEqual({ plan: "keep me", fact: "and me", brief: BRIEF });
    expect(
      payloadWithBrief({ brief: BRIEF, given: { plan: "replaced" } }),
    ).toEqual({ plan: "replaced", brief: BRIEF });
    // No brief → the caller's payload passes through untouched.
    expect(payloadWithBrief({ brief: undefined, given: { a: 1 } })).toEqual({ a: 1 });
  });
});

describe("the copied instruction", () => {
  it("opens with the machine-recognisable reference", () => {
    expect(leafReference(P, "leaf-1")).toBe(
      `${LEAF_REFERENCE_MARKER} project="${P}" id="leaf-1"`,
    );
  });

  it("carries the fact, the plan and the instruction to not re-research", () => {
    const text = leafAgentInstruction({
      projectKey: P,
      leafId: "leaf-1",
      name: "Lemmatisation in the search path",
      path: "Centurion › Search",
      status: "ready",
      version: "0.1",
      revision: 3,
      description: "Fuzzy queries miss inflected forms.",
      brief: BRIEF,
    });
    expect(text.split("\n")[0]).toBe(leafReference(P, "leaf-1"));
    expect(text).toContain("Leaf: Lemmatisation in the search path");
    expect(text).toContain("Path: Centurion › Search");
    expect(text).toContain("Fact: Fuzzy queries miss inflected forms.");
    expect(text).toContain("Entry point: centurion/rag/search.py:118 search()");
    expect(text).toContain("1. Add a lemmatiser before the FTS query is built");
    expect(text).toContain("Acceptance:");
    expect(text).toContain("Already established (do not re-research):");
    expect(text).toContain("Source: Report on Primuspilus search, §5 stage A");
    // The sentence that stops the investigation the incident was about.
    expect(text).toContain("this paste IS the task");
    expect(text).toContain("do not re-research");
    // The tool call to make is spelled out with the exact key and id.
    expect(text).toContain(`"projectKey": "${P}"`);
    expect(text).toContain('"nodeId": "leaf-1"');
  });

  it("says so when the leaf has no plan instead of letting an agent hunt", () => {
    const text = leafAgentInstruction({
      projectKey: P,
      leafId: "leaf-2",
      name: "A fact without a plan",
      path: "",
      status: "draft",
      version: "",
      revision: 1,
      brief: null,
    });
    expect(text).toContain("Execution brief: none recorded");
    expect(text).not.toContain("Path:");
    expect(leafBriefText(null)).toBe("");
  });
});

describe("the MCP surface", () => {
  it("stores a brief as payload.brief and returns it from get_context", () => {
    const store = openStore();
    const created = payload<{ created: boolean; leaf: { id: string } }>(
      call(store, "luck_tree_upsert_leaf", {
        name: "Lemmatisation in the search path",
        description: "Fuzzy queries miss inflected forms.",
        brief: BRIEF,
      }),
    );
    expect(created.created).toBe(true);

    const leaf = store.getNode(P, created.leaf.id);
    expect(leaf?.payload.brief).toEqual(BRIEF);

    // One call is enough to start working: description, payload and brief all
    // come back with the node (the failure was a label-only answer).
    const context = payload<{
      node: { description: string; payload: Record<string, unknown>; brief: LeafBrief | null };
    }>(
      call(store, "luck_tree_get_context", { projectKey: P, nodeId: created.leaf.id }),
    );
    expect(context.node.description).toBe("Fuzzy queries miss inflected forms.");
    expect(context.node.payload.brief).toEqual(BRIEF);
    expect(context.node.brief).toEqual(BRIEF);
  });

  it("keeps the rest of the payload when only the brief changes", () => {
    const store = openStore();
    const created = payload<{ leaf: { id: string } }>(
      call(store, "luck_tree_upsert_leaf", {
        name: "A leaf with a payload",
        payload: { plan: "keep me" },
      }),
    );
    call(store, "luck_tree_upsert_leaf", {
      projectKey: P,
      leafId: created.leaf.id,
      brief: { steps: ["do it"] },
    });
    const leaf = store.getNode(P, created.leaf.id);
    expect(leaf?.payload).toEqual({ plan: "keep me", brief: { steps: ["do it"] } });
  });

  it("refuses a brief without steps through the shared validation", () => {
    const store = openStore();
    const result = call(store, "luck_tree_upsert_leaf", {
      name: "Invalid brief",
      brief: { entryPoint: "a.py:1" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid input");
    expect(store.listChildren(P, null)).toHaveLength(0);
  });

  it("publishes the brief shape in the tool schema", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "luck_tree_upsert_leaf");
    const brief = tool?.inputSchema.properties.brief;
    expect(brief?.type).toBe("object");
    expect(brief?.required).toEqual(["steps"]);
    expect(Object.keys(brief?.properties ?? {}).sort()).toEqual([
      "acceptance",
      "entryPoint",
      "established",
      "files",
      "source",
      "steps",
    ]);
  });
});
