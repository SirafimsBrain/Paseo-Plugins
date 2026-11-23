import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { parsePlanDocument } from "../server/plan/frontmatter";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/*
 * A real `luck_tree_export` document, one node of each shape the import has to
 * rebuild: root → trunk → branch → leaves, an influence bee, a bug with an
 * attachment, a goal with a plan and a materialised branch, a growth record and
 * one archived leaf.
 */
const ROOT = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7700";
const TRUNK = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7701";
const BRANCH = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7702";
const LEAF_A = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7703";
const LEAF_B = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7704";
const LEAF_OLD = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7705";
const BUG = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7706";
const GOAL = "6f1c2a90-4b1e-4f0a-9d33-2f0f4c1e7707";
const createdAt = Date.UTC(2026, 9, 1, 9);

function node(
  id: string,
  parentId: string | null,
  kind: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    projectKey: "/home/user/projects/helios",
    parentId,
    kind,
    name,
    description: `${name} in one line`,
    status: kind === "leaf" ? "ready" : "in_progress",
    version: "0.9",
    revision: 3,
    payload: {},
    createdAt,
    updatedAt: createdAt,
    createdBy: "user",
    updatedBy: "codex",
    archivedAt: null,
    ...extra,
  };
}

function exportDocument(): Record<string, unknown> {
  return {
    format: "luck-planner-export",
    schemaVersion: 1,
    pluginVersion: "0.51.0",
    exportedAt: Date.UTC(2026, 10, 10, 12),
    projectKey: "/home/user/projects/helios",
    nodes: [
      node(ROOT, null, "root", "Helios"),
      node(TRUNK, ROOT, "trunk", "Sessions"),
      node(BRANCH, TRUNK, "branch", "Storage"),
      node(LEAF_A, BRANCH, "leaf", "Session store"),
      node(LEAF_B, BRANCH, "leaf", "Token refresh"),
      node(LEAF_OLD, BRANCH, "leaf", "Old cache", {
        archivedAt: Date.UTC(2026, 9, 20, 9),
        status: "superseded",
      }),
    ],
    bees: [
      {
        id: "be000000-0000-4000-8000-000000000001",
        projectKey: "/home/user/projects/helios",
        sourceLeafId: LEAF_A,
        targetLeafId: LEAF_B,
        status: "active",
        revision: 2,
        impact: "the store owns the token rows",
        createdAt,
        updatedAt: createdAt,
        createdBy: "user",
        updatedBy: "user",
      },
    ],
    bugs: [
      {
        id: BUG,
        projectKey: "/home/user/projects/helios",
        title: "Session loss on restart",
        description: "The table is recreated on boot.",
        severity: "high",
        status: "open",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        createdBy: "codex",
        updatedBy: "codex",
      },
    ],
    bugAttachments: [{ bugId: BUG, nodeId: LEAF_B }],
    goals: [
      {
        id: GOAL,
        projectKey: "/home/user/projects/helios",
        formalText: "Sessions survive a restart",
        plan: [
          { id: "step-1", title: "Move the session table", description: "A migration." },
          { id: "step-2", title: "Restore on boot", description: "" },
        ],
        status: "proposed",
        revision: 2,
        materializedNodeId: TRUNK,
        createdAt,
        updatedAt: createdAt,
        createdBy: "user",
        updatedBy: "codex",
      },
    ],
    growth: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        projectKey: "/home/user/projects/helios",
        subjectType: "node",
        subjectId: LEAF_A,
        steps: [
          {
            id: "g-1",
            title: "Read the storage docs",
            state: "done",
            facts: ["sqlite wal"],
            reason: "",
          },
        ],
        status: "in_progress",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        createdBy: "codex",
        updatedBy: "codex",
      },
    ],
    history: [{ id: "h-1" }],
  };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A one-entry zip, the shape `exportZipBytes` writes. */
function zipOf(name: string, text: string): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const compressed = zlib.deflateRawSync(payload);
  const nameBytes = Buffer.from(name, "utf-8");
  const checksum = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBytes.length + compressed.length;
  const cdSize = central.length + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

const workspaces: TestWorkspace[] = [];

function workspace(extra: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace(extra);
  workspaces.push(created);
  return created;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function expectOk(outcome: { isError?: boolean; text: string }) {
  if (outcome.isError) throw new Error(outcome.text);
}

async function call(
  created: TestWorkspace,
  name: string,
  input: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return dispatchTool(name, input, runtimeSettings(created.vault, overrides));
}

function documentOf(created: TestWorkspace, relPath: string) {
  const parsed = parsePlanDocument(
    fs.readFileSync(path.join(created.vault, relPath), "utf-8"),
  );
  if ("error" in parsed) throw new Error(`${relPath}: ${parsed.error}`);
  return parsed.document;
}

const EXPORT_JSON = JSON.stringify(exportDocument());

describe("plan_import", () => {
  it("is a dry run by default: it answers the plan and writes nothing", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_import", { content: EXPORT_JSON });
    expectOk(outcome);
    const result = outcome.structuredContent as {
      dry_run: boolean;
      action: string;
      project: string;
      counts: { files: number; nodes: number; incidents: number; goals: number };
      files: string[];
    };
    expect(result.dry_run).toBe(true);
    expect(result.action).toBe("planned");
    expect(result.project).toBe("helios");
    expect(result.counts.files).toBeGreaterThanOrEqual(8);
    expect(result.files).toContain("helios/sessions/storage/session-store.md");
    expect(fs.existsSync(path.join(created.vault, "Workspaces/helios/helios.md"))).toBe(false);
  });

  it("rebuilds the tree, the links, the incident, the goal and the growth", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_import", {
      content: EXPORT_JSON,
      dry_run: false,
    });
    expectOk(outcome);
    expect((outcome.structuredContent as { action: string }).action).toBe("written");

    const root = documentOf(created, "Workspaces/helios/helios.md");
    expect(root.frontmatter.legacy_id).toBe(ROOT);
    expect(root.frontmatter.children).toEqual([
      "[[Workspaces/helios/sessions/sessions|sessions]]",
    ]);

    // The bee lives on the source leaf and points at the target.
    const leafA = documentOf(created, "Workspaces/helios/sessions/storage/session-store.md");
    expect(leafA.frontmatter.legacy_id).toBe(LEAF_A);
    expect(leafA.frontmatter.influences).toEqual([
      expect.objectContaining({
        target: "[[Workspaces/helios/sessions/storage/token-refresh|token-refresh]]",
      }),
    ]);
    // Growth travels onto its subject.
    expect(leafA.frontmatter.growth).toMatchObject({
      status: "in_progress",
      steps: [expect.objectContaining({ title: "Read the storage docs", state: "done" })],
    });

    // The bug's attachment becomes blocked_by on the leaf and blocks on the incident.
    const leafB = documentOf(created, "Workspaces/helios/sessions/storage/token-refresh.md");
    expect(leafB.frontmatter.blocked_by).toEqual([
      "[[Workspaces/helios/_incidents/session-loss-on-restart|session-loss-on-restart]]",
    ]);
    const incident = documentOf(created, "Workspaces/helios/_incidents/session-loss-on-restart.md");
    expect(incident.frontmatter).toMatchObject({
      kind: "incident",
      severity: "high",
      status: "open",
      legacy_id: BUG,
    });
    expect(incident.frontmatter.blocks).toEqual([
      "[[Workspaces/helios/sessions/storage/token-refresh|token-refresh]]",
    ]);

    // The goal keeps its steps and points at the materialised branch.
    const goal = documentOf(created, "Workspaces/helios/_goals/sessions-survive-a-restart.md");
    expect(goal.frontmatter.plan).toHaveLength(2);
    expect(goal.frontmatter.materialized).toBe(
      "[[Workspaces/helios/sessions/sessions|sessions]]",
    );

    // The archived leaf came along, flagged rather than dropped.
    const old = documentOf(created, "Workspaces/helios/sessions/storage/old-cache.md");
    expect(old.frontmatter.archived).toBeTruthy();
  });

  it("produces a tree that plan_validate accepts", async () => {
    const created = workspace();
    const imported = await call(created, "plan_import", {
      content: EXPORT_JSON,
      dry_run: false,
    });
    expectOk(imported);

    const outcome = await call(created, "plan_validate", { project: "helios" });
    expectOk(outcome);
    const result = outcome.structuredContent as { valid: boolean; issues: unknown[] };
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is idempotent by legacy_id: the second import writes nothing", async () => {
    const created = workspace();
    const first = await call(created, "plan_import", {
      content: EXPORT_JSON,
      dry_run: false,
    });
    expectOk(first);
    const files = fs.readdirSync(path.join(created.vault, "Workspaces/helios"));
    const before = fs.readFileSync(
      path.join(created.vault, "Workspaces/helios/helios.md"),
      "utf-8",
    );

    const second = await call(created, "plan_import", {
      content: EXPORT_JSON,
      dry_run: false,
    });
    expectOk(second);
    const result = second.structuredContent as { action: string; note: string };
    expect(result.action).toBe("unchanged");
    expect(result.note).toMatch(/already imported/i);
    expect(fs.readdirSync(path.join(created.vault, "Workspaces/helios"))).toEqual(files);
    expect(
      fs.readFileSync(path.join(created.vault, "Workspaces/helios/helios.md"), "utf-8"),
    ).toBe(before);
  });

  it("refuses a project that already holds a different tree", async () => {
    const created = workspace();
    created.write("Workspaces/centurion/centurion.md", "# taken\n");
    const outcome = await call(created, "plan_import", {
      content: EXPORT_JSON,
      dry_run: false,
      project: "centurion",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/already exists/i);
  });

  it("reads the archive a real export writes (.json.zip)", async () => {
    const created = workspace();
    fs.mkdirSync(path.join(created.vault, "exports"), { recursive: true });
    fs.writeFileSync(
      path.join(created.vault, "exports/helios.json.zip"),
      zipOf("export.json", EXPORT_JSON),
    );
    const outcome = await call(created, "plan_import", {
      path: "exports/helios.json.zip",
      dry_run: false,
    });
    expectOk(outcome);
    expect((outcome.structuredContent as { source: { label: string } }).source.label).toContain(
      "helios.json.zip",
    );
    expect(
      fs.existsSync(path.join(created.vault, "Workspaces/helios/sessions/storage/session-store.md")),
    ).toBe(true);
  });

  it("honours include_archived: false and says what it skipped", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_import", {
      content: EXPORT_JSON,
      dry_run: false,
      include_archived: false,
    });
    expectOk(outcome);
    const result = outcome.structuredContent as { warnings: string[] };
    expect(result.warnings.join(" ")).toMatch(/archived node/);
    expect(
      fs.existsSync(path.join(created.vault, "Workspaces/helios/sessions/storage/old-cache.md")),
    ).toBe(false);
  });

  it("refuses a file that is not a luck-planner export", async () => {
    const created = workspace();
    const outcome = await call(created, "plan_import", {
      content: JSON.stringify({ format: "something-else", nodes: [] }),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/not a luck-planner export/);
  });

  it("refuses to write in read-only mode but still answers a dry run", async () => {
    const created = workspace();
    const write = await call(created, "plan_import", {
      content: EXPORT_JSON,
      dry_run: false,
    }, { readOnly: true });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/read-only/i);

    const dry = await call(created, "plan_import", { content: EXPORT_JSON }, { readOnly: true });
    expectOk(dry);
    expect((dry.structuredContent as { dry_run: boolean }).dry_run).toBe(true);
  });
});
