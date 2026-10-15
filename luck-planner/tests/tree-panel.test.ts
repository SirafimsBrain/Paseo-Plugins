import { describe, expect, it } from "vitest";
import {
  breadcrumbLabels,
  defaultPanelFilters,
  filterSections,
  groupByParent,
  nodeMatchesFilters,
  nodeStatusLabel,
  versionBadge,
  type TreeSection,
} from "../shared/panel";
import type { Node } from "../shared/tree";

/**
 * Stage E2 acceptance (`PLAN.md`): the pure view-model behind the native
 * workspace panel. No React, no React Native, no RPC — grouping, filtering
 * and labels over fixture nodes.
 */

let seq = 0;

function node(overrides: Partial<Node> = {}): Node {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    projectKey: "/projects/demo",
    parentId: null,
    kind: "leaf",
    name: `leaf ${seq}`,
    description: "",
    status: "draft",
    version: "1",
    revision: 1,
    payload: {},
    createdAt: 1,
    updatedAt: 1,
    createdBy: "agent:coder",
    updatedBy: "agent:coder",
    archivedAt: null,
    ...overrides,
  };
}

describe("groupByParent", () => {
  it("groups live nodes by parent, roots under null", () => {
    const root = node({ kind: "root", name: "stack" });
    const trunk = node({ kind: "trunk", parentId: root.id, name: "platform" });
    const archived = node({ parentId: root.id, name: "old", archivedAt: 5 });
    const groups = groupByParent([root, trunk, archived]);
    expect(groups.get(null)?.map((entry) => entry.id)).toEqual([root.id]);
    expect(groups.get(root.id)?.map((entry) => entry.id)).toEqual([trunk.id]);
  });
});

describe("nodeMatchesFilters", () => {
  it("matches name and description case-insensitively", () => {
    const target = node({ name: "Retry failed charges", description: "billing queue" });
    expect(nodeMatchesFilters(target, { ...defaultPanelFilters(), query: "retry" })).toBe(true);
    expect(nodeMatchesFilters(target, { ...defaultPanelFilters(), query: "BILLING" })).toBe(true);
    expect(nodeMatchesFilters(target, { ...defaultPanelFilters(), query: "refund" })).toBe(false);
  });

  it("applies kind and leaf-status filters", () => {
    const leaf = node({ kind: "leaf", status: "in_progress" });
    const branch = node({ kind: "branch", status: "draft" });
    expect(nodeMatchesFilters(leaf, { ...defaultPanelFilters(), status: "in_progress" })).toBe(true);
    expect(nodeMatchesFilters(leaf, { ...defaultPanelFilters(), status: "done" })).toBe(false);
    expect(nodeMatchesFilters(branch, { ...defaultPanelFilters(), kind: "branch" })).toBe(true);
    expect(nodeMatchesFilters(leaf, { ...defaultPanelFilters(), kind: "branch" })).toBe(false);
  });

  it("does not hide branches behind a leaf-status filter", () => {
    const branch = node({ kind: "branch", status: "draft", name: "billing" });
    expect(nodeMatchesFilters(branch, { ...defaultPanelFilters(), status: "done" })).toBe(true);
  });
});

describe("filterSections", () => {
  it("keeps a root when a child matches", () => {
    const root = node({ kind: "root", name: "stack" });
    const match = node({ kind: "leaf", parentId: root.id, name: "retry charges" });
    const other = node({ kind: "leaf", parentId: root.id, name: "refund flow" });
    const sections: TreeSection[] = [{ node: root, children: [match, other] }];
    const result = filterSections(sections, { ...defaultPanelFilters(), query: "retry" });
    expect(result).toHaveLength(1);
    expect(result[0].children.map((child) => child.id)).toEqual([match.id]);
  });

  it("returns everything when filters are empty", () => {
    const root = node({ kind: "root" });
    const sections: TreeSection[] = [{ node: root, children: [node()] }];
    expect(filterSections(sections, defaultPanelFilters())).toHaveLength(1);
  });
});

describe("labels", () => {
  it("renders status and version badges as text", () => {
    const leaf = node({ kind: "leaf", status: "in_progress", version: "3", revision: 12 });
    expect(nodeStatusLabel(leaf)).toBe("leaf · in_progress");
    expect(versionBadge(leaf)).toBe("v3 · r12");
  });

  it("renders breadcrumbs root-first", () => {
    const root = node({ name: "stack" });
    const leaf = node({ name: "retry" });
    expect(breadcrumbLabels([root, leaf])).toEqual(["stack", "retry"]);
  });
});
