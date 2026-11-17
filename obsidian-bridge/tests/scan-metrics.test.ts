import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { VaultIndexer } from "../server/indexer";
import { MAX_NOTE_BYTES } from "../server/vault";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * 0.10.11: a scan reports what it skipped, and the indexer exposes the last scan
 * and the time of the last full sync, so `obsidian_status` can answer "why are
 * these notes missing?".
 */

const workspaces: TestWorkspace[] = [];
const indexers: VaultIndexer[] = [];

afterEach(async () => {
  while (indexers.length > 0) await indexers.pop()?.stop();
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

describe("scan metrics", () => {
  it("counts a note over the size limit as skipped and reports the full sync", async () => {
    const created = makeWorkspace({ "A.md": "# A\n\nalpha\n" });
    workspaces.push(created);
    const oversized = path.join(created.vault, "Huge.md");
    fs.writeFileSync(oversized, `# Huge\n\n${"x".repeat(MAX_NOTE_BYTES + 1)}`);

    const indexer = new VaultIndexer(async () => runtimeSettings(created.vault));
    indexers.push(indexer);
    await indexer.start();

    const outcome = await indexer.scanNow();
    expect(outcome).not.toBeNull();
    expect(outcome?.skipped).toBe(1);
    expect(outcome?.full).toBe(true);

    const status = indexer.status();
    expect(status.scan).toMatchObject({ full: true, skipped: 1, scanned: 0 });
    expect(status.scan.tookMs).toBeGreaterThanOrEqual(0);
    expect(status.lastFullScanAt).not.toBeNull();
    expect(status.indexedNotes).toBe(1);
  });

  it("keeps the full-sync timestamp across a restart", async () => {
    const created = makeWorkspace({ "A.md": "# A\n" });
    workspaces.push(created);
    const first = new VaultIndexer(async () => runtimeSettings(created.vault));
    await first.start();
    const recorded = first.status().lastFullScanAt;
    await first.stop();

    const second = new VaultIndexer(async () => runtimeSettings(created.vault));
    indexers.push(second);
    await second.start();
    // The start-up scan is a full one, so the timestamp is refreshed and still
    // persists as a real ISO time (it used to be lost with the process).
    expect(recorded).not.toBeNull();
    const restarted = second.status().lastFullScanAt;
    expect(restarted).not.toBeNull();
    expect(Number.isNaN(Date.parse(restarted as string))).toBe(false);
    expect(Date.parse(restarted as string)).toBeGreaterThanOrEqual(Date.parse(recorded as string));
  });
});
