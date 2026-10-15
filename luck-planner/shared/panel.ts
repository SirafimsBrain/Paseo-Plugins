import type { LeafStatus, Node, NodeKind } from "./tree";

/**
 * Pure view-model helpers for the native workspace panel (PLAN.md stage E2,
 * `__doc.md` §6).
 *
 * Everything here is a pure function over the RPC payloads — no React, no
 * React Native, no RPC — so the panel behaviour (grouping, filtering,
 * status presentation) is pinned by `tests/tree-panel.test.ts` without a
 * DOM. The `client/tree-panel.tsx` component only renders what these
 * functions return.
 */

/** One tree section: a root with its first level of children (RPC shape). */
export interface TreeSection {
  node: Node;
  children: Node[];
}

/**
 * Groups a flat node list by parent id — how the panel renders an outline
 * deeper than the one RPC level: roots first, then children of the expanded
 * branches. Archived nodes stay out (the panel shows actionable work).
 */
export function groupByParent(nodes: readonly Node[]): Map<string | null, Node[]> {
  const groups = new Map<string | null, Node[]>();
  for (const node of nodes) {
    if (node.archivedAt !== null) continue;
    const list = groups.get(node.parentId) ?? [];
    list.push(node);
    groups.set(node.parentId, list);
  }
  return groups;
}

/** Leaf-status filter for the panel chip row; `null` means "show all". */
export type LeafStatusFilter = LeafStatus | null;

/** Node-kind filter for the panel chip row; `null` means "show all". */
export type NodeKindFilter = NodeKind | null;

export interface PanelFilters {
  query: string;
  status: LeafStatusFilter;
  kind: NodeKindFilter;
}

/** Default (empty) panel filters. */
export function defaultPanelFilters(): PanelFilters {
  return { query: "", status: null, kind: null };
}

/**
 * Whether a node passes the panel filters. The free-text query matches the
 * name and description case-insensitively; the status filter applies to
 * leaves only (branches carry `draft` by construction and would vanish
 * otherwise); the kind filter applies to every node.
 */
export function nodeMatchesFilters(node: Node, filters: PanelFilters): boolean {
  if (filters.kind !== null && node.kind !== filters.kind) return false;
  if (
    filters.status !== null &&
    node.kind === "leaf" &&
    node.status !== filters.status
  ) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (query.length === 0) return true;
  return (
    node.name.toLowerCase().includes(query) ||
    node.description.toLowerCase().includes(query)
  );
}

/**
 * Filters RPC tree sections for the outline: a root stays visible when it or
 * any of its children matches, so filtering never orphans a matching leaf
 * under a hidden root.
 */
export function filterSections(
  sections: readonly TreeSection[],
  filters: PanelFilters,
): TreeSection[] {
  if (
    filters.query.trim().length === 0 &&
    filters.status === null &&
    filters.kind === null
  ) {
    return [...sections];
  }
  const result: TreeSection[] = [];
  for (const section of sections) {
    const rootMatches = nodeMatchesFilters(section.node, filters);
    const children = section.children.filter((child) =>
      nodeMatchesFilters(child, filters),
    );
    if (rootMatches || children.length > 0) {
      result.push({
        node: section.node,
        children: rootMatches ? section.children : children,
      });
    }
  }
  return result;
}

/**
 * Human-readable one-line status for a node, e.g. `leaf · in_progress`.
 * Status is always rendered as text next to the colour dot (PLAN.md G3
 * rule: never colour alone), and this is the string the panel shows.
 */
export function nodeStatusLabel(node: Node): string {
  return `${node.kind} · ${node.status}`;
}

/** Short version/revision badge for the details view, e.g. `v3 · r12`. */
export function versionBadge(node: Node): string {
  return `v${node.version} · r${node.revision}`;
}

/**
 * Breadcrumb labels for the details view: the node path from
 * `luck-planner.node-detail`, root first.
 */
export function breadcrumbLabels(path: readonly Node[]): string[] {
  return path.map((node) => node.name);
}
