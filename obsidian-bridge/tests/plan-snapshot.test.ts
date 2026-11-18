import { describe, expect, it } from "vitest";
import { parsePlanDocument } from "../server/plan/frontmatter";
import {
  HISTORY_DIR,
  buildSnapshot,
  historyDirFor,
  isSnapshotFileName,
  isSnapshotFrontmatter,
  parseSnapshotFileName,
  snapshotFileName,
  snapshotPathFor,
} from "../server/plan/snapshot";
import { PLAN_FIXTURE } from "./plan-fixtures";

function frontmatterOf(vaultPath: string) {
  const result = parsePlanDocument(PLAN_FIXTURE[vaultPath]);
  if ("error" in result) throw new Error(result.error);
  return result.document.frontmatter;
}

const LEAF = "Workspaces/centurion/backend/auth/session-store.md";

describe("snapshot names", () => {
  it("writes <slug>.v<version>.r<revision>.md", () => {
    expect(snapshotFileName("session-store", 1, 4)).toBe("session-store.v1.r4.md");
    expect(snapshotFileName("auth.md", 10, 5)).toBe("auth.v10.r5.md");
  });

  it("parses the counters back", () => {
    expect(parseSnapshotFileName("session-store.v1.r4.md")).toEqual({
      slug: "session-store",
      version: 1,
      revision: 4,
    });
    expect(parseSnapshotFileName("Workspaces/centurion/__history/auth.v10.r5.md")).toEqual({
      slug: "auth",
      version: 10,
      revision: 5,
    });
  });

  it("refuses names that are not snapshots", () => {
    for (const name of ["session-store.md", "session-store.v1.md", "auth.r3.md", "auth.v0.r1.md"]) {
      expect(parseSnapshotFileName(name), name).toBeNull();
      expect(isSnapshotFileName(name), name).toBe(false);
    }
  });

  it("puts __history next to the file, not in the project root", () => {
    expect(historyDirFor(LEAF)).toBe("Workspaces/centurion/backend/auth/__history");
    expect(historyDirFor("Workspaces/centurion/centurion.md")).toBe(
      "Workspaces/centurion/__history",
    );
    expect(snapshotPathFor(LEAF, 1, 4)).toBe(
      `Workspaces/centurion/backend/auth/${HISTORY_DIR}/session-store.v1.r4.md`,
    );
  });
});

describe("buildSnapshot", () => {
  it("describes the state being replaced, not the file after the write", () => {
    const result = buildSnapshot(frontmatterOf(LEAF), {
      of: LEAF,
      reason: "content_update",
      version: 2,
      revision: 4,
      op: "5d0a1f36",
      at: "2026-11-18T11:00:00Z",
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.path).toBe(
      "Workspaces/centurion/backend/auth/__history/session-store.v2.r4.md",
    );
    expect(result.frontmatter).toMatchObject({
      id: "9a3e77c2-1d55-4b8e-8a10-77c9e0b2d431",
      kind: "leaf",
      is_snapshot: true,
      snapshot_of: LEAF,
      snapshot_reason: "content_update",
      snapshot_op: "5d0a1f36",
      version: 2,
      revision: 4,
      status: "in_progress",
      updated: "2026-11-18T11:00:00Z",
    });
    expect(result.frontmatter.name).toBe("Session store keeps refresh tokens hashed");
    expect(result.frontmatter.brief).toEqual(frontmatterOf(LEAF).brief);
    expect(isSnapshotFrontmatter(result.frontmatter)).toBe(true);
  });

  it("drops relations that would point at live documents", () => {
    const result = buildSnapshot(frontmatterOf(LEAF), {
      of: LEAF,
      reason: "status_change",
      version: 2,
      revision: 4,
    });
    if ("error" in result) throw new Error(result.error);
    for (const key of ["parent", "children", "influences", "blocked_by", "goal", "journal"]) {
      expect(result.frontmatter, key).not.toHaveProperty(key);
    }
  });

  it("writes the marker fields in a predictable order", () => {
    const result = buildSnapshot(frontmatterOf(LEAF), {
      of: LEAF,
      reason: "status_change",
      version: 2,
      revision: 4,
    });
    if ("error" in result) throw new Error(result.error);
    expect(Object.keys(result.frontmatter).slice(0, 8)).toEqual([
      "id",
      "schema",
      "kind",
      "is_snapshot",
      "snapshot_of",
      "snapshot_reason",
      "version",
      "revision",
    ]);
  });

  it("keeps the counters of a snapshot that is itself replaced", () => {
    const snapshot = frontmatterOf(
      "Workspaces/centurion/backend/auth/__history/session-store.v1.r3.md",
    );
    const result = buildSnapshot(snapshot, {
      of: LEAF,
      reason: "version_bump",
      version: 2,
      revision: 1,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.frontmatter.version).toBe(2);
    expect(result.frontmatter.revision).toBe(1);
  });

  it("refuses an unknown reason, bad counters or a missing subject", () => {
    const frontmatter = frontmatterOf(LEAF);
    const base = { of: LEAF, reason: "status_change" as const, version: 2, revision: 4 };
    for (const input of [
      { ...base, reason: "because" as never },
      { ...base, version: 0 },
      { ...base, revision: -1 },
      { ...base, of: " " },
      { ...base, of: "Workspaces/centurion" },
    ]) {
      expect("error" in buildSnapshot(frontmatter, input), JSON.stringify(input)).toBe(true);
    }
  });
});
