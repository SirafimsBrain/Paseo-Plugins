import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_CHILD_KINDS,
  LEAF_STATUSES,
  LEAF_TRANSITIONS,
  canHaveChild,
  canTransitionLeaf,
  historyEntrySchema,
  nodeSchema,
  NODE_KINDS,
  type LeafStatus,
} from "../shared/tree";
import {
  BEE_STATUSES,
  BEE_TRANSITIONS,
  beeSchema,
  BUG_STATUSES,
  BUG_TRANSITIONS,
  bugSchema,
  canTransitionBee,
  canTransitionBug,
  isBugBlocking,
} from "../shared/links";
import {
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  canApproveGoal,
  canTransitionGoal,
  goalSchema,
} from "../shared/goals";
import {
  GROWTH_STEP_STATES,
  canTransitionGrowth,
  growthProgress,
  growthSchema,
  type GrowthStep,
} from "../shared/growth";

const NOW = 1_760_000_000_000;

// ── Leaf state machine ───────────────────────────────────────────────────

describe("leaf state machine (ADR-6)", () => {
  it("covers every declared status in the transition table", () => {
    expect(Object.keys(LEAF_TRANSITIONS).sort()).toEqual(
      [...LEAF_STATUSES].sort(),
    );
  });

  it("walks the happy path draft → ready → claimed → in_progress → done", () => {
    expect(canTransitionLeaf("draft", "ready")).toBe(true);
    expect(canTransitionLeaf("ready", "claimed")).toBe(true);
    expect(canTransitionLeaf("claimed", "in_progress")).toBe(true);
    expect(canTransitionLeaf("in_progress", "done")).toBe(true);
  });

  it("rejects jumps that skip the pipeline", () => {
    expect(canTransitionLeaf("draft", "done")).toBe(false);
    expect(canTransitionLeaf("ready", "in_progress")).toBe(false);
    expect(canTransitionLeaf("claimed", "done")).toBe(false);
  });

  it("hangs blocked off in_progress and resumes it", () => {
    expect(canTransitionLeaf("in_progress", "blocked")).toBe(true);
    expect(canTransitionLeaf("blocked", "in_progress")).toBe(true);
    // blocked is not a shortcut to done, and cannot be entered early
    expect(canTransitionLeaf("blocked", "done")).toBe(false);
    expect(canTransitionLeaf("ready", "blocked")).toBe(false);
    expect(canTransitionLeaf("draft", "blocked")).toBe(false);
  });

  it("treats cancelled and superseded as terminal", () => {
    for (const terminal of ["cancelled", "superseded"] as const) {
      expect(LEAF_TRANSITIONS[terminal]).toHaveLength(0);
      for (const status of LEAF_STATUSES) {
        expect(canTransitionLeaf(terminal, status)).toBe(false);
      }
    }
  });

  it("lets done be superseded but never cancelled", () => {
    expect(canTransitionLeaf("done", "superseded")).toBe(true);
    expect(canTransitionLeaf("done", "cancelled")).toBe(false);
    expect(canTransitionLeaf("done", "in_progress")).toBe(false);
  });

  it("never allows a no-op self transition (no revision bump)", () => {
    for (const status of LEAF_STATUSES) {
      expect(canTransitionLeaf(status, status)).toBe(false);
    }
  });

  it("never points a transition outside the status vocabulary", () => {
    const known = new Set<LeafStatus>(LEAF_STATUSES);
    for (const targets of Object.values(LEAF_TRANSITIONS)) {
      for (const target of targets) expect(known.has(target)).toBe(true);
    }
  });
});

// ── Node kind hierarchy ──────────────────────────────────────────────────

describe("node kind hierarchy", () => {
  it("follows root → trunk → branch → subbranch/leaf", () => {
    expect(canHaveChild("root", "trunk")).toBe(true);
    expect(canHaveChild("trunk", "branch")).toBe(true);
    expect(canHaveChild("branch", "subbranch")).toBe(true);
    expect(canHaveChild("branch", "leaf")).toBe(true);
    expect(canHaveChild("subbranch", "leaf")).toBe(true);
  });

  it("rejects skipping levels and cycles", () => {
    expect(canHaveChild("root", "branch")).toBe(false);
    expect(canHaveChild("trunk", "leaf")).toBe(false);
    expect(canHaveChild("leaf", "leaf")).toBe(false);
    expect(canHaveChild("leaf", "branch")).toBe(false);
    expect(canHaveChild("branch", "branch")).toBe(false);
  });

  it("declares children for every kind", () => {
    for (const kind of NODE_KINDS) {
      expect(ALLOWED_CHILD_KINDS[kind]).toBeDefined();
    }
  });
});

// ── Node schema ──────────────────────────────────────────────────────────

describe("node schema", () => {
  const validNode = {
    id: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c77",
    projectKey: "/home/user/project",
    parentId: null,
    kind: "root" as const,
    name: "Tech stack",
    description: "Python 3.12, FastAPI",
    status: "draft" as const,
    version: "",
    revision: 1,
    payload: { languages: ["python"] },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "user",
    updatedBy: null,
    archivedAt: null,
  };

  it("accepts a valid root node", () => {
    expect(nodeSchema.parse(validNode).kind).toBe("root");
  });

  it("rejects an unknown kind or status", () => {
    expect(() => nodeSchema.parse({ ...validNode, kind: "leafy" })).toThrow();
    expect(() => nodeSchema.parse({ ...validNode, status: "wip" })).toThrow();
  });

  it("rejects a non-positive revision and empty name", () => {
    expect(() => nodeSchema.parse({ ...validNode, revision: 0 })).toThrow();
    expect(() => nodeSchema.parse({ ...validNode, name: "" })).toThrow();
  });
});

// ── Bees ─────────────────────────────────────────────────────────────────

describe("bees", () => {
  const validBee = {
    id: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c78",
    projectKey: "/home/user/project",
    sourceLeafId: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c79",
    targetLeafId: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c7a",
    status: "active" as const,
    revision: 1,
    impact: "changing the schema forces a migration here",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "agent-1",
    updatedBy: null,
  };

  it("rejects a self-loop", () => {
    expect(() =>
      beeSchema.parse({ ...validBee, targetLeafId: validBee.sourceLeafId }),
    ).toThrow(/itself/);
  });

  it("has a transition table covering every status", () => {
    expect(Object.keys(BEE_TRANSITIONS).sort()).toEqual(
      [...BEE_STATUSES].sort(),
    );
    expect(canTransitionBee("active", "resolved")).toBe(true);
    expect(canTransitionBee("resolved", "resolved")).toBe(false);
    expect(canTransitionBee("cancelled", "resolved")).toBe(false);
  });
});

// ── Bugs ─────────────────────────────────────────────────────────────────

describe("bugs", () => {
  it("has a transition table covering every status", () => {
    expect(Object.keys(BUG_TRANSITIONS).sort()).toEqual(
      [...BUG_STATUSES].sort(),
    );
    expect(canTransitionBug("open", "investigating")).toBe(true);
    expect(canTransitionBug("investigating", "resolved")).toBe(true);
    expect(canTransitionBug("resolved", "cancelled")).toBe(false);
    expect(canTransitionBug("cancelled", "resolved")).toBe(false);
  });

  it("blocks leaves while open or investigating, not once resolved", () => {
    expect(isBugBlocking("open")).toBe(true);
    expect(isBugBlocking("investigating")).toBe(true);
    expect(isBugBlocking("resolved")).toBe(false);
    expect(isBugBlocking("cancelled")).toBe(false);
  });

  it("requires a non-empty title and a known severity", () => {
    const base = {
      id: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c7b",
      projectKey: "/home/user/project",
      title: "migration fails on empty db",
      description: "",
      severity: "high" as const,
      status: "open" as const,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "agent-1",
      updatedBy: null,
    };
    expect(bugSchema.parse(base).severity).toBe("high");
    expect(() => bugSchema.parse({ ...base, title: "" })).toThrow();
    expect(() => bugSchema.parse({ ...base, severity: "blocker" })).toThrow();
  });
});

// ── Goals (approval gate, ADR-7) ─────────────────────────────────────────

describe("goals", () => {
  it("has a transition table covering every status", () => {
    expect(Object.keys(GOAL_TRANSITIONS).sort()).toEqual(
      [...GOAL_STATUSES].sort(),
    );
  });

  it("allows approval only from proposed", () => {
    expect(canApproveGoal("proposed")).toBe(true);
    expect(canApproveGoal("draft")).toBe(false);
    expect(canApproveGoal("approved")).toBe(false);
    expect(canTransitionGoal("proposed", "approved")).toBe(true);
    expect(canTransitionGoal("draft", "approved")).toBe(false);
  });

  it("keeps cancelled and superseded terminal", () => {
    expect(GOAL_TRANSITIONS.cancelled).toHaveLength(0);
    expect(GOAL_TRANSITIONS.superseded).toHaveLength(0);
    expect(canTransitionGoal("cancelled", "approved")).toBe(false);
  });

  it("requires formal text and at least the goal identity fields", () => {
    const base = {
      id: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c7c",
      projectKey: "/home/user/project",
      formalText: "Add PDF export",
      plan: [{ id: "s1", title: "Pick a library", description: "" }],
      status: "draft" as const,
      revision: 1,
      materializedNodeId: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user",
      updatedBy: null,
    };
    expect(goalSchema.parse(base).plan).toHaveLength(1);
    expect(() => goalSchema.parse({ ...base, formalText: "" })).toThrow();
    expect(() => goalSchema.parse({ ...base, status: "maybe" })).toThrow();
  });
});

// ── Growth rates ─────────────────────────────────────────────────────────

describe("growth rates", () => {
  const step = (
    state: GrowthStep["state"],
    id = Math.random().toString(36).slice(2),
  ): GrowthStep => ({
    id,
    title: `step ${id}`,
    state,
    facts: [],
    reason: "",
  });

  it("aggregates progress as the share of completed steps", () => {
    const { total, completed, ratio } = growthProgress([
      step("completed"),
      step("completed"),
      step("pending"),
      step("skipped"),
      step("failed"),
    ]);
    expect(total).toBe(5);
    expect(completed).toBe(2);
    expect(ratio).toBeCloseTo(0.4);
  });

  it("reports zero ratio for an empty record", () => {
    expect(growthProgress([]).ratio).toBe(0);
  });

  it("has a transition table covering every status", () => {
    expect(canTransitionGrowth("active", "stalled")).toBe(true);
    expect(canTransitionGrowth("stalled", "active")).toBe(true);
    expect(canTransitionGrowth("done", "cancelled")).toBe(false);
  });

  it("accepts every declared step state", () => {
    for (const state of GROWTH_STEP_STATES) {
      expect(step(state).state).toBe(state);
    }
  });

  it("validates a full growth record", () => {
    const record = {
      id: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c7d",
      projectKey: "/home/user/project",
      subjectType: "goal" as const,
      subjectId: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c7c",
      steps: [step("completed", "a"), step("pending", "b")],
      status: "active" as const,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "agent-1",
      updatedBy: null,
    };
    expect(growthSchema.parse(record).steps).toHaveLength(2);
    expect(() =>
      growthSchema.parse({ ...record, subjectType: "bee" }),
    ).toThrow();
  });
});

// ── Audit history ────────────────────────────────────────────────────────

describe("history entries", () => {
  it("accepts a well-formed audit row", () => {
    const entry = {
      id: 1,
      projectKey: "/home/user/project",
      entityType: "node" as const,
      entityId: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c77",
      action: "status" as const,
      revision: 3,
      actor: "agent-1",
      result: "draft → ready",
      at: NOW,
    };
    expect(historyEntrySchema.parse(entry).action).toBe("status");
  });

  it("rejects an unknown entity type or action", () => {
    const base = {
      id: 1,
      projectKey: "/home/user/project",
      entityType: "node" as const,
      entityId: "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c77",
      action: "status" as const,
      revision: 1,
      actor: null,
      result: "",
      at: NOW,
    };
    expect(() =>
      historyEntrySchema.parse({ ...base, entityType: "bee hive" }),
    ).toThrow();
    expect(() => historyEntrySchema.parse({ ...base, action: "meh" })).toThrow();
  });
});

// ── Import boundaries (SDK rule: shared/ is runtime-neutral) ─────────────

describe("shared/ import boundaries", () => {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const sharedDir = join(__dirname, "..", "shared");
  const files = readdirSync(sharedDir).filter((f) => f.endsWith(".ts"));

  it("has the expected domain modules", () => {
    expect(files.sort()).toEqual(
      ["goals.ts", "growth.ts", "links.ts", "tools.ts", "tree.ts"].sort(),
    );
  });

  it("imports nothing runtime-specific (no Node, React, or SDK runtimes)", () => {
    const forbidden = [
      /from\s+["']node:/,
      /from\s+["']react/,
      /from\s+["']@getpaseo\/plugin\//,
      /from\s+["']\.\.\//,
      /\bdocument\.|\bwindow\.|localStorage|navigator\./,
    ];
    for (const file of files) {
      const source = readFileSync(join(sharedDir, file), "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });
});
