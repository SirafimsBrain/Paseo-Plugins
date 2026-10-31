// External-window sessions (stage 0.23.10).
//
// SSH sessions are owned by the Paseo daemon (TerminalService), but RDP and
// VNC sessions are desktop processes this plugin spawns. Without a registry
// they would be invisible: the customer asked for an "RDP session" row with a
// kill action in the Sessions view. This registry is deliberately tiny and
// in-memory (ADR-11's rule that sessions are process state):
//
// - `register` stores pid/kind/name/target/run dir after a successful spawn;
// - `list` prunes entries whose process has exited (an explicit `exit`
//   handler also removes the run dir, so pruning is only a safety net);
// - `kill` sends SIGTERM to the process group (the window is the child of a
//   detached launch) and removes the run dir; the window closes;
// - `dispose` removes run dirs on plugin reload but leaves windows alone,
//   exactly as terminals survive a plugin reload.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

export type ExternalSessionProtocol = "rdp" | "vnc";

export interface ExternalSessionInfo {
  id: string;
  kind: ExternalSessionProtocol;
  name: string;
  connectionId: string;
  target: string;
  pid: number;
  binary: string;
  startedAt: number;
}

export interface RegisterExternalSessionInput {
  connection: { id: string; name: string; host: string; port: number | null };
  protocol: ExternalSessionProtocol;
  pid: number;
  binary: string;
  runDir?: string | null;
}

export interface ExternalSessionRegistryOptions {
  now?: () => number;
  /** Liveness probe, injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** Signal delivery, injectable for tests. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Removes a run directory, injectable for tests. */
  cleanup?: (runDir: string) => void;
}

interface StoredSession extends ExternalSessionInfo {
  runDir: string | null;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Signals the whole detached process group when possible, then the pid.
 * A viewer may spawn helpers (Remmina, for example); the negative pid reaches
 * them too.
 */
function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // not a group leader (or already gone) — fall through to the pid
  }
  process.kill(pid, signal);
}

function removeRunDir(runDir: string): void {
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export class ExternalSessionRegistry {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly cleanup: (runDir: string) => void;

  constructor(options: ExternalSessionRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.isAlive = options.isAlive ?? pidIsAlive;
    this.signal = options.signal ?? signalProcess;
    this.cleanup = options.cleanup ?? removeRunDir;
  }

  register(input: RegisterExternalSessionInput): ExternalSessionInfo {
    const info: ExternalSessionInfo = {
      id: `ext_${randomUUID()}`,
      kind: input.protocol,
      name: input.connection.name,
      connectionId: input.connection.id,
      target: `${input.connection.host}${input.connection.port ? `:${input.connection.port}` : ""}`,
      pid: input.pid,
      binary: input.binary,
      startedAt: this.now(),
    };
    this.sessions.set(info.id, { ...info, runDir: input.runDir ?? null });
    return info;
  }

  /** Live external sessions, oldest first; dead pids are dropped. */
  list(): ExternalSessionInfo[] {
    for (const [id, session] of [...this.sessions]) {
      if (this.isAlive(session.pid)) continue;
      if (session.runDir) this.cleanup(session.runDir);
      this.sessions.delete(id);
    }
    return [...this.sessions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ runDir: _runDir, ...info }) => info);
  }

  get(id: string): ExternalSessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (!this.isAlive(session.pid)) {
      if (session.runDir) this.cleanup(session.runDir);
      this.sessions.delete(id);
      return null;
    }
    const { runDir: _runDir, ...info } = session;
    return info;
  }

  /** Stops the window and its run directory; false when the id is unknown. */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      this.signal(session.pid, "SIGTERM");
    } catch {
      // Already gone: still clean up and report success, the goal is reached.
    }
    if (session.runDir) this.cleanup(session.runDir);
    this.sessions.delete(id);
    return true;
  }

  /** Plugin cleanup: removes run directories, leaves windows running. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.runDir) this.cleanup(session.runDir);
    }
    this.sessions.clear();
  }
}
