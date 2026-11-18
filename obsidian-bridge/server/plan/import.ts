import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { resolveInsideVault } from "../vault";
import { canHaveChild, isNodeKind, type NodeKind } from "./model";
import { resolvePlanRoot } from "./paths";
import { markDone, markStart, planDocument, slugify } from "./ops";
import { appendJournal } from "./journal";
import {
  actorOf,
  fail,
  isRecord,
  json,
  nowIso,
  readStored,
  writeStored,
  wikilinkFor,
} from "./write";

/**
 * `plan_import`: rebuild a `luck_tree_export` project as plan files.
 *
 * The source plugin exports one project as a single JSON document inside a zip
 * (`<project>-<stamp>.json.zip`, or a `.json` extracted by hand). This tool
 * reads that document, verifies the whole graph before touching the disk,
 * rebuilds the hierarchy as folders and links, and keeps the original row id as
 * `legacy_id` so a second import of the same file is recognisable instead of
 * duplicating the tree.
 *
 * Dry run is the default (the same rule the source plugin follows): the first
 * call answers the plan, the second (`dry_run: false`) writes it. Nothing is
 * ever deleted or overwritten — the target project must be empty or already
 * hold this very export.
 */

const EXPORT_FORMAT = "luck-planner-export";
const EXPORT_SCHEMA_VERSION = 1;
const INCIDENTS_FOLDER = "_incidents";
const GOALS_FOLDER = "_goals";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

interface ExportNode {
  id: string;
  projectKey?: string;
  parentId: string | null;
  kind: string;
  name: string;
  description?: string;
  status?: string;
  version?: string;
  revision?: number;
  payload?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string | null;
  updatedBy?: string | null;
  archivedAt?: number | null;
}

interface ExportBee {
  sourceLeafId?: string;
  targetLeafId?: string;
  revision?: number;
  impact?: string;
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string | null;
  updatedBy?: string | null;
}

interface ExportBug {
  id: string;
  title: string;
  description?: string;
  severity?: string;
  status?: string;
  revision?: number;
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string | null;
  updatedBy?: string | null;
}

interface ExportGoalStep {
  id?: string;
  title?: string;
  description?: string;
}

interface ExportGoal {
  id: string;
  formalText?: string;
  plan?: ExportGoalStep[];
  status?: string;
  revision?: number;
  materializedNodeId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string | null;
  updatedBy?: string | null;
}

interface ExportGrowthStep {
  title?: string;
  state?: string;
  facts?: unknown[];
  reason?: string;
}

interface ExportGrowth {
  subjectType?: string;
  subjectId?: string;
  steps?: ExportGrowthStep[];
  status?: string;
  revision?: number;
  updatedAt?: number;
  updatedBy?: string | null;
}

interface ExportDocument {
  format?: string;
  schemaVersion?: number;
  pluginVersion?: string;
  exportedAt?: number;
  projectKey?: string;
  nodes: ExportNode[];
  bees: ExportBee[];
  bugs: ExportBug[];
  bugAttachments: Array<{ bugId?: string; nodeId?: string }>;
  goals: ExportGoal[];
  growth: ExportGrowth[];
  history?: unknown[];
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isoOf(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return nowIso();
}

/**
 * One JSON entry out of a zip, without a dependency: the central directory is
 * the authoritative table, so it is read instead of guessing at local headers.
 * A bare `.json` (what an extracted archive looks like) passes through.
 */
function readArchiveJson(
  bytes: Buffer,
  label: string,
): { name: string; text: string } | { error: string } {
  if (bytes.length === 0) return { error: `'${label}' is empty.` };
  const head = bytes.subarray(0, 3).toString("utf8");
  if (head.startsWith("{") || head.startsWith("\uFEFF{")) {
    return { name: label, text: bytes.toString("utf-8").replace(/^\uFEFF/, "") };
  }
  if (bytes.readUInt32LE(0) !== 0x04034b50) {
    return {
      error:
        `'${label}' is neither a zip archive nor a JSON document. Pass the \`.json.zip\` ` +
        "written by `luck_tree_export`, or the `.json` extracted from it.",
    };
  }

  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 66_000); offset -= 1) {
    if (bytes.readUInt32LE(offset) === signature.readUInt32LE(0)) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return { error: `'${label}' is a zip archive without a central directory.` };

  const entries = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const names: string[] = [];
  let chosen: Buffer | null = null;
  let chosenName = "";

  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    names.push(name);
    if (!/\.json$/i.test(name) || name.startsWith("__MACOSX")) continue;

    const local = localOffset;
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) continue;
    const localName = bytes.readUInt16LE(local + 26);
    const localExtra = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localName + localExtra;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let payload: Buffer;
    try {
      payload =
        method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : Buffer.alloc(0);
    } catch {
      continue;
    }
    if (payload.length === 0 && method !== 0) continue;
    chosen = payload;
    chosenName = name;
    break;
  }

  if (!chosen) {
    return {
      error:
        `'${label}' holds no readable JSON entry` +
        (names.length > 0 ? ` (entries: ${names.slice(0, 5).join(", ")}).` : "."),
    };
  }
  const text = chosen.toString("utf-8").replace(/^\uFEFF/, "");
  return { name: chosenName, text };
}

interface ParsedExport {
  document: ExportDocument;
  issues: string[];
  warnings: string[];
}

/** Verifies the whole graph before a single file is created. */
function parseExportDocument(text: string): ParsedExport | { error: string; issues?: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return {
      error: `not a JSON document: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!isRecord(raw)) return { error: "not a luck-planner export: the document is not an object." };
  if (raw.format !== EXPORT_FORMAT) {
    return {
      error:
        `not a luck-planner export: \`format\` is ${JSON.stringify(raw.format)}, expected ` +
        `'${EXPORT_FORMAT}'.`,
    };
  }
  if (raw.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    return {
      error:
        `unsupported export schemaVersion ${JSON.stringify(raw.schemaVersion)}; this plugin ` +
        `reads ${EXPORT_SCHEMA_VERSION}. Upgrade obsidian-bridge to import it.`,
    };
  }

  const issues: string[] = [];
  const warnings: string[] = [];
  const nodes = Array.isArray(raw.nodes) ? (raw.nodes as ExportNode[]) : [];
  if (nodes.length === 0) return { error: "the export carries no nodes." };

  const byId = new Map<string, ExportNode>();
  for (const [index, node] of nodes.entries()) {
    const id = stringOf(node?.id);
    if (!id) {
      issues.push(`nodes.${index}.id: missing`);
      continue;
    }
    if (byId.has(id)) issues.push(`nodes.${index}.id: '${id}' appears twice`);
    if (!isNodeKind(node.kind)) {
      issues.push(`nodes.${index}.kind: '${String(node.kind)}' is not a tree kind`);
    }
    if (!stringOf(node.name)) issues.push(`nodes.${index}.name: missing`);
    byId.set(id, node);
  }
  const roots = nodes.filter((node) => node.kind === "root");
  if (roots.length === 0) issues.push("nodes: no root node");
  if (roots.length > 1) {
    issues.push(`nodes: ${roots.length} root nodes (a project holds one tree)`);
  }
  for (const node of nodes) {
    if (node.kind === "root") continue;
    if (!node.parentId) {
      issues.push(`node '${node.name}': no parentId`);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (!parent) {
      issues.push(`node '${node.name}': parent '${node.parentId}' is not in the export`);
      continue;
    }
    if (isNodeKind(parent.kind) && isNodeKind(node.kind) && !canHaveChild(parent.kind, node.kind)) {
      issues.push(
        `node '${node.name}': a ${parent.kind} cannot have a ${node.kind} child`,
      );
    }
  }
  if (issues.length > 0) {
    return { error: "the export does not describe a valid tree", issues };
  }

  const leaves = new Set(
    nodes.filter((node) => node.kind === "leaf").map((node) => node.id),
  );
  const bees = Array.isArray(raw.bees) ? (raw.bees as ExportBee[]) : [];
  for (const bee of bees) {
    for (const end of [bee.sourceLeafId, bee.targetLeafId]) {
      if (typeof end !== "string" || !leaves.has(end)) {
        warnings.push(`bee '${String(bee.sourceLeafId)}' → '${String(bee.targetLeafId)}' skipped: an end is not a leaf`);
        break;
      }
    }
  }

  const bugs = Array.isArray(raw.bugs) ? (raw.bugs as ExportBug[]) : [];
  const attachments = Array.isArray(raw.bugAttachments)
    ? raw.bugAttachments
    : [];
  const bugIds = new Set(bugs.map((bug) => bug.id));
  for (const attachment of attachments) {
    if (!bugIds.has(String(attachment.bugId)) || !byId.has(String(attachment.nodeId))) {
      warnings.push(
        `attachment '${String(attachment.bugId)}' → '${String(attachment.nodeId)}' skipped: unknown end`,
      );
    }
  }

  const goals = Array.isArray(raw.goals) ? (raw.goals as ExportGoal[]) : [];
  for (const goal of goals) {
    if (goal.materializedNodeId && !byId.has(goal.materializedNodeId)) {
      warnings.push(`goal '${String(goal.formalText ?? goal.id)}': materialized node is not in the export`);
    }
  }

  const growth = Array.isArray(raw.growth) ? (raw.growth as ExportGrowth[]) : [];
  for (const record of growth) {
    const known =
      record.subjectType === "node"
        ? byId.has(String(record.subjectId))
        : record.subjectType === "goal"
          ? goals.some((goal) => goal.id === record.subjectId)
          : false;
    if (!known) warnings.push(`growth record '${String(record.subjectId)}' skipped: unknown subject`);
  }

  return {
    document: {
      format: EXPORT_FORMAT,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      pluginVersion: stringOf(raw.pluginVersion) ?? "unknown",
      exportedAt: typeof raw.exportedAt === "number" ? raw.exportedAt : undefined,
      projectKey: stringOf(raw.projectKey) ?? undefined,
      nodes,
      bees,
      bugs,
      bugAttachments: attachments as ExportDocument["bugAttachments"],
      goals,
      growth,
      history: Array.isArray(raw.history) ? raw.history : undefined,
    },
    issues,
    warnings,
  };
}

interface PlannedFile {
  vaultPath: string;
  relPath: string;
  kind: string;
  text: string;
}

interface PlannedTree {
  files: PlannedFile[];
  project: string;
  counts: {
    nodes: number;
    leaves: number;
    incidents: number;
    goals: number;
    growth: number;
    bees: number;
    files: number;
  };
  warnings: string[];
}

/** Builds the whole tree in memory: paths, links and frontmatter. */
function planTree(
  root: { relPath: string },
  document: ExportDocument,
  project: string,
  includeArchived: boolean,
  actor: string,
): PlannedTree {
  const warnings: string[] = [];
  const nodes = document.nodes.filter((node) => includeArchived || !node.archivedAt);
  const skippedArchived = document.nodes.length - nodes.length;
  if (skippedArchived > 0) {
    warnings.push(`${skippedArchived} archived node(s) skipped (include_archived: false)`);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string | null, ExportNode[]>();
  for (const node of nodes) {
    if (!includeArchived && node.archivedAt) continue;
    const parent = node.kind === "root" ? null : node.parentId;
    if (parent !== null && !byId.has(parent)) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(node);
    childrenOf.set(parent, list);
  }

  const vaultOf = (rel: string) => `${root.relPath}/${rel}`;
  const paths = new Map<string, string>();
  const usedSlugs = new Map<string, Set<string>>();
  const uniqueSlug = (folder: string, base: string): string => {
    const used = usedSlugs.get(folder) ?? new Set<string>();
    usedSlugs.set(folder, used);
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    used.add(candidate);
    return candidate;
  };

  const rootNode = nodes.find((node) => node.kind === "root");
  if (!rootNode) throw new Error("the export has no root node");
  const rootFile = `${project}/${project}.md`;
  paths.set(rootNode.id, rootFile);

  const order: ExportNode[] = [rootNode];
  const queue: ExportNode[] = [rootNode];
  while (queue.length > 0) {
    const parent = queue.shift() as ExportNode;
    const parentFile = paths.get(parent.id) as string;
    const folder = path.posix.dirname(parentFile);
    for (const child of childrenOf.get(parent.id) ?? []) {
      const base = slugify(child.name, `node-${child.id.slice(0, 8)}`);
      const slug = uniqueSlug(folder, base);
      const file = child.kind === "leaf" ? `${folder}/${slug}.md` : `${folder}/${slug}/${slug}.md`;
      paths.set(child.id, file);
      order.push(child);
      queue.push(child);
    }
  }
  const unplaced = nodes.filter((node) => !paths.has(node.id));
  if (unplaced.length > 0) {
    warnings.push(
      `${unplaced.length} node(s) unreachable from the root: ` +
        unplaced.slice(0, 5).map((node) => node.name).join(", "),
    );
  }

  const growthBySubject = new Map<string, ExportGrowth>();
  for (const record of document.growth) {
    if (record.subjectType && record.subjectId) {
      growthBySubject.set(`${record.subjectType}:${record.subjectId}`, record);
    }
  }

  const influencesBySource = new Map<string, ExportBee[]>();
  for (const bee of document.bees) {
    if (!bee.sourceLeafId || !bee.targetLeafId) continue;
    if (!paths.has(bee.sourceLeafId) || !paths.has(bee.targetLeafId)) continue;
    const list = influencesBySource.get(bee.sourceLeafId) ?? [];
    list.push(bee);
    influencesBySource.set(bee.sourceLeafId, list);
  }

  const blockedByLeaf = new Map<string, ExportBug[]>();
  const blockedByIncident = new Map<string, ExportNode[]>();
  for (const attachment of document.bugAttachments) {
    const bug = document.bugs.find((candidate) => candidate.id === attachment.bugId);
    const leafId = attachment.nodeId;
    if (!bug || !leafId || !paths.has(leafId)) continue;
    const list = blockedByLeaf.get(leafId) ?? [];
    list.push(bug);
    blockedByLeaf.set(leafId, list);
    const node = byId.get(leafId) as ExportNode;
    const attached = blockedByIncident.get(bug.id) ?? [];
    attached.push(node);
    blockedByIncident.set(bug.id, attached);
  }

  // Incident files are addressed before the nodes: a leaf's `blocked_by` is a
  // link to the incident document, exactly as `plan_incident` writes it.
  const incidentPaths = new Map<string, string>();
  for (const bug of document.bugs) {
    const attached = (blockedByIncident.get(bug.id) ?? []).filter((node) => paths.has(node.id));
    if (attached.length === 0) continue;
    const base = slugify(bug.title, `incident-${bug.id.slice(0, 8)}`);
    const slug = uniqueSlug(`${project}/${INCIDENTS_FOLDER}`, base);
    incidentPaths.set(bug.id, `${project}/${INCIDENTS_FOLDER}/${slug}.md`);
  }

  const files: PlannedFile[] = [];
  const link = (id: string) => wikilinkFor(vaultOf(paths.get(id) as string));

  for (const node of order) {
    const file = paths.get(node.id) as string;
    const kind = node.kind as NodeKind;
    const status =
      typeof node.status === "string" && node.status.trim().length > 0
        ? node.status.trim()
        : "draft";
    const children = (childrenOf.get(node.id) ?? [])
      .filter((child) => paths.has(child.id))
      .map((child) => link(child.id));
    const influences = (influencesBySource.get(node.id) ?? [])
      .map((bee) => {
        const target = byId.get(bee.targetLeafId as string) as ExportNode;
        return {
          target: link(target.id),
          ...(stringOf(bee.impact) ? { note: stringOf(bee.impact) as string } : {}),
          ...(typeof bee.revision === "number" ? { version: bee.revision } : {}),
        };
      });
    const blockedBy = (blockedByLeaf.get(node.id) ?? [])
      .filter((bug) => incidentPaths.has(bug.id))
      .map((bug) => wikilinkFor(vaultOf(incidentPaths.get(bug.id) as string)));
    const frontmatter: Record<string, unknown> = {
      id: crypto.randomUUID(),
      legacy_id: node.id,
      schema: 1,
      kind,
      name: node.name,
      description: typeof node.description === "string" ? node.description : "",
      status,
      version: 1,
      revision:
        typeof node.revision === "number" && node.revision > 0 ? Math.trunc(node.revision) : 1,
      ...(stringOf(node.version) ? { legacy_version: stringOf(node.version) } : {}),
      ...(node.projectKey ? { project_key: node.projectKey } : {}),
      parent: node.kind === "root" ? null : link(node.parentId as string),
      children,
      influences,
      blocked_by: blockedBy,
      ...(isRecord(node.payload) && Object.keys(node.payload).length > 0
        ? { payload: node.payload }
        : {}),
      journal: [],
      created: isoOf(node.createdAt),
      updated: isoOf(node.updatedAt),
      created_by: stringOf(node.createdBy) ?? actor,
      updated_by: stringOf(node.updatedBy) ?? actor,
      tags:
        kind === "leaf" && blockedBy.length > 0
          ? [`plan/${kind}`, `plan/status/${status}`, "plan/blocked"]
          : [`plan/${kind}`, `plan/status/${status}`],
      archived: node.archivedAt ? isoOf(node.archivedAt) : null,
    };
    const growth = growthBySubject.get(`node:${node.id}`);
    if (growth) frontmatter.growth = growthFrontmatter(growth, actor);

    files.push({
      vaultPath: vaultOf(file),
      relPath: file,
      kind,
      text: planDocument(frontmatter),
    });
  }

  // Incidents: one document per bug, linking the leaves it attaches to.
  for (const bug of document.bugs) {
    const attached = (blockedByIncident.get(bug.id) ?? []).filter((node) => paths.has(node.id));
    if (attached.length === 0) {
      warnings.push(`incident '${bug.title}' skipped: it is attached to no imported leaf`);
      continue;
    }
    const rel = incidentPaths.get(bug.id) as string;
    const frontmatter: Record<string, unknown> = {
      id: crypto.randomUUID(),
      legacy_id: bug.id,
      schema: 1,
      kind: "incident",
      name: bug.title,
      description: typeof bug.description === "string" ? bug.description : "",
      severity: stringOf(bug.severity) ?? "medium",
      status: stringOf(bug.status) ?? "open",
      version: 1,
      revision:
        typeof bug.revision === "number" && bug.revision > 0 ? Math.trunc(bug.revision) : 1,
      project: wikilinkFor(vaultOf(rootFile)),
      blocks: attached.map((node) => link(node.id)),
      journal: [],
      created: isoOf(bug.createdAt),
      updated: isoOf(bug.updatedAt),
      created_by: stringOf(bug.createdBy) ?? actor,
      updated_by: stringOf(bug.updatedBy) ?? actor,
      tags: ["plan/incident", `plan/severity/${String(bug.severity ?? "medium")}`],
      archived: null,
    };
    files.push({
      vaultPath: vaultOf(rel),
      relPath: rel,
      kind: "incident",
      text: planDocument(frontmatter),
    });
  }

  // Goals: formal text, steps, materialised branch.
  for (const goal of document.goals) {
    const formalText = stringOf(goal.formalText) ?? "";
    if (formalText.length === 0) {
      warnings.push(`goal '${goal.id}' skipped: it has no formalText`);
      continue;
    }
    const base = slugify(formalText.split(/[.!?\n]/)[0] ?? formalText, `goal-${goal.id.slice(0, 8)}`);
    const slug = uniqueSlug(`${project}/${GOALS_FOLDER}`, base);
    const rel = `${project}/${GOALS_FOLDER}/${slug}.md`;
    const materializedId =
      goal.materializedNodeId && paths.has(goal.materializedNodeId)
        ? goal.materializedNodeId
        : null;
    const frontmatter: Record<string, unknown> = {
      id: crypto.randomUUID(),
      legacy_id: goal.id,
      schema: 1,
      kind: "goal",
      name: formalText.length > 80 ? `${formalText.slice(0, 77)}…` : formalText,
      formal_text: formalText,
      status: stringOf(goal.status) ?? "proposed",
      version: 1,
      revision:
        typeof goal.revision === "number" && goal.revision > 0 ? Math.trunc(goal.revision) : 1,
      project: wikilinkFor(vaultOf(rootFile)),
      plan: (goal.plan ?? []).map((step, index) => ({
        id: stringOf(step.id) ?? `step-${index + 1}`,
        title: stringOf(step.title) ?? `Step ${index + 1}`,
        ...(stringOf(step.description) ? { description: stringOf(step.description) as string } : {}),
      })),
      materialized: materializedId ? link(materializedId) : null,
      journal: [],
      created: isoOf(goal.createdAt),
      updated: isoOf(goal.updatedAt),
      created_by: stringOf(goal.createdBy) ?? actor,
      updated_by: stringOf(goal.updatedBy) ?? actor,
      tags: ["plan/goal", `plan/status/${stringOf(goal.status) ?? "proposed"}`],
      archived: null,
    };
    const growth = growthBySubject.get(`goal:${goal.id}`);
    if (growth) frontmatter.growth = growthFrontmatter(growth, actor);
    files.push({
      vaultPath: vaultOf(rel),
      relPath: rel,
      kind: "goal",
      text: planDocument(frontmatter),
    });
  }

  return {
    files,
    project,
    counts: {
      nodes: order.length,
      leaves: order.filter((node) => node.kind === "leaf").length,
      incidents: document.bugs.length,
      goals: document.goals.length,
      growth: document.growth.length,
      bees: document.bees.length,
      files: files.length,
    },
    warnings,
  };
}

function growthFrontmatter(record: ExportGrowth, actor: string): Record<string, unknown> {
  return {
    status: stringOf(record.status) ?? "in_progress",
    updated: isoOf(record.updatedAt),
    updated_by: stringOf(record.updatedBy) ?? actor,
    steps: (record.steps ?? []).map((step) => {
      const facts = Array.isArray(step.facts)
        ? step.facts.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0)
        : [];
      const note = [facts.join("; "), stringOf(step.reason) ?? ""].filter((part) => part.length > 0);
      return {
        title: stringOf(step.title) ?? "Step",
        state: stringOf(step.state) ?? "planned",
        ...(note.length > 0 ? { note: note.join(" — ") } : {}),
      };
    }),
  };
}

function defaultProjectName(document: ExportDocument): string {
  const key = document.projectKey ?? "";
  const tail = key.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? "";
  return slugify(tail, "imported");
}

export function planImport(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const dryRun = input.dry_run === undefined ? true : input.dry_run !== false;
  if (!dryRun) {
    if (settings.readOnly) {
      return fail(
        "The plugin is in read-only mode: `plan_import` cannot create files. Run it with " +
          "`dry_run: true` (the default) to see the plan.",
        { reason: "read_only" },
      );
    }
  }

  const resolved = resolvePlanRoot(settings, { allowMissing: true });
  if ("reason" in resolved) return fail(resolved.error, { reason: resolved.reason });
  const rootPath = resolved.root;

  const sourcePath = stringField(input.path);
  const content = typeof input.content === "string" ? input.content : null;
  if (!sourcePath && content === null) {
    return fail(
      "Pass `path` (a `.json.zip` or `.json` inside the vault) or `content` (the JSON text " +
        "itself, for an archive the agent read from outside the vault).",
    );
  }

  let rawText = content;
  let sourceLabel = "content";
  if (rawText === null) {
    const absolute = resolveInsideVault(rootPath.vaultRoot, sourcePath as string);
    if (!absolute) {
      return fail(
        `'${sourcePath}' resolves outside the configured vault. Copy the archive into the vault, ` +
          "or pass its JSON as `content`.",
      );
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return fail(`'${sourcePath}' does not exist.`);
    }
    if (!stat.isFile()) return fail(`'${sourcePath}' is not a file.`);
    if (stat.size > MAX_ARCHIVE_BYTES) {
      return fail(`'${sourcePath}' is larger than the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB import limit.`);
    }
    const archive = readArchiveJson(fs.readFileSync(absolute), sourcePath as string);
    if ("error" in archive) return fail(archive.error);
    rawText = archive.text;
    sourceLabel = `${sourcePath}${archive.name !== sourcePath ? ` (${archive.name})` : ""}`;
  }

  const parsed = parseExportDocument(rawText);
  if ("error" in parsed) {
    return fail(parsed.error, parsed.issues ? { issues: parsed.issues } : {});
  }
  const document = parsed.document;

  const project = slugify(stringField(input.project) ?? defaultProjectName(document), "imported");
  if (project.startsWith("_")) {
    return fail("`project` cannot start with an underscore: those folders are reserved for the plan's own files.");
  }

  const includeArchived = input.include_archived !== false;
  const actor = actorOf(input);
  let planned: PlannedTree;
  try {
    planned = planTree(rootPath, document, project, includeArchived, actor);
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }

  const rootVaultPath = `${rootPath.relPath}/${planned.project}/${planned.project}.md`;
  const existingRoot = readStored(rootPath, rootVaultPath);
  let alreadyImported = false;
  if (!("error" in existingRoot)) {
    const legacy = existingRoot.document.frontmatter.legacy_id;
    const incoming = document.nodes.find((node) => node.kind === "root");
    alreadyImported = typeof legacy === "string" && legacy === incoming?.id;
    if (!alreadyImported) {
      return fail(
        `Project '${project}' already exists ('${rootVaultPath}') and was not built from this ` +
          "export. Import into a fresh project (`project`) or move the existing one aside first; " +
          "an import never overwrites a tree.",
        { project, root: rootVaultPath },
      );
    }
  }

  const report = {
    ok: true,
    dry_run: dryRun,
    action: alreadyImported ? "unchanged" : dryRun ? "planned" : "written",
    project,
    root: rootVaultPath,
    source: {
      label: sourceLabel,
      format: document.format,
      schema_version: document.schemaVersion,
      plugin_version: document.pluginVersion,
      exported_at: document.exportedAt ? isoOf(document.exportedAt) : null,
      project_key: document.projectKey ?? null,
      history_entries: document.history ? document.history.length : null,
    },
    counts: planned.counts,
    warnings: [...parsed.warnings, ...planned.warnings],
    files: planned.files.slice(0, 20).map((file) => file.relPath),
    files_truncated: Math.max(0, planned.files.length - 20),
  };

  if (alreadyImported) {
    return json({
      ...report,
      note: `This export is already imported into '${project}': every node keeps its legacy_id. Nothing was written.`,
    });
  }
  if (dryRun) {
    return json({
      ...report,
      note:
        "Dry run: nothing was written. Repeat with `dry_run: false` to create the tree, " +
        `${planned.files.length} files.`,
    });
  }
  try {
    fs.mkdirSync(rootPath.absolute, { recursive: true });
  } catch (cause) {
    return fail(
      `The planning directory '${rootPath.relPath}' could not be created: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  const now = nowIso();
  const op = typeof input.op_id === "string" && input.op_id.trim().length > 0
    ? input.op_id.trim()
    : crypto.randomUUID();
  const started = markStart(rootPath, project, op, "plan_import", rootVaultPath, actor, now);
  if (started) return fail(`Could not open the operation in the journal: ${started}`);

  const written: string[] = [];
  for (const file of planned.files) {
    const result = writeStored(rootPath, file.vaultPath, file.text, { create: true });
    if ("error" in result) {
      return fail(
        `Import stopped after ${written.length} of ${planned.files.length} files: ${result.error}. ` +
          `The journal carries \`op:start ${op}\`; repeat the call with \`op_id: "${op}"\` after ` +
          "fixing the cause, or remove the created files.",
        { op_id: op, written, planned: planned.files.length, partial: true },
      );
    }
    written.push(file.vaultPath);
  }

  const finished = markDone(
    rootPath,
    project,
    op,
    "plan_import",
    `${planned.files.length} files`,
    actor,
    nowIso(),
  );
  if (finished) {
    return fail(
      `The tree was written, but the journal could not be closed: ${finished}`,
      { partial: true, written },
    );
  }

  appendJournal(rootPath, project, {
    at: nowIso(),
    op: "plan_import",
    target: wikilinkFor(rootVaultPath),
    result: `${planned.counts.nodes} nodes · ${planned.files.length} files`,
    actor,
    ...(stringField(input.reason) ? { reason: stringField(input.reason) as string } : {}),
  });

  return json({
    ...report,
    action: "written",
    op_id: op,
    written: written.length,
    note:
      `Imported '${project}' into ${planned.files.length} files. Run \`plan_validate\` to confirm ` +
      "the tree is clean, then `plan_read` on the root.",
  });
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
