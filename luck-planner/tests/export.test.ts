import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  exportCounts,
  exportEntryName,
  exportFileName,
  exportStamp,
  parseExport,
  projectSlug,
  serializeExport,
} from "../shared/export";
import {
  assertExportable,
  buildExportDocument,
  defaultBackupDir,
  exportZipBytes,
  writeExportFile,
} from "../server/export";
import { LuckPlannerStore } from "../server/store";
import type { Node } from "../shared/tree";

/**
 * Stage L2 acceptance: one project leaves the plugin as a single
 * `.json.zip` — a document an importer can read back, an archive every
 * desktop opens, and bytes that do not change because a clock moved.
 *
 * Real SQLite files in a temp directory, no mocks, like every store test.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const ACTOR = "agent:coder";
/** Fixed clock: the archive's name and `mtime` must not depend on "now". */
const AT = Date.UTC(2026, 10, 4, 13, 20, 55);

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-export-"));
  dirs.push(dir);
  return dir;
}

function openStore(): LuckPlannerStore {
  const store = new LuckPlannerStore({
    dbPath: path.join(tempDir(), "luck-planner.db"),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** root → trunk → branch → (leafA, leafB), plus a bee, a bug and growth. */
function seed(store: LuckPlannerStore): { leafA: Node; leafB: Node } {
  const root = store.createNode({
    projectKey: P,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor: ACTOR,
  });
  const trunk = store.createNode({
    projectKey: P,
    parentId: root.id,
    kind: "trunk",
    name: "Platform",
    actor: ACTOR,
  });
  const branch = store.createNode({
    projectKey: P,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor: ACTOR,
  });
  const leafA = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    description: "queue retries with backoff",
    payload: { plan: "retry on 5xx", fact: "backoff is 1s/2s/4s" },
    actor: ACTOR,
  });
  const leafB = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "prorate refunds",
    actor: ACTOR,
  });
  store.createBee({
    projectKey: P,
    sourceLeafId: leafA.id,
    targetLeafId: leafB.id,
    impact: "refund proration depends on retry outcome",
    actor: ACTOR,
  });
  store.createBug({
    projectKey: P,
    title: "webhook 500s",
    severity: "high",
    nodeIds: [leafA.id],
    actor: ACTOR,
  });
  store.createGoal({
    projectKey: P,
    formalText: "Charges retry without duplicating refunds",
    plan: [
      { id: "s1", title: "spec", description: "define the retry window" },
      { id: "s2", title: "code", description: "implement the queue" },
    ],
    actor: ACTOR,
  });
  store.createGrowth({
    projectKey: P,
    subjectType: "node",
    subjectId: leafA.id,
    steps: [
      { id: "g1", title: "spec", state: "completed", facts: [], reason: "" },
      { id: "g2", title: "code", state: "pending", facts: [], reason: "" },
    ],
    actor: ACTOR,
  });
  return { leafA, leafB };
}

function build(store: LuckPlannerStore, includeHistory?: boolean) {
  return buildExportDocument(store, {
    projectKey: P,
    pluginVersion: "0.42.0",
    exportedAt: AT,
    ...(includeHistory === undefined ? {} : { includeHistory }),
  });
}

describe("export document", () => {
  it("carries the whole project: nodes, links, incidents, goals, growth, history", () => {
    const store = openStore();
    seed(store);
    const document = build(store);

    expect(document.format).toBe(EXPORT_FORMAT);
    expect(document.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(document.projectKey).toBe(P);
    expect(document.pluginVersion).toBe("0.42.0");
    expect(document.exportedAt).toBe(AT);
    // `listNodes` orders by `created_at, id`; five rows created in the same
    // millisecond fall back to id order, so compare the set, not a sequence.
    expect(document.nodes.map((node) => node.name).sort()).toEqual([
      "Platform",
      "Tech stack",
      "billing",
      "prorate refunds",
      "retry failed charges",
    ]);
    expect(document.bees).toHaveLength(1);
    expect(document.bugs.map((bug) => bug.title)).toEqual(["webhook 500s"]);
    expect(document.bugAttachments).toHaveLength(1);
    expect(document.goals).toHaveLength(1);
    expect(document.growth).toHaveLength(1);
    expect(document.history?.length ?? 0).toBeGreaterThan(0);
    expect(exportCounts(document)).toEqual({
      nodes: 5,
      archivedNodes: 0,
      bees: 1,
      bugs: 1,
      goals: 1,
      growth: 1,
      history: document.history?.length,
    });
  });

  it("keeps archived nodes and flags them instead of dropping them", () => {
    const store = openStore();
    const { leafA } = seed(store);
    store.archiveNode({ projectKey: P, id: leafA.id, actor: ACTOR });

    const document = build(store);
    const archived = document.nodes.filter((node) => node.archivedAt !== null);
    expect(archived.map((node) => node.name)).toEqual(["retry failed charges"]);
    expect(exportCounts(document).archivedNodes).toBe(1);
  });

  it("omits the audit trail on request", () => {
    const store = openStore();
    seed(store);
    const document = build(store, false);
    expect(document).not.toHaveProperty("history");
    expect(exportCounts(document).history).toBeNull();
  });

  it("round-trips through JSON unchanged", () => {
    const store = openStore();
    seed(store);
    const document = build(store);
    const parsed = parseExport(serializeExport(document));
    expect(parsed).toEqual(document);
  });

  it("refuses documents that are not exports, naming the reason", () => {
    expect(() => parseExport("{ not json")).toThrow(/not a JSON document/);
    expect(() => parseExport(JSON.stringify({ hello: "world" }))).toThrow(
      /not a luck-planner export: format/,
    );
    const store = openStore();
    seed(store);
    const document = build(store);
    expect(() =>
      parseExport(JSON.stringify({ ...document, schemaVersion: 99 })),
    ).toThrow(/schemaVersion/);
    expect(() =>
      parseExport(
        JSON.stringify({
          ...document,
          nodes: [{ ...document.nodes[0], kind: "planet" }],
        }),
      ),
    ).toThrow(/nodes\.0\.kind/);
  });
});

describe("export archive", () => {
  it("is a real zip with one JSON entry that parses back", () => {
    const store = openStore();
    seed(store);
    const document = build(store);
    const bytes = exportZipBytes(document);

    // PK\x03\x04 — the local file header of every zip.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const entries = unzipSync(bytes);
    const names = Object.keys(entries);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^luck-planner-demo-\d{8}-\d{6}\.json$/);
    expect(parseExport(strFromU8(entries[names[0]]))).toEqual(document);
  });

  it("compresses the same document to the same bytes", () => {
    const store = openStore();
    seed(store);
    const document = build(store);
    expect(exportZipBytes(document)).toEqual(exportZipBytes(document));
  });

  it("names the archive from the project slug and the local timestamp", () => {
    expect(projectSlug("/projects/demo")).toBe("demo");
    expect(projectSlug("/home/me/dev/Paseo Plugins/")).toBe("paseo-plugins");
    expect(projectSlug("/")).toBe("project");
    expect(projectSlug("/projects/Проект")).toBe("project");
    expect(projectSlug(`/${"x".repeat(80)}`)).toHaveLength(40);

    const name = exportFileName(P, AT);
    expect(name).toMatch(/^luck-planner-demo-\d{8}-\d{6}\.json\.zip$/);
    expect(name).toContain(exportStamp(AT));
    expect(exportEntryName(name)).toBe(name.slice(0, -4));
    expect(exportEntryName("plain.json")).toBe("plain.json");
  });
});

describe("writing an export", () => {
  it("lands in backups/ beside the database by default", () => {
    const store = openStore();
    seed(store);
    const result = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.42.0",
      exportedAt: AT,
    });

    expect(result.file).toBe(
      path.join(defaultBackupDir(store.dbPath), exportFileName(P, AT)),
    );
    expect(result.file.startsWith(tempDirPrefix(store.dbPath))).toBe(true);
    const written = readFileSync(result.file);
    expect(written.byteLength).toBe(result.bytes);
    const entry = exportEntryName(path.basename(result.file));
    expect(parseExport(strFromU8(unzipSync(written)[entry]))).toMatchObject({
      projectKey: P,
    });
  });

  it("never overwrites: a second export in the same second gets a suffix", () => {
    const store = openStore();
    seed(store);
    const first = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.42.0",
      exportedAt: AT,
    });
    const second = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.42.0",
      exportedAt: AT,
    });
    expect(second.file).not.toBe(first.file);
    expect(path.basename(second.file)).toMatch(/-2\.json\.zip$/);
  });

  it("writes to an absolute path the caller names", () => {
    const store = openStore();
    seed(store);
    const file = path.join(tempDir(), "nested", "copy.json.zip");
    const result = writeExportFile(store, {
      projectKey: P,
      pluginVersion: "0.42.0",
      exportedAt: AT,
      file,
    });
    expect(result.file).toBe(file);
    expect(readFileSync(file).byteLength).toBe(result.bytes);
  });

  it("refuses a relative path and an existing file", () => {
    const store = openStore();
    seed(store);
    expect(() =>
      writeExportFile(store, {
        projectKey: P,
        pluginVersion: "0.42.0",
        file: "export.json.zip",
      }),
    ).toThrow(/must be absolute/);

    const taken = path.join(tempDir(), "taken.json.zip");
    writeFileSync(taken, "x");
    expect(() =>
      writeExportFile(store, {
        projectKey: P,
        pluginVersion: "0.42.0",
        file: taken,
      }),
    ).toThrow(/refusing to overwrite/);
  });

  it("refuses a project with no nodes — a typo, not an empty backup", () => {
    const store = openStore();
    seed(store);
    const empty = buildExportDocument(store, {
      projectKey: "/projects/typo",
      pluginVersion: "0.42.0",
      exportedAt: AT,
    });
    expect(() => assertExportable(empty)).toThrow(/has no nodes to export/);
    expect(() =>
      writeExportFile(store, {
        projectKey: "/projects/typo",
        pluginVersion: "0.42.0",
      }),
    ).toThrow(/has no nodes to export/);
  });
});

/** Directory holding a store's database — the default backup dir's parent. */
function tempDirPrefix(dbPath: string): string {
  return `${path.dirname(dbPath)}${path.sep}`;
}
