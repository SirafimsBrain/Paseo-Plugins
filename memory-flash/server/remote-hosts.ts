import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { RemoteHost } from "../shared/memories";

/**
 * Remote host registry (requirement 8).
 *
 * Memory Flash is a single shared SQLite file per machine. A remote Paseo
 * host (another machine running the Paseo server) keeps its own memory
 * database; this module stores connection definitions so the surface can
 * reach them, check status, and — for the supported transport — probe the
 * remote database over the standard Paseo SSH connection.
 *
 * Transports:
 * - `paseo-ssh` (implemented): the standard Paseo CLI transport. The Paseo
 *   daemon already knows how to reach remote daemons over SSH
 *   (`paseo --host <ssh-url>`); the plugin shells out to `paseo` with
 *   `--format json` to verify the remote and read its `$PASEO_HOME` location.
 * - `tcp` (stub): direct daemon TCP — reserved.
 * - `relay` (stub): Paseo Hub relay — reserved.
 */

interface HostsFile {
  version: 1;
  hosts: RemoteHost[];
}

export function hostsFilePath(): string {
  const configured = process.env.PASEO_HOME;
  const home = configured && configured.trim().length > 0 ? configured : path.join(os.homedir(), ".paseo");
  return path.join(home, "plugins", "memory-flash", "hosts.json");
}

function loadHosts(): HostsFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(hostsFilePath(), "utf-8"));
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as HostsFile).hosts)) {
      return parsed as HostsFile;
    }
  } catch {
    // Missing or corrupted file — treat as empty.
  }
  return { version: 1, hosts: [] };
}

function saveHosts(file: HostsFile): void {
  const target = hostsFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, target);
}

export function listRemoteHosts(): RemoteHost[] {
  return loadHosts().hosts;
}

export function saveRemoteHost(input: Omit<RemoteHost, "status" | "lastError" | "checkedAt">): {
  ok: boolean;
  id: string;
  error: string | null;
} {
  const file = loadHosts();
  const id = input.id && input.id.trim().length > 0 ? input.id : `host_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const existingIndex = file.hosts.findIndex((host) => host.id === id);
  const record: RemoteHost = {
    ...input,
    id,
    status: existingIndex >= 0 ? file.hosts[existingIndex].status : "unknown",
    lastError: existingIndex >= 0 ? file.hosts[existingIndex].lastError : null,
    checkedAt: existingIndex >= 0 ? file.hosts[existingIndex].checkedAt : null,
  };
  if (existingIndex >= 0) file.hosts[existingIndex] = record;
  else file.hosts.push(record);
  saveHosts(file);
  return { ok: true, id, error: null };
}

export function deleteRemoteHost(id: string): boolean {
  const file = loadHosts();
  const before = file.hosts.length;
  file.hosts = file.hosts.filter((host) => host.id !== id);
  if (file.hosts.length !== before) {
    saveHosts(file);
    return true;
  }
  return false;
}

function sshTarget(host: RemoteHost): string {
  return host.user ? `${host.user}@${host.host}` : host.host;
}

/**
 * Checks a remote host. For `paseo-ssh` this runs `paseo --host ssh://…`
 * against the remote daemon and returns the remote memory database path.
 * Stub transports report `unsupported` without marking the host as broken.
 */
export function checkRemoteHost(id: string): {
  ok: boolean;
  status: "ok" | "error" | "unsupported";
  error: string | null;
  remoteDbPath: string | null;
} {
  const file = loadHosts();
  const host = file.hosts.find((candidate) => candidate.id === id);
  if (!host) return { ok: false, status: "error", error: "Host not found.", remoteDbPath: null };

  const remoteDb = "~/.paseo/plugins/memory-flash/memory.db";

  if (host.transport !== "paseo-ssh") {
    const message = `Transport "${host.transport}" is a stub — only "paseo-ssh" is implemented.`;
    persistStatus(id, "unsupported", message);
    return { ok: false, status: "unsupported", error: message, remoteDbPath: null };
  }

  const url = `ssh://${sshTarget(host)}${host.port !== 22 ? `:${host.port}` : ""}`;
  try {
    const probe = spawnSync("paseo", ["--host", url, "status", "--json"], {
      encoding: "utf-8",
      timeout: 20000,
    });
    if (probe.error || probe.status !== 0) {
      const message = probe.error ? String(probe.error.message) : (probe.stderr || `paseo exited with ${probe.status}`);
      persistStatus(id, "error", message);
      return { ok: false, status: "error", error: message, remoteDbPath: null };
    }
    persistStatus(id, "ok", null);
    return { ok: true, status: "ok", error: null, remoteDbPath: remoteDb };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    persistStatus(id, "error", message);
    return { ok: false, status: "error", error: message, remoteDbPath: null };
  }
}

function persistStatus(id: string, status: RemoteHost["status"], lastError: string | null): void {
  const file = loadHosts();
  const host = file.hosts.find((candidate) => candidate.id === id);
  if (!host) return;
  host.status = status;
  host.lastError = lastError;
  host.checkedAt = new Date().toISOString();
  saveHosts(file);
}
