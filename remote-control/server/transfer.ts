// Export / import of connections with their secrets (stage 0.20.10), the
// customer's reference being sshpilot's backup: one JSON file that carries
// every parameter of every connection — groups, protocol payload, username
// and password — so it can be moved to another machine and imported there
// with working logins, without hunting for credentials by hand.
//
// The plaintext bundle is JSON; with a passphrase it is sealed into an
// AES-256-GCM envelope keyed by scrypt(passphrase, salt). Secrets are
// resolved from the vault at export time (so the storage must be open when
// there is anything to export) and re-written under freshly generated
// connection ids at import time — the database never contains values, and
// the file never contains vault paths.

import * as crypto from "node:crypto";
import { z } from "zod";
import { getProtocol } from "../shared/protocols";
import type { Connection } from "../shared/connections";
import type { Store } from "./store";
import type { VaultService } from "./vault";

export const EXPORT_FORMAT = "remote-control-export";
export const EXPORT_VERSION = 1;

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

// ---------- schema ----------

const exportGroupSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable().optional(),
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
});

const exportConnectionSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().nullable().optional(),
  name: z.string().min(1),
  protocol: z.enum(["ssh", "rdp", "vnc"]),
  host: z.string().min(1),
  port: z.number().int().nullable().optional(),
  username: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
  /** Semantic secret names → plaintext values, e.g. { password: "…" }. */
  secrets: z.record(z.string(), z.string()).optional(),
});

export const exportBundleSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().optional(),
  pluginVersion: z.string().optional(),
  encrypted: z.boolean().optional(),
  groups: z.array(exportGroupSchema).default([]),
  connections: z.array(exportConnectionSchema).default([]),
});
export type ExportBundle = z.infer<typeof exportBundleSchema>;

const envelopeSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int(),
  encrypted: z.literal(true),
  encryption: z.object({
    alg: z.literal("aes-256-gcm"),
    kdf: z.literal("scrypt"),
    salt: z.string().min(1),
    iv: z.string().min(1),
  }),
  data: z.string().min(1),
  tag: z.string().min(1),
});

/** Semantic secret name → connection.secretRefs field. */
const SECRET_REF_FIELD: Record<string, string> = {
  password: "passwordSecret",
  identity: "identitySecret",
};

function secretFieldSemantic(field: string): string {
  if (field === "passwordSecret") return "password";
  if (field === "identitySecret") return "identity";
  return field;
}

function stripSecretFields(payload: Record<string, unknown>, secretFields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const field of secretFields) delete out[field];
  return out;
}

function connectionKey(c: { protocol: string; host: string; port?: number | null; username?: string; name: string }): string {
  return [c.protocol, c.host, c.port ?? "", c.username ?? "", c.name].join("\u0000");
}

// ---------- export ----------

export interface ExportResult {
  /** Suggested download filename. */
  filename: string;
  /** File contents (plaintext or sealed JSON). */
  content: string;
  encrypted: boolean;
}

export async function buildExportBundle(
  store: Store,
  vault: VaultService | null,
  options: { passphrase?: string; pluginVersion: string; now?: () => Date },
): Promise<ExportResult> {
  const groups = store.listGroups();
  const connections = store.listConnections();

  // Anything to resolve from the storage requires it to be open; a store
  // with no secrets at all exports fine while closed.
  const hasSecrets = connections.some((c) => Object.keys(c.secretRefs ?? {}).length > 0);
  if (hasSecrets) {
    if (!vault) throw new Error("secret storage is unavailable");
    const status = vault.status();
    if (!status.initialized) {
      throw new Error(
        "secret storage is not initialized: open the Remote Control panel and create the master password first",
      );
    }
    if (!status.unlocked) {
      throw new Error(
        "vault is locked: unlock it with the master password in the Remote Control panel to export passwords",
      );
    }
  }

  const exportedConnections = [];
  for (const connection of connections) {
    const secrets: Record<string, string> = {};
    if (vault) {
      const protocol = getProtocol(connection.protocol);
      const refs = connection.secretRefs ?? {};
      const payload = connection.payload ?? {};
      for (const field of protocol?.secretFields ?? []) {
        const semantic = secretFieldSemantic(field);
        const name =
          refs[field] ?? refs[semantic] ?? (typeof payload[field] === "string" ? (payload[field] as string) : undefined);
        if (!name) continue;
        try {
          secrets[semantic] = await vault.get(name);
        } catch {
          // A dangling reference (entry deleted by hand) is skipped rather
          // than failing the whole export.
        }
      }
    }
    exportedConnections.push({
      id: connection.id,
      groupId: connection.groupId,
      name: connection.name,
      protocol: connection.protocol,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      payload: stripSecretFields(connection.payload ?? {}, getProtocol(connection.protocol)?.secretFields ?? []),
      sortOrder: connection.sortOrder,
      secrets,
    });
  }

  const bundle: ExportBundle = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    pluginVersion: options.pluginVersion,
    groups: groups.map((g) => ({ id: g.id, parentId: g.parentId, name: g.name, sortOrder: g.sortOrder })),
    connections: exportedConnections as ExportBundle["connections"],
  };

  const passphrase = options.passphrase?.trim() ?? "";
  const content = passphrase.length > 0 ? sealBundle(JSON.stringify(bundle, null, 2), passphrase) : JSON.stringify(bundle, null, 2);
  const stamp = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  return {
    filename: `remote-control-export-${stamp}.json`,
    content,
    encrypted: passphrase.length > 0,
  };
}

export function bundleHasSecrets(bundle: ExportBundle): boolean {
  return bundle.connections.some((c) => Object.keys(c.secrets ?? {}).length > 0);
}

// ---------- encryption envelope ----------

export function sealBundle(bundleJson: string, passphrase: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(bundleJson, "utf8"), cipher.final()]);
  return `${JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      encrypted: true,
      encryption: {
        alg: "aes-256-gcm",
        kdf: "scrypt",
        kdfParams: SCRYPT,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
      },
      data: data.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    null,
    2,
  )}\n`;
}

function openEnvelope(envelope: z.infer<typeof envelopeSchema>, passphrase: string | undefined): string {
  const pass = passphrase?.trim() ?? "";
  if (pass.length === 0) {
    throw new Error("this export file is encrypted: enter the passphrase it was exported with");
  }
  const key = crypto.scryptSync(pass, Buffer.from(envelope.encryption.salt, "base64"), 32, SCRYPT);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.encryption.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("wrong passphrase for this export file");
  }
}

/** Parse (and, if sealed, decrypt) an export file into a validated bundle. */
export function openBundle(fileText: string, passphrase?: string): ExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error("not a valid JSON file");
  }
  if (parsed && typeof parsed === "object" && "encrypted" in parsed && (parsed as { encrypted?: unknown }).encrypted === true) {
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) throw new Error("not a valid remote-control export file (malformed envelope)");
    if (envelope.data.version > EXPORT_VERSION) {
      throw new Error(`this export file uses format version ${envelope.data.version}; this plugin understands ${EXPORT_VERSION}`);
    }
    return openBundle(openEnvelope(envelope.data, passphrase), passphrase);
  }
  if (parsed && typeof parsed === "object" && (parsed as { format?: unknown }).format === EXPORT_FORMAT) {
    const version = (parsed as { version?: unknown }).version;
    if (version !== EXPORT_VERSION) {
      throw new Error(
        `this export file uses format version ${String(version)}; this plugin understands ${EXPORT_VERSION}`,
      );
    }
  }
  const bundle = exportBundleSchema.safeParse(parsed);
  if (!bundle.success) {
    const issue = bundle.error.issues[0];
    throw new Error(
      `not a valid remote-control export file${issue ? ` (${issue.path.join(".") || "file"}: ${issue.message})` : ""}`,
    );
  }
  return bundle.data;
}

// ---------- import ----------

export interface ImportReport {
  mode: "merge" | "replace";
  groups: { created: number; reused: number };
  connections: { created: number; updated: number };
  passwords: number;
}

export async function importBundle(
  store: Store,
  vault: VaultService | null,
  bundle: ExportBundle,
  options: { mode: "merge" | "replace" },
): Promise<ImportReport> {
  const report: ImportReport = {
    mode: options.mode,
    groups: { created: 0, reused: 0 },
    connections: { created: 0, updated: 0 },
    passwords: 0,
  };

  if (bundleHasSecrets(bundle)) {
    if (!vault) throw new Error("secret storage is unavailable");
  }

  if (options.mode === "replace") {
    // Wipe connections and groups (and every stored connection secret) so
    // the import result is exactly the file.
    if (vault && vault.status().initialized) {
      for (const entry of vault.listEntries("connections/")) {
        try {
          await vault.delete(entry);
        } catch {
          // best effort: a missing file is not an error
        }
      }
    }
    store.purge();
  }

  // Groups: resolve parents first, reuse an existing group with the same
  // name under the same parent when merging, create otherwise.
  const groupByBundleId = new Map<string, string>();
  const existingGroupByKey = new Map<string, string>();
  for (const g of store.listGroups()) existingGroupByKey.set(`${g.parentId ?? ""}\u0000${g.name}`, g.id);
  const resolving = new Set<string>();
  const resolveGroup = (id: string | null): string | null => {
    if (id === null) return null;
    const cached = groupByBundleId.get(id);
    if (cached !== undefined) return cached;
    const group = bundle.groups.find((g) => g.id === id);
    if (!group) return null;
    if (resolving.has(id)) throw new Error("cyclic group hierarchy in the export file");
    resolving.add(id);
    const parentId = resolveGroup(group.parentId ?? null);
    resolving.delete(id);
    const key = `${parentId ?? ""}\u0000${group.name}`;
    let target = existingGroupByKey.get(key);
    if (target === undefined) {
      target = `grp_${Math.random().toString(36).slice(2, 12)}`;
      store.createGroup({ id: target, parentId, name: group.name, sortOrder: group.sortOrder ?? 0 });
      existingGroupByKey.set(key, target);
      report.groups.created += 1;
    } else {
      report.groups.reused += 1;
    }
    groupByBundleId.set(id, target);
    return target;
  };
  for (const g of bundle.groups) resolveGroup(g.id);

  // Connections: merge matches on protocol+target+login+name (re-importing
  // the same file updates instead of duplicating); replace always creates.
  const existingConnectionByKey = new Map<string, Connection>();
  if (options.mode === "merge") {
    for (const c of store.listConnections()) existingConnectionByKey.set(connectionKey(c), c);
  }

  const needsVault = bundleHasSecrets(bundle);
  for (const incoming of bundle.connections) {
    const protocol = incoming.protocol;
    const payload = stripSecretFields(incoming.payload ?? {}, getProtocol(protocol)?.secretFields ?? []);
    const groupId = resolveGroup(incoming.groupId ?? null);
    const existing = existingConnectionByKey.get(connectionKey(incoming)) ?? null;
    const id = existing?.id ?? `conn_${Math.random().toString(36).slice(2, 12)}`;

    const secretRefs: Record<string, string> = { ...(existing?.secretRefs ?? {}) };
    const secrets = incoming.secrets ?? {};
    for (const [semantic, value] of Object.entries(secrets)) {
      if (value.length === 0) continue;
      if (!vault) throw new Error("secret storage is unavailable");
      const refField = SECRET_REF_FIELD[semantic] ?? semantic;
      const name = `connections/${id}/${semantic}`;
      await vault.set(name, value);
      const previous = secretRefs[refField];
      if (previous && previous !== name) {
        try {
          await vault.delete(previous);
        } catch {
          // best effort
        }
      }
      secretRefs[refField] = name;
      if (semantic === "password") report.passwords += 1;
    }
    if (needsVault && !vault) throw new Error("secret storage is unavailable");

    const sortOrder = incoming.sortOrder ?? existing?.sortOrder ?? 0;
    if (existing) {
      store.updateConnection(id, {
        groupId,
        name: incoming.name,
        protocol,
        host: incoming.host,
        port: incoming.port ?? null,
        username: incoming.username ?? "",
        payload,
        secretRefs,
        sortOrder,
      });
      report.connections.updated += 1;
    } else {
      store.createConnection({
        id,
        groupId,
        name: incoming.name,
        protocol,
        host: incoming.host,
        port: incoming.port ?? null,
        username: incoming.username ?? "",
        payload,
        secretRefs,
        sortOrder,
      });
      report.connections.created += 1;
      existingConnectionByKey.set(connectionKey(incoming), store.getConnection(id)!);
    }
  }

  return report;
}
