import { afterEach, describe, expect, it } from "vitest";
import { VaultIndexer } from "../server/indexer";
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
