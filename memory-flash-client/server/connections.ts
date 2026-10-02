import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Connection, ConnectionView } from "../shared/contracts";

/**
 * Connection registry for memory-flash-client.
 *
 * Each connection describes one remote memory host (a machine running
 * the memory-flash plugin with its HTTP MCP endpoint enabled): the MCP
 * URL plus the API key generated there. The file lives next to the
 * plugin data — `$PASEO_HOME/plugins/memory-flash-client/connections.json`
 * — mirroring how memory-flash keeps its `hosts.json`.
 *
 * Security: the API key is the client's credential to a remote host, so
 * the file is written with mode 0600 and directory 0700. It is never
 * written to git, agent prompts or logs, and the UI only ever sees the
 * secret's prefix.
 */

interface ConnectionsFile {
  version: 1;
  connections: Connection[];
}

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured
    : path.join(os.homedir(), ".paseo");
}

export function connectionsFilePath(): string {
  return path.join(paseoHome(), "plugins", "memory-flash-client", "connections.json");
}

/** Characters of the secret kept for UI recognition. */
const KEY_PREFIX_LENGTH = 12;

function prefixOf(secret: string): string {
  return secret.slice(0, KEY_PREFIX_LENGTH);
}

function load(): ConnectionsFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(connectionsFilePath(), "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as ConnectionsFile).connections)
    ) {
      return parsed as ConnectionsFile;
    }
  } catch {
    // Missing or corrupted file — start from an empty registry.
  }
  return { version: 1, connections: [] };
}

/**
 * Atomic write: a temp file in the same directory followed by a rename,
 * so a crash mid-write cannot truncate the registry. The directory and
 * file are created with owner-only permissions because the file holds API
 * keys.
 */
function save(file: ConnectionsFile): void {
  const target = connectionsFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Normalizes a pasted endpoint: adds `http://` and the `/mcp` path. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.pathname || url.pathname === "/") url.pathname = "/mcp";
    return url.toString();
  } catch {
    // Not parseable — hand the trimmed value back; the probe reports why.
    return trimmed;
  }
}

/** All connections, newest id last. */
export function listConnections(): Connection[] {
  return load().connections;
}

export function getConnection(id: string): Connection | null {
  return load().connections.find((entry) => entry.id === id) ?? null;
}

/**
 * Creates or updates a connection. `check` state (status / lastError /
 * checkedAt) is preserved from the existing record, since only the probe
 * may set it. Returns the new id.
 */
export function saveConnection(
  input: Omit<Connection, "keyPrefix" | "status" | "lastError" | "checkedAt">,
): { ok: boolean; id: string; error: string | null } {
  const file = load();
  const id =
    input.id && input.id.trim().length > 0
      ? input.id
      : `conn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const existing = file.connections.find((entry) => entry.id === id);
  const record: Connection = {
    ...input,
    id,
    url: normalizeUrl(input.url),
    keyPrefix: prefixOf(input.secret),
    status: existing?.status ?? "unknown",
    lastError: existing?.lastError ?? null,
    checkedAt: existing?.checkedAt ?? null,
  };
  const index = file.connections.findIndex((entry) => entry.id === id);
  if (index >= 0) file.connections[index] = record;
  else file.connections.push(record);
  save(file);
  return { ok: true, id, error: null };
}

export function deleteConnection(id: string): boolean {
  const file = load();
  const before = file.connections.length;
  file.connections = file.connections.filter((entry) => entry.id !== id);
  if (file.connections.length === before) return false;
  save(file);
  return true;
}

/** Persists the outcome of a probe for the settings UI. */
export function persistCheck(
  id: string,
  status: Connection["status"],
  lastError: string | null,
): void {
  const file = load();
  const connection = file.connections.find((entry) => entry.id === id);
  if (!connection) return;
  connection.status = status;
  connection.lastError = lastError;
  connection.checkedAt = new Date().toISOString();
  save(file);
}

/** A connection without its secret — the only shape the UI ever receives. */
export function toView(connection: Connection): ConnectionView {
  const { secret: _secret, ...view } = connection;
  return view;
}

export function listViews(): ConnectionView[] {
  return load().connections.map(toView);
}
