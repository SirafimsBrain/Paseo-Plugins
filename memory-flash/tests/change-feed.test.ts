import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startChangeFeed } from "../server/changes";
import { MemoryStore } from "../server/store";
import {
  defaultProject,
  readWorkspaceNameMap,
  saveWorkspaceNameMap,
  workspaceMapPath,
} from "../server/workspace-map";

describe("change feed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the current sequence immediately, then only on a change", async () => {
    let seq = 7;
    const events: number[] = [];
    const signal = new AbortController();
    const stop = startChangeFeed(
      { changesSeq: () => seq },
      (event) => {
        events.push(event.seq);
      },
      signal.signal,
      100,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([7]);

    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual([7]);

    seq = 9;
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([7, 9]);

    signal.abort();
    seq = 11;
    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual([7, 9]);
    stop();
  });

  it("stops when the subscriber's push fails", async () => {
    let calls = 0;
    const signal = new AbortController();
    const stop = startChangeFeed(
      { changesSeq: () => 1 },
      () => {
        calls += 1;
        throw new Error("subscriber gone");
      },
      signal.signal,
      50,
    );

    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(1);
    stop();
  });
});

describe("store change log", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mf-changes-"));
    store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("advances on create, update and delete, and survives trimming", () => {
    expect(store.changesSeq()).toBe(0);

    const created = store.create({
      kind: "note",
      title: "First",
      content: "body",
      tags: [],
      project: null,
      agentId: null,
    });
    expect(store.changesSeq()).toBe(1);

    store.update(created.id, {
      kind: "note",
      title: "First",
      content: "body 2",
      tags: [],
      project: null,
      agentId: null,
      changedBy: "test",
    });
    expect(store.changesSeq()).toBe(2);

    store.delete(created.id, "test");
    expect(store.changesSeq()).toBe(3);

    // Trimming removes rows but AUTOINCREMENT keeps the sequence monotonic, so
    // a subscriber comparing numbers never sees it go backwards.
    for (let index = 0; index < 120; index += 1) {
      store.create({
        kind: "note",
        title: `Bulk ${index}`,
        content: "body",
        tags: [],
        project: null,
        agentId: null,
      });
    }
    expect(store.changesSeq()).toBe(123);
  });
});

describe("default project", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "mf-project-"));
    process.env.PASEO_HOME = home;
  });

  afterEach(() => {
    delete process.env.PASEO_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("prefers the explicit override", () => {
    expect(
      defaultProject({ MEMORY_FLASH_PROJECT: "explicit", PASEO_WORKSPACE_ID: "abc" }, "/tmp/other"),
    ).toBe("explicit");
  });

  it("uses the workspace name behind PASEO_WORKSPACE_ID", () => {
    saveWorkspaceNameMap([
      { id: "ws-1", name: "Paseo Plugins", directory: "/DISK1/projects/Paseo Plugins" },
    ]);
    expect(readWorkspaceNameMap()).toEqual({ "ws-1": "Paseo Plugins" });
    expect(defaultProject({ PASEO_WORKSPACE_ID: "ws-1" }, "/tmp/worktree-a")).toBe(
      "Paseo Plugins",
    );
  });

  it("falls back to a short workspace id, then to the directory name", () => {
    expect(defaultProject({ PASEO_WORKSPACE_ID: "0123456789abcdef" }, "/tmp/x")).toBe(
      "workspace-01234567",
    );
    expect(defaultProject({}, "/tmp/some-repo")).toBe("some-repo");
  });

  it("writes the map next to the database", () => {
    saveWorkspaceNameMap([{ id: "ws-2", name: null, directory: "/work/acme" }]);
    expect(workspaceMapPath()).toBe(
      path.join(home, "plugins", "memory-flash", "workspaces.json"),
    );
    expect(readWorkspaceNameMap()).toEqual({ "ws-2": "acme" });
  });
});
