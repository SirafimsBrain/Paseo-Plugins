import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultIndexer } from "../server/indexer";
import { indexPathFor } from "../server/paths";
import { BridgeStore } from "../server/store";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const workspaces: TestWorkspace[] = [];
const indexers: VaultIndexer[] = [];

afterEach(async () => {
  while (indexers.length > 0) await indexers.pop()?.stop();
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

describe("VaultIndexer", () => {
  it("stays idle until a vault path is configured", async () => {
    const created = makeWorkspace({});
    workspaces.push(created);
    const indexer = new VaultIndexer(async () => runtimeSettings(""));
    indexers.push(indexer);
    await indexer.start();

    const status = indexer.status();
    expect(status.configured).toBe(false);
    expect(status.indexedNotes).toBe(0);
    expect(status.error).toBeNull();
    expect(await indexer.scanNow()).toBeNull();
  });

  it("indexes the vault, then picks up added, changed and removed notes", async () => {
    const created = makeWorkspace({
      "A.md": "# A\n\nalpha content\n",
      "Folder/B.md": "# B\n\nbeta content [[A]]\n",
    });
    workspaces.push(created);
    const indexer = new VaultIndexer(async () => runtimeSettings(created.vault));
    indexers.push(indexer);
    await indexer.start();

    expect(indexer.status()).toMatchObject({
      configured: true,
      vaultExists: true,
      indexedNotes: 2,
    });

    created.write("Folder/B.md", "# B\n\nbeta content changed [[A]]\n");
    created.write("C.md", "# C\n\ngamma\n");
    created.remove("A.md");
    const outcome = await indexer.scanNow();
    expect(outcome).not.toBeNull();
    expect(outcome?.removed).toBe(1);
    expect(indexer.status().indexedNotes).toBe(2);
  });

  it("reports a clear error for a path that is not a directory", async () => {
    const created = makeWorkspace({ "A.md": "# A\n" });
    workspaces.push(created);
    const indexer = new VaultIndexer(async () => runtimeSettings(`${created.vault}/missing`));
    indexers.push(indexer);
    await indexer.start();

    const status = indexer.status();
    expect(status.vaultExists).toBe(false);
    expect(status.error).toContain("not a readable directory");
  });

  it("never indexes planning history or the archive", async () => {
    const created = makeWorkspace({
      "Workspaces/centurion/centurion.md": "# Centurion\n",
      "Workspaces/centurion/__history/centurion.v1.r1.md": "# Snapshot\n",
      "Workspaces/_archive/old/old.md": "# Archived\n",
    });
    workspaces.push(created);
    const indexer = new VaultIndexer(async () => runtimeSettings(created.vault));
    indexers.push(indexer);
    await indexer.start();

    expect(indexer.status().indexedNotes).toBe(1);
    const outcome = await indexer.scanNow();
    expect(outcome?.skipped).toBe(0);
    expect(indexer.status().indexedNotes).toBe(1);
  });

  it("drops and re-adds notes after a folder rename and a move into _archive", async () => {
    const created = makeWorkspace({
      "Folder/A.md": "# A\n\nalpha\n",
      "Folder/Sub/B.md": "# B\n\nbeta\n",
      "Other/C.md": "# C\n\ngamma\n",
    });
    workspaces.push(created);
    const indexer = new VaultIndexer(async () => runtimeSettings(created.vault));
    indexers.push(indexer);
    await indexer.start();
    expect(indexer.status()).toMatchObject({ indexedNotes: 3, watching: true });

    // A read-only second connection: the indexer owns the writing one.
    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    const indexedPaths = () => store.listNoteFiles().map((row) => row.path);
    const until = async (predicate: () => boolean, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`index did not catch up; paths: ${indexedPaths().join(", ")}`);
    };

    try {
      // Renaming the folder: the watcher reports a directory, not a note.
      fs.renameSync(path.join(created.vault, "Folder"), path.join(created.vault, "Renamed"));
      await until(
        () =>
          indexedPaths().includes("Renamed/A.md") &&
          indexedPaths().includes("Renamed/Sub/B.md") &&
          !indexedPaths().some((entry) => entry.startsWith("Folder/")),
      );
      expect(indexer.status().indexedNotes).toBe(3);

      // Moving a note into `_archive`: it must leave the index, not linger.
      fs.mkdirSync(path.join(created.vault, "_archive"), { recursive: true });
      fs.renameSync(path.join(created.vault, "Other"), path.join(created.vault, "_archive/Other"));
      await until(
        () =>
          !indexedPaths().some((entry) => entry.startsWith("_archive/")) &&
          !indexedPaths().includes("Other/C.md"),
      );
      expect(indexer.status().indexedNotes).toBe(2);
    } finally {
      store.close();
    }
  });

  it("respects include folders when scanning", async () => {
    const created = makeWorkspace({
      "Projects/one.md": "# One\n",
      "Archive/two.md": "# Two\n",
    });
    workspaces.push(created);
    const indexer = new VaultIndexer(async () =>
      runtimeSettings(created.vault, { includeFolders: "Projects" }),
    );
    indexers.push(indexer);
    await indexer.start();

    expect(indexer.status().indexedNotes).toBe(1);
  });
});
