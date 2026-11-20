import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import { MAX_NOTE_BYTES, isPlanSystemPath, walkMarkdown } from "../vault";
import { parsePlanDocument, positiveInt, stringField } from "./frontmatter";
import { BLOCKING_INCIDENT_STATUSES, isPlanKind, type PlanKind } from "./model";
import { isSnapshotFrontmatter as isSnapshot } from "./snapshot";
import { extractNotes } from "./sections";
import { isJournalPath } from "./journal";
import { resolvePlanPath, resolvePlanRoot, type PlanRoot } from "./paths";

/**
 * `plan_read`: the tree as the files describe it.
 *
 * Reading builds the whole plan tree in memory for one call — the vault already
 * holds the hierarchy in folders and the relations in frontmatter, and a plan
 * is small (hundreds of documents, not a corpus). Nothing is cached between
 * calls: the MCP server is a short-lived child process, so a cache would only
 * make a hand edit in Obsidian look stale.
 *
 * Two outputs, one entry point:
 * - without `path` — a project overview: every project with its root node, its
 *   trunks, counts and the things that need attention (open incidents,
 *   proposed goals);
 * - with `path` — one node in context: ancestors, children, siblings,
 *   influences in both directions, blocking incidents, the goal and growth
 *   record, and `beeCycle` when the influence edges close a loop.
 */

export interface PlanNode {
  /** Vault-relative path, the form Obsidian links use. */
  vaultPath: string;
  /** Path relative to `planRoot`, the form every `plan_*` argument takes. */
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface PlanTree {
  root: PlanRoot;
  /** Vault path → node. */
  nodes: Map<string, PlanNode>;
  /** Files under the root that are not plan documents (reported, never used). */
  skipped: string[];
}

export interface NodeSummary {
  /** Plan-relative path — pass it back to `plan_read`. */
  path: string;
  vault_path: string;
  kind: PlanKind;
  name: string;
  status: string | null;
  version: number | null;
  revision: number | null;
  description: string | null;
}

export type PlanTreeResult = { tree: PlanTree } | { error: string; reason: string };

/** Loads every plan document under a resolved planning root. */
export function loadPlanTree(root: PlanRoot): PlanTree {
  const nodes = new Map<string, PlanNode>();
  const skipped: string[] = [];
  const walk = walkMarkdown(root.vaultRoot, {
    includeFolders: root.relPath,
    excludeGlobs: "",
  });

  for (const vaultPath of walk.files) {
    const absolute = path.join(root.vaultRoot, vaultPath);
    try {
      if (fs.statSync(absolute).size > MAX_NOTE_BYTES) {
        skipped.push(vaultPath);
        continue;
      }
      const text = fs.readFileSync(absolute, "utf-8");
      const parsed = parsePlanDocument(text);
      if ("error" in parsed) {
        // The plugin writes the project journal itself; it is not a broken
        // plan document and must not be reported as one (live test R1).
        if (!isJournalPath(vaultPath)) skipped.push(vaultPath);
        continue;
      }
      const frontmatter = parsed.document.frontmatter;
      // A snapshot and a plain note are both "not a live node": the tree is
      // built from live documents only, exactly what a reader should see.
      if (isSnapshot(frontmatter) || !isPlanKind(frontmatter.kind)) {
        skipped.push(vaultPath);
        continue;
      }
      nodes.set(vaultPath, {
        vaultPath,
        relPath: vaultPath.slice(root.relPath.length + 1),
        frontmatter,
        body: parsed.document.body,
      });
    } catch {
      skipped.push(vaultPath);
    }
  }

  skipped.sort();
  return { root, nodes, skipped };
}

export function loadPlanTreeFor(settings: RuntimeSettings): PlanTreeResult {
  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) {
    return { error: resolved.error, reason: resolved.reason };
  }
  return { tree: loadPlanTree(resolved.root) };
}

export function kindOf(node: PlanNode): PlanKind | null {
  return isPlanKind(node.frontmatter.kind) ? node.frontmatter.kind : null;
}

export function statusOf(node: PlanNode): string | null {
  return stringField(node.frontmatter.status);
}

/** `[[target#heading|alias]]` → `target`. */
export function linkTarget(value: string): string | null {
  const match = /^\[\[(.+?)\]\]$/s.exec(value.trim());
  if (!match) return null;
  const target = match[1].split("|")[0].split("#")[0].trim();
  return target.length > 0 ? target : null;
}

/** Resolves a wikilink against the tree; `null` when nothing matches exactly once. */
export function resolveLink(tree: PlanTree, value: unknown): PlanNode | null {
  // A tool argument may be a wikilink or a bare plan path; both address a note.
  const raw =
    typeof value === "string" ? (linkTarget(value) ?? value.trim()) : null;
  if (!raw) return null;
  const target = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
  const withRoot = target.startsWith(`${tree.root.relPath}/`)
    ? target
    : `${tree.root.relPath}/${target}`;
  const direct = `${withRoot}.md`;
  const exact = tree.nodes.get(direct) ?? tree.nodes.get(`${target}.md`);
  if (exact) return exact;

  // A short `[[auth]]` is allowed for a human; it must match exactly one note.
  const name = target.split("/").pop() ?? target;
  const matches = [...tree.nodes.values()].filter((node) => {
    if (node.relPath.replace(/\.md$/i, "").endsWith(`/${target}`)) return true;
    if (node.relPath.replace(/\.md$/i, "") === target) return true;
    if (node.vaultPath.replace(/\.md$/i, "").endsWith(`/${target}`)) return true;
    const aliases = Array.isArray(node.frontmatter.aliases) ? node.frontmatter.aliases : [];
    if (aliases.some((alias) => typeof alias === "string" && alias === name)) return true;
    return false;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function summarize(node: PlanNode): NodeSummary {
  return {
    path: node.relPath,
    vault_path: node.vaultPath,
    kind: kindOf(node) ?? "leaf",
    name: stringField(node.frontmatter.name) ?? node.relPath.replace(/\.md$/i, ""),
    status: statusOf(node),
    version: positiveInt(node.frontmatter.version),
    revision: positiveInt(node.frontmatter.revision),
    // A goal states itself in `formal_text`; a reader asking for the summary
    // should not see `null` merely because the field has another name.
    description:
      stringField(node.frontmatter.description) ?? stringField(node.frontmatter.formal_text),
  };
}

/** Project a node belongs to: its first folder under `planRoot`. */
export function projectOf(node: PlanNode): string | null {
  const [first] = node.relPath.split("/");
  return node.relPath.includes("/") && !first.startsWith("_") ? first : null;
}

function parentOf(tree: PlanTree, node: PlanNode): PlanNode | null {
  const value = node.frontmatter.parent;
  if (typeof value !== "string") return null;
  return resolveLink(tree, value);
}

function childNodes(tree: PlanTree, node: PlanNode): PlanNode[] {
  const listed: PlanNode[] = [];
  const seen = new Set<string>();
  if (Array.isArray(node.frontmatter.children)) {
    for (const entry of node.frontmatter.children) {
      const child = resolveLink(tree, entry);
      if (child && !seen.has(child.vaultPath)) {
        seen.add(child.vaultPath);
        listed.push(child);
      }
    }
  }
  // A hand edit can add a file whose `parent` points here without touching the
  // parent's `children`; the reverse edge keeps the context truthful.
  for (const candidate of tree.nodes.values()) {
    if (candidate.vaultPath === node.vaultPath || seen.has(candidate.vaultPath)) continue;
    const parent = parentOf(tree, candidate);
    if (parent?.vaultPath === node.vaultPath) {
      seen.add(candidate.vaultPath);
      listed.push(candidate);
    }
  }
  return listed.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

function ancestorsOf(tree: PlanTree, node: PlanNode): PlanNode[] {
  const chain: PlanNode[] = [];
  const seen = new Set<string>([node.vaultPath]);
  let current = parentOf(tree, node);
  while (current && !seen.has(current.vaultPath)) {
    seen.add(current.vaultPath);
    chain.unshift(current);
    current = parentOf(tree, current);
  }
  return chain;
}

interface InfluenceEdge {
  node: PlanNode;
  status: string | null;
  impact: string | null;
  version: number | null;
  revision: number | null;
}

function influencesOf(tree: PlanTree, node: PlanNode): {
  edges: InfluenceEdge[];
  unresolved: string[];
} {
  const edges: InfluenceEdge[] = [];
  const unresolved: string[] = [];
  const entries = Array.isArray(node.frontmatter.influences) ? node.frontmatter.influences : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const target = resolveLink(tree, record.target);
    if (!target) {
      if (typeof record.target === "string") unresolved.push(record.target);
      continue;
    }
    edges.push({
      node: target,
      status: stringField(record.status),
      impact: stringField(record.impact),
      // The counters describe the target, so they come from the target itself.
      // A copy in the edge went stale as soon as the target was edited (R5).
      version: positiveInt(target.frontmatter.version),
      revision: positiveInt(target.frontmatter.revision),
    });
  }
  return { edges, unresolved };
}

/**
 * A cycle in the influence graph, as plan-relative paths from `start` back to
 * it, or `null`. Only `active` and `watching` edges count: a resolved
 * influence is a historical fact and cannot order work.
 */
export function findBeeCycle(tree: PlanTree, start: PlanNode): string[] | null {
  const walk = (node: PlanNode, pathSoFar: string[], depth: number): string[] | null => {
    if (depth > 64) return null;
    const { edges } = influencesOf(tree, node);
    for (const edge of edges) {
      if (edge.status !== "active" && edge.status !== "watching") continue;
      if (edge.node.vaultPath === start.vaultPath) {
        return [...pathSoFar, edge.node.relPath];
      }
      if (pathSoFar.includes(edge.node.relPath)) continue;
      const found = walk(edge.node, [...pathSoFar, edge.node.relPath], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start.relPath], 0);
}

export interface PlanReadResult {
  planning_available: boolean;
  root?: string;
  node?: NodeSummary;
  project?: string | null;
  parent?: NodeSummary | null;
  ancestors?: NodeSummary[];
  children?: NodeSummary[];
  siblings?: NodeSummary[];
  influences?: Array<{
    target: NodeSummary;
    status: string | null;
    impact: string | null;
    version: number | null;
    revision: number | null;
  }>;
  influencedBy?: Array<{ source: NodeSummary; status: string | null }>;
  blockedBy?: Array<{ incident: NodeSummary; status: string | null; blocking: boolean }>;
  blocks?: Array<{ target: NodeSummary }>;
  goal?: NodeSummary | null;
  /** The goal's own wording and step plan, kept as written in the file. */
  formal_text?: string | null;
  plan?: unknown;
  brief?: unknown;
  payload?: unknown;
  tags?: string[];
  /** Free text of `## Заметки`, the one section the tools carry through. */
  notes?: string | null;
  growth?: unknown;
  beeCycle?: string[] | null;
  unresolved?: string[];
  projects?: unknown[];
  skipped?: string[];
  documents?: number;
  error?: string;
  reason?: string;
  suggestions?: NodeSummary[];
}

function incidentBlocks(node: PlanNode): boolean {
  const status = statusOf(node);
  return status !== null && (BLOCKING_INCIDENT_STATUSES as readonly string[]).includes(status);
}

function overview(tree: PlanTree, projectFilter: string | null): PlanReadResult {
  const projects = new Map<string, PlanNode[]>();
  for (const node of tree.nodes.values()) {
    const project = projectOf(node);
    if (!project) continue;
    const list = projects.get(project) ?? [];
    list.push(node);
    projects.set(project, list);
  }

  const rows = [...projects.entries()]
    .filter(([project]) => projectFilter === null || project === projectFilter)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([project, nodes]) => {
      const rootNode =
        nodes.find((node) => kindOf(node) === "root") ??
        nodes.find((node) => parentOf(tree, node) === null) ??
        null;
      const trunks = rootNode
        ? childNodes(tree, rootNode).filter((node) => kindOf(node) === "trunk")
        : [];
      const byKind: Record<string, number> = {};
      for (const node of nodes) {
        const kind = kindOf(node);
        if (kind) byKind[kind] = (byKind[kind] ?? 0) + 1;
      }
      return {
        project,
        root: rootNode ? summarize(rootNode) : null,
        trunks: trunks.map((node) => ({
          ...summarize(node),
          children: childNodes(tree, node).length,
        })),
        counts: {
          nodes: nodes.length,
          byKind,
          leaves: nodes.filter((node) => kindOf(node) === "leaf").length,
        },
        openIncidents: nodes
          .filter((node) => kindOf(node) === "incident" && incidentBlocks(node))
          .map(summarize),
        // An approved goal is live work, not history: hiding it made the
        // overview disagree with `plan_search` (R7).
        goals: nodes
          .filter((node) => {
            const status = statusOf(node);
            return kindOf(node) === "goal" && (status === "proposed" || status === "approved");
          })
          .map(summarize),
      };
    });

  return {
    planning_available: true,
    root: tree.root.relPath,
    documents: tree.nodes.size,
    projects: rows,
    skipped: tree.skipped,
  };
}

/** Closest plan nodes for an unknown path, so a refusal is actionable. */
export function suggestPlanNodes(tree: PlanTree, value: string): NodeSummary[] {
  const needle = value.toLowerCase().replace(/\.md$/i, "");
  const basename = needle.split("/").pop() ?? needle;
  return [...tree.nodes.values()]
    .map((node) => ({
      node,
      hit:
        node.relPath.toLowerCase().includes(needle) ||
        node.relPath.toLowerCase().endsWith(`/${basename}.md`) ||
        (stringField(node.frontmatter.name) ?? "").toLowerCase().includes(basename),
    }))
    .filter((row) => row.hit)
    .slice(0, 5)
    .map((row) => summarize(row.node));
}

/**
 * Resolves a `plan_*` path argument to a live node.
 *
 * Three forms reach the same file: the folder (`centurion/backend/auth`), the
 * file (`…/auth.md`) and the project folder (`centurion` → `centurion.md`).
 * A miss returns real candidates — a refusal an agent cannot act on is a dead
 * end, and re-reading the whole vault to find the name is worse.
 */
export function findPlanNode(
  tree: PlanTree,
  rawPath: string,
): { node: PlanNode } | { error: string; suggestions: NodeSummary[] } {
  const resolved = resolvePlanPath(tree.root, rawPath);
  if ("error" in resolved) return { error: resolved.error, suggestions: [] };

  const candidates = [
    resolved.vaultPath,
    `${resolved.vaultPath}.md`,
    `${resolved.vaultPath}/${path.posix.basename(resolved.vaultPath)}.md`,
  ];
  const node = candidates.map((candidate) => tree.nodes.get(candidate)).find(Boolean) ?? null;
  if (!node) {
    return {
      error: `'${rawPath}' is not a plan node under '${tree.root.relPath}'.`,
      suggestions: suggestPlanNodes(tree, rawPath),
    };
  }
  return { node };
}

export function planRead(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): { result: PlanReadResult } | { error: PlanReadResult } {
  const loaded = loadPlanTreeFor(settings);
  if ("error" in loaded) {
    return {
      error: {
        planning_available: false,
        reason: loaded.reason,
        error: loaded.error,
      },
    };
  }
  const { tree } = loaded;
  const rawPath = typeof input.path === "string" ? input.path.trim() : "";
  const projectFilter = stringField(input.project);

  if (rawPath.length === 0) {
    const result = overview(tree, projectFilter);
    // A filter that silently matches nothing would read like an empty plan.
    if (projectFilter !== null && (result.projects as unknown[]).length === 0) {
      return {
        error: {
          planning_available: true,
          root: tree.root.relPath,
          error: `Project '${projectFilter}' has no plan documents under '${tree.root.relPath}'.`,
        },
      };
    }
    return { result };
  }

  if (isPlanSystemPath(rawPath)) {
    return {
      error: {
        planning_available: true,
        root: tree.root.relPath,
        error:
          `'${rawPath}' is planning history (__history) or the archive (_archive). Snapshots are ` +
          "read by `plan_history`; the live tree is what `plan_read` serves.",
      },
    };
  }

  const found = findPlanNode(tree, rawPath);
  if ("error" in found) {
    return {
      error: {
        planning_available: true,
        root: tree.root.relPath,
        error: found.error,
        suggestions: found.suggestions,
      },
    };
  }
  const node = found.node;

  const parent = parentOf(tree, node);
  const influences = influencesOf(tree, node);
  const blockedBy = (Array.isArray(node.frontmatter.blocked_by)
    ? node.frontmatter.blocked_by
    : []
  )
    .map((entry) => resolveLink(tree, entry))
    .filter((incident): incident is PlanNode => incident !== null && kindOf(incident) === "incident")
    .map((incident) => ({
      incident: summarize(incident),
      status: statusOf(incident),
      blocking: incidentBlocks(incident),
    }));

  const blocks = (Array.isArray(node.frontmatter.blocks) ? node.frontmatter.blocks : [])
    .map((entry) => resolveLink(tree, entry))
    .filter((target): target is PlanNode => target !== null)
    .map((target) => ({ target: summarize(target) }));

  const influencedBy: Array<{ source: NodeSummary; status: string | null }> = [];
  for (const candidate of tree.nodes.values()) {
    if (candidate.vaultPath === node.vaultPath) continue;
    const edges = influencesOf(tree, candidate).edges;
    for (const edge of edges) {
      if (edge.node.vaultPath === node.vaultPath) {
        influencedBy.push({ source: summarize(candidate), status: edge.status });
      }
    }
  }

  const goalNode = resolveLink(tree, node.frontmatter.goal);

  return {
    result: {
      planning_available: true,
      root: tree.root.relPath,
      project: projectOf(node),
      node: summarize(node),
      parent: parent ? summarize(parent) : null,
      ancestors: ancestorsOf(tree, node).map(summarize),
      children: childNodes(tree, node).map(summarize),
      siblings: parent
        ? childNodes(tree, parent)
            .filter((sibling) => sibling.vaultPath !== node.vaultPath)
            .map(summarize)
        : [],
      influences: influences.edges.map((edge) => ({
        target: summarize(edge.node),
        status: edge.status,
        impact: edge.impact,
        version: edge.version,
        revision: edge.revision,
      })),
      influencedBy: influencedBy.sort((left, right) =>
        left.source.path.localeCompare(right.source.path),
      ),
      blockedBy,
      blocks,
      goal: goalNode ? summarize(goalNode) : null,
      formal_text: stringField(node.frontmatter.formal_text),
      plan: node.frontmatter.plan ?? null,
      brief: node.frontmatter.brief ?? null,
      payload: node.frontmatter.payload ?? null,
      tags: Array.isArray(node.frontmatter.tags)
        ? node.frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      notes: extractNotes(node.body),
      growth: node.frontmatter.growth ?? null,
      beeCycle: findBeeCycle(tree, node),
      unresolved: influences.unresolved,
    },
  };
}

export function planReadTool(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): { text: string; isError?: boolean; structuredContent?: unknown } {
  const outcome = planRead(settings, input);
  if ("error" in outcome) {
    return {
      text: outcome.error.error ?? "The plan could not be read.",
      isError: true,
      structuredContent: outcome.error,
    };
  }
  return {
    text: JSON.stringify(outcome.result, null, 2),
    structuredContent: outcome.result,
  };
}

