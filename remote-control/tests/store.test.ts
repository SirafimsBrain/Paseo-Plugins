import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store";

let tmp: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-store-"));
  dbPath = path.join(tmp, "test.db");
  store = new Store({ dbPath });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("store schema", () => {
  it("reports schema version 1", () => {
    expect(store.schemaVersion()).toBe(1);
  });

  it("reopens an existing database without losing data", () => {
    store.createGroup({ id: "g1", parentId: null, name: "Root" });
    store.close();
    const reopened = new Store({ dbPath });
    expect(reopened.getGroup("g1")?.name).toBe("Root");
    reopened.close();
  });
});

describe("groups", () => {
  it("creates and lists groups", () => {
    store.createGroup({ id: "g1", parentId: null, name: "Servers" });
    store.createGroup({ id: "g2", parentId: "g1", name: "Prod" });
    const groups = store.listGroups();
    expect(groups.map((g) => g.name)).toContain("Servers");
    expect(store.getGroup("g2")?.parentId).toBe("g1");
  });

  it("updates and archives groups", () => {
    store.createGroup({ id: "g1", parentId: null, name: "Old" });
    const updated = store.updateGroup("g1", { name: "New" });
    expect(updated?.name).toBe("New");
    expect(store.archiveGroup("g1")).toBe(true);
    expect(store.listGroups().find((g) => g.id === "g1")).toBeUndefined();
  });

  it("deletes groups", () => {
    store.createGroup({ id: "g1", parentId: null, name: "X" });
    expect(store.deleteGroup("g1")).toBe(true);
    expect(store.getGroup("g1")).toBeNull();
  });
});

describe("connections", () => {
  it("creates and lists connections", () => {
    store.createGroup({ id: "g1", parentId: null, name: "G" });
    const c = store.createConnection({
      id: "c1",
      groupId: "g1",
      name: "web",
      protocol: "ssh",
      host: "example.com",
      port: 2222,
      username: "root",
      payload: { extraArgs: ["-v"] },
      secretRefs: { passwordSecret: "remote-control/c1/password" },
    });
    expect(c.protocol).toBe("ssh");
    expect(c.port).toBe(2222);
    expect(store.listConnections("g1")).toHaveLength(1);
    expect(store.listConnections(null)).toHaveLength(0);
  });

  it("filters connections by group and root", () => {
    store.createGroup({ id: "g1", parentId: null, name: "G" });
    store.createConnection({ id: "r1", groupId: null, name: "root-conn", protocol: "ssh", host: "h", port: null });
    store.createConnection({ id: "g1c", groupId: "g1", name: "g-conn", protocol: "ssh", host: "h2", port: null });
    expect(store.listConnections(null).map((c) => c.id)).toContain("r1");
    expect(store.listConnections("g1").map((c) => c.id)).toContain("g1c");
  });

  it("updates and archives connections", () => {
    store.createConnection({ id: "c1", groupId: null, name: "c", protocol: "ssh", host: "h", port: 22 });
    const updated = store.updateConnection("c1", { host: "h2", port: 2222, payload: { x: 1 } });
    expect(updated?.host).toBe("h2");
    expect(updated?.port).toBe(2222);
    expect(updated?.payload).toEqual({ x: 1 });
    expect(store.archiveConnection("c1")).toBe(true);
    expect(store.listConnections().find((c) => c.id === "c1")).toBeUndefined();
  });

  it("deletes connections", () => {
    store.createConnection({ id: "c1", groupId: null, name: "c", protocol: "ssh", host: "h", port: 22 });
    expect(store.deleteConnection("c1")).toBe(true);
    expect(store.getConnection("c1")).toBeNull();
  });
});

describe("settings", () => {
  it("stores and retrieves settings", () => {
    store.setSetting("foo", "bar");
    expect(store.getSetting("foo")).toBe("bar");
    store.setSetting("foo", "baz");
    expect(store.getSetting("foo")).toBe("baz");
    expect(store.getSetting("missing")).toBeNull();
  });
});