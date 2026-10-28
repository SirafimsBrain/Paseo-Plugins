// Export/import (stage 0.20.10): one JSON file carries every group,
// connection and stored secret so it can be moved to another machine
// (sshpilot-style backup). Covers bundle completeness (passwords included),
// the sealed envelope, merge/replace import round-trips, and the error paths
// a closed storage produces.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  buildExportBundle,
  importBundle,
  openBundle,
  sealBundle,
} from "../server/transfer";
import { VaultService } from "../server/vault";

const gpgAvailable = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require("node:child_process");
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "remote-control-transfer-"));
  store = new Store({ dbPath: path.join(dir, "rc.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function makeVault(name = "home"): Promise<VaultService> {
  const vault = new VaultService({ paseoHome: path.join(dir, name), autoLockMs: 0, log: () => {} });
  await vault.setup("master-pass");
  await vault.unlock("master-pass");
  return vault;
}

function seedTree(store: Store): { root: string; child: string; sshId: string; rdpId: string } {
  const root = store.createGroup({ id: "grp_root", parentId: null, name: "OMNIROUTER", sortOrder: 0 });
  const child = store.createGroup({ id: "grp_child", parentId: root.id, name: "ST4", sortOrder: 0 });
  const ssh = store.createConnection({
    id: "conn_ssh",
    groupId: child.id,
    name: "omnirouter_sirafim",
    protocol: "ssh",
    host: "omnirouter",
    port: null,
    username: "sirafim",
    payload: { extraArgs: ["-o", "ServerAliveInterval=30"], identitySecret: "connections/conn_ssh/identity" },
    secretRefs: { passwordSecret: "connections/conn_ssh/password" },
    sortOrder: 0,
  });
  const rdp = store.createConnection({
    id: "conn_rdp",
    groupId: root.id,
    name: "win-box",
    protocol: "rdp",
    host: "10.0.0.5",
    port: 3389,
    username: "admin",
    payload: { domain: "CORP" },
    secretRefs: {},
    sortOrder: 1,
  });
  return { root: root.id, child: child.id, sshId: ssh.id, rdpId: rdp.id };
}

describe("export bundle", () => {
  it("carries every connection parameter and password, but no vault paths", async () => {
    const vault = await makeVault();
    const ids = seedTree(store);
    await vault.set(`connections/${ids.sshId}/password`, "s3cret-pass");
    await vault.set(`connections/${ids.sshId}/identity`, "PRIVATE-KEY-PEM");

    const result = await buildExportBundle(store, vault, { pluginVersion: "0.20.10" });
    expect(result.encrypted).toBe(false);
    expect(result.filename).toMatch(/^remote-control-export-\d{4}-\d{2}-\d{2}\.json$/);

    const bundle = openBundle(result.content);
    expect(bundle.format).toBe(EXPORT_FORMAT);
    expect(bundle.version).toBe(EXPORT_VERSION);
    expect(bundle.pluginVersion).toBe("0.20.10");

    // Groups keep their hierarchy.
    expect(bundle.groups).toHaveLength(2);
    const root = bundle.groups.find((g) => g.name === "OMNIROUTER")!;
    const child = bundle.groups.find((g) => g.name === "ST4")!;
    expect(child.parentId).toBe(root.id);

    // Full parameter set incl. login + password + private key.
    const ssh = bundle.connections.find((c) => c.name === "omnirouter_sirafim")!;
    expect(ssh).toMatchObject({ protocol: "ssh", host: "omnirouter", port: null, username: "sirafim" });
    expect(ssh.payload).toMatchObject({ extraArgs: ["-o", "ServerAliveInterval=30"] });
    expect(ssh.secrets).toEqual({ password: "s3cret-pass", identity: "PRIVATE-KEY-PEM" });
    const rdp = bundle.connections.find((c) => c.name === "win-box")!;
    expect(rdp).toMatchObject({ protocol: "rdp", host: "10.0.0.5", port: 3389, username: "admin" });
    expect(rdp.payload).toEqual({ domain: "CORP" });

    // The file must not leak internal vault paths for secret values.
    expect(result.content).not.toContain("connections/conn_ssh/password");
    expect(result.content).toContain("s3cret-pass");

    // Secret-ref fields are stripped from the exported payload (they are
    // local vault paths, meaningless — and misleading — on another machine).
    expect(ssh.payload).not.toHaveProperty("identitySecret");
  });

  it("seals with a passphrase and only opens with it", async () => {
    const vault = await makeVault();
    const ids = seedTree(store);
    await vault.set(`connections/${ids.sshId}/password`, "s3cret-pass");

    const sealed = await buildExportBundle(store, vault, { pluginVersion: "0.20.10", passphrase: "open-sesame" });
    expect(sealed.encrypted).toBe(true);
    expect(sealed.content).not.toContain("s3cret-pass");
    const envelope = JSON.parse(sealed.content) as { encrypted: boolean; encryption: { alg: string } };
    expect(envelope.encrypted).toBe(true);
    expect(envelope.encryption.alg).toBe("aes-256-gcm");

    expect(() => openBundle(sealed.content)).toThrow(/encrypted.*passphrase/i);
    expect(() => openBundle(sealed.content, "wrong")).toThrow(/wrong passphrase/i);
    const opened = openBundle(sealed.content, "open-sesame");
    const ssh = opened.connections.find((c) => c.name === "omnirouter_sirafim")!;
    expect(ssh.secrets?.password).toBe("s3cret-pass");
  });

  it("rejects files that are not a remote-control export", () => {
    expect(() => openBundle("not json")).toThrow(/not a valid JSON/);
    expect(() => openBundle(JSON.stringify({ format: "other" }))).toThrow(/not a valid remote-control export/);
    expect(() => openBundle(JSON.stringify({ format: EXPORT_FORMAT, version: 99, encrypted: false }))).toThrow(
      /version 99/,
    );
  });

  it(gpgAvailable ? "refuses to export secrets while the storage is closed" : "skips (gpg unavailable)", async () => {
    if (!gpgAvailable) return;
    const closed = new VaultService({ paseoHome: path.join(dir, "closed-home"), autoLockMs: 0, log: () => {} });
    await closed.setup("master-pass");
    const ids = seedTree(store);
    // A password exists in the vault… but the storage is locked.
    await closed.set(`connections/${ids.sshId}/password`, "s3cret-pass");
    closed.lock();
    await expect(buildExportBundle(store, closed, { pluginVersion: "0.20.10" })).rejects.toThrow(
      /vault is locked.*Remote Control panel/,
    );
    // Nothing to resolve → a closed storage is fine.
    store.deleteConnection(ids.sshId);
    const result = await buildExportBundle(store, closed, { pluginVersion: "0.20.10" });
    expect(openBundle(result.content).connections).toHaveLength(1);
  });
});

describe("import", () => {
  it(gpgAvailable ? "round-trips into a fresh store with working passwords" : "skips (gpg unavailable)", async () => {
    if (!gpgAvailable) return;
    const sourceVault = await makeVault("source-home");
    seedTree(store);
    await sourceVault.set("connections/conn_ssh/password", "s3cret-pass");
    const exported = await buildExportBundle(store, sourceVault, {
      pluginVersion: "0.20.10",
      passphrase: "move-it",
    });

    // A different machine: fresh store, its own storage.
    const target = new Store({ dbPath: path.join(dir, "target.db") });
    const targetVault = new VaultService({ paseoHome: path.join(dir, "target-home"), autoLockMs: 0, log: () => {} });
    await targetVault.setup("another-master");
    await targetVault.unlock("another-master");
    try {
      const bundle = openBundle(exported.content, "move-it");
      const report = await importBundle(target, targetVault, bundle, { mode: "merge" });
      expect(report).toMatchObject({
        mode: "merge",
        groups: { created: 2, reused: 0 },
        connections: { created: 2, updated: 0 },
        passwords: 1,
      });

      // Hierarchy, parameters and secrets all restored.
      const groups = target.listGroups();
      const root = groups.find((g) => g.name === "OMNIROUTER")!;
      const child = groups.find((g) => g.name === "ST4")!;
      expect(child.parentId).toBe(root.id);

      const ssh = target.listConnections().find((c) => c.name === "omnirouter_sirafim")!;
      expect(ssh).toMatchObject({ protocol: "ssh", host: "omnirouter", username: "sirafim" });
      expect(ssh.groupId).toBe(child.id);
      expect(ssh.payload).toMatchObject({ extraArgs: ["-o", "ServerAliveInterval=30"] });
      expect(ssh.secretRefs.passwordSecret).toBeTruthy();
      // The password is readable straight from the target storage: the
      // connection works without re-entering credentials.
      expect(await targetVault.get(ssh.secretRefs.passwordSecret!)).toBe("s3cret-pass");

      // Re-import is idempotent under merge.
      const again = await importBundle(target, targetVault, bundle, { mode: "merge" });
      expect(again.connections).toEqual({ created: 0, updated: 2 });
      expect(again.groups.reused).toBe(2);
      expect(target.listConnections()).toHaveLength(2);
    } finally {
      target.close();
      targetVault.lock();
      sourceVault.lock();
    }
  });

  it("replace wipes existing data first, merge keeps it", async () => {
    const sourceVault = await makeVault("src2-home");
    seedTree(store);
    const exported = await buildExportBundle(store, sourceVault, { pluginVersion: "0.20.10" });

    const target = new Store({ dbPath: path.join(dir, "target2.db") });
    try {
      target.createGroup({ id: "grp_other", parentId: null, name: "unrelated", sortOrder: 0 });
      target.createConnection({
        id: "conn_other",
        groupId: "grp_other",
        name: "keep-me",
        protocol: "ssh",
        host: "keep.example.com",
        port: 22,
        username: "bob",
        payload: {},
        secretRefs: {},
      });

      const bundle = openBundle(exported.content);
      const merged = await importBundle(target, sourceVault, bundle, { mode: "merge" });
      expect(merged.groups).toEqual({ created: 2, reused: 0 });
      expect(target.listConnections().some((c) => c.name === "keep-me")).toBe(true);

      const replaced = await importBundle(target, sourceVault, bundle, { mode: "replace" });
      expect(replaced.mode).toBe("replace");
      expect(replaced.groups).toEqual({ created: 2, reused: 0 });
      expect(replaced.connections).toEqual({ created: 2, updated: 0 });
      const names = target.listConnections().map((c) => c.name).sort();
      expect(names).toEqual(["omnirouter_sirafim", "win-box"]);
      expect(target.listGroups().some((g) => g.name === "unrelated")).toBe(false);
    } finally {
      target.close();
      sourceVault.lock();
    }
  });

  it("cyclic group hierarchies are rejected instead of looping", async () => {
    const sourceVault = await makeVault("cycle-home");
    const exported = await buildExportBundle(store, sourceVault, { pluginVersion: "0.20.10" });
    const bundle = JSON.parse(exported.content);
    bundle.groups = [
      { id: "a", parentId: "b", name: "a" },
      { id: "b", parentId: "a", name: "b" },
    ];
    const target = new Store({ dbPath: path.join(dir, "cycle.db") });
    try {
      await expect(importBundle(target, null, bundle, { mode: "merge" })).rejects.toThrow(/cyclic group hierarchy/);
    } finally {
      target.close();
      sourceVault.lock();
    }
  });

  it("sealBundle output is a valid envelope for openBundle", () => {
    const json = JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, groups: [], connections: [] });
    const sealed = sealBundle(json, "pw");
    expect(openBundle(sealed, "pw").connections).toEqual([]);
  });
});
