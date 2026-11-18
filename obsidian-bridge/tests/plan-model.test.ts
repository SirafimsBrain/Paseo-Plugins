import { describe, expect, it } from "vitest";
import {
  ALLOWED_CHILD_KINDS,
  BEE_STATUSES,
  BLOCKING_INCIDENT_STATUSES,
  GOAL_STATUSES,
  GROWTH_STEP_STATES,
  INCIDENT_STATUSES,
  LEAF_STATUSES,
  LEAF_TRANSITIONS,
  PLAN_KEY_ORDER,
  SNAPSHOT_REASONS,
  canHaveChild,
  canTransitionLeaf,
  isNodeKind,
  isPlanKind,
  linkLabel,
  orderPlanKeys,
  statusesOfKind,
} from "../server/plan/model";

describe("hierarchy", () => {
  it("allows exactly the pairs luck-planner allowed", () => {
    expect(ALLOWED_CHILD_KINDS).toEqual({
      root: ["trunk"],
      trunk: ["branch"],
      branch: ["subbranch", "leaf"],
      subbranch: ["subbranch", "leaf"],
      leaf: [],
    });
    expect(canHaveChild("root", "trunk")).toBe(true);
    expect(canHaveChild("root", "leaf")).toBe(false);
    expect(canHaveChild("branch", "leaf")).toBe(true);
    expect(canHaveChild("leaf", "leaf")).toBe(false);
  });
});

describe("statuses", () => {
  it("keeps the leaf dictionary and the happy path", () => {
    expect(LEAF_STATUSES).toContain("deferred");
    expect(LEAF_STATUSES).toContain("superseded");
    expect(canTransitionLeaf("draft", "ready")).toBe(true);
    expect(canTransitionLeaf("in_progress", "blocked")).toBe(true);
    expect(canTransitionLeaf("blocked", "in_progress")).toBe(true);
    expect(canTransitionLeaf("done", "in_progress")).toBe(false);
    expect(canTransitionLeaf("done", "superseded")).toBe(true);
    expect(canTransitionLeaf("ready", "ready")).toBe(false);
    expect(canTransitionLeaf("cancelled", "draft")).toBe(false);
  });

  it("has no transition out of a terminal state", () => {
    expect(LEAF_TRANSITIONS.cancelled).toEqual([]);
    expect(LEAF_TRANSITIONS.superseded).toEqual([]);
  });

  it("gives each kind its own dictionary", () => {
    expect(statusesOfKind("leaf")).toBe(LEAF_STATUSES);
    expect(statusesOfKind("subbranch")).toBe(LEAF_STATUSES);
    expect(statusesOfKind("incident")).toBe(INCIDENT_STATUSES);
    expect(statusesOfKind("goal")).toBe(GOAL_STATUSES);
  });

  it("treats only open and investigating incidents as blocking", () => {
    expect(BLOCKING_INCIDENT_STATUSES).toEqual(["open", "investigating"]);
  });

  it("keeps the bee, growth and snapshot vocabularies", () => {
    expect(BEE_STATUSES).toEqual(["active", "watching", "resolved", "cancelled"]);
    expect(GROWTH_STEP_STATES).toContain("skipped");
    expect(SNAPSHOT_REASONS).toContain("restore");
  });
});

describe("kind guards", () => {
  it("accepts only the seven plan kinds", () => {
    expect(isPlanKind("incident")).toBe(true);
    expect(isPlanKind("goal")).toBe(true);
    expect(isPlanKind("bee")).toBe(false);
    expect(isPlanKind(undefined)).toBe(false);
    expect(isNodeKind("leaf")).toBe(true);
    expect(isNodeKind("goal")).toBe(false);
  });
});

describe("key order", () => {
  it("puts identity and lifecycle first and keeps unknown keys at the end", () => {
    const ordered = orderPlanKeys({
      future_key: 1,
      status: "ready",
      id: "x",
      name: "N",
      kind: "leaf",
    });
    expect(Object.keys(ordered)).toEqual(["id", "kind", "name", "status", "future_key"]);
  });

  it("lists every field a snapshot or a create writes", () => {
    for (const key of ["id", "schema", "kind", "version", "revision", "created", "tags"]) {
      expect(PLAN_KEY_ORDER).toContain(key);
    }
  });
});

describe("linkLabel", () => {
  it("reads the alias, else the last path segment", () => {
    expect(linkLabel("[[Workspaces/centurion/backend/auth/auth|auth]]")).toBe("auth");
    expect(linkLabel("[[Workspaces/centurion/backend/auth/session-store]]")).toBe("session-store");
    expect(linkLabel("[[Workspaces/centurion/backend/auth/auth.md]]")).toBe("auth");
    expect(linkLabel("plain text")).toBe("plain text");
  });
});
