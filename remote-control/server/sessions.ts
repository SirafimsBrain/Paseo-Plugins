// External-window sessions (stage 0.23.10).
//
// SSH sessions are owned by the Paseo daemon (TerminalService), but RDP and
// VNC sessions are desktop processes this plugin spawns. Without a registry
// they would be invisible: the customer asked for an "RDP session" row with a
// kill action in the Sessions view. This registry is deliberately tiny and
// in-memory (ADR-11's rule that sessions are process state):
//
// - `register` stores pid/kind/name/target/run dir after a successful spawn;
// - `markExited` records how the window ended (stage 0.28.11, E2): the row
//   stays in the list as `exited` with its exit code, so the console shows the
//   process and its status after the window closes; the run dir is removed;
// - `list` marks entries whose process died without a recorded exit as
//   `exited` with an unknown code (the explicit exit handler is the normal
//   path; this is only a safety net) and keeps the newest finished rows;
// - `kill` sends SIGTERM to the process group (the window is the child of a
//   detached launch) and removes the run dir; for a finished row it only
//   dismisses it from the list;
// - `dispose` removes run dirs on plugin reload but leaves windows alone,
//   exactly as terminals survive a plugin reload.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

export type ExternalSessionProtocol = "rdp" | "vnc";

/** `running` while the window lives, `exited` once its process ended. */
export type ExternalSessionState = "running" | "exited";

export interface ExternalSessionExit {
  /** Process exit code; null when the process was killed by a signal. */
  code?: number | null;
  /** Terminating signal, when there was one. */
  signal?: NodeJS.Signals | string | null;
}

export interface ExternalSessionInfo {
  id: string;
  kind: ExternalSessionProtocol;
  name: string;
  connectionId: string;
  target: string;
  pid: number;
  binary: string;
  startedAt: number;
  /** Stage 0.28.11 (E2): process state and how it ended. */
  state: ExternalSessionState;
  exitCode: number | null;
  signal: string | null;
  exitedAt: number | null;
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
  /** Change listener (see {@link ExternalSessionRegistry.onChange}). */
  onChange?: (sessions: ExternalSessionInfo[]) => void;
  /** Liveness probe, injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** Signal delivery, injectable for tests. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Removes a run directory, injectable for tests. */
  cleanup?: (runDir: string) => void;
  /** Finished rows kept for the Sessions view (default 20). */
  maxExited?: number;
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
  private readonly maxExited: number;
  private notifying = false;

  /**
   * Called after a window is registered, killed or pruned (stage 0.25.11,
   * G1). The HTTP endpoint uses it to push a `sessions` SSE event, so the
   * console updates without waiting for its poll.
   */
  onChange: ((sessions: ExternalSessionInfo[]) => void) | null = null;

  constructor(options: ExternalSessionRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.isAlive = options.isAlive ?? pidIsAlive;
    this.signal = options.signal ?? signalProcess;
    this.cleanup = options.cleanup ?? removeRunDir;
    this.maxExited = options.maxExited ?? 20;
    this.onChange = options.onChange ?? null;
  }

  private notify(): void {
    if (this.notifying || this.onChange === null) return;
    this.notifying = true;
    try {
      this.onChange(this.list());
    } catch {
      // a broken listener must never break the registry
    } finally {
      this.notifying = false;
    }
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
      state: "running",
      exitCode: null,
      signal: null,
      exitedAt: null,
    };
    this.sessions.set(info.id, { ...info, runDir: input.runDir ?? null });
    this.notify();
    return info;
  }

  /**
   * Records the end of a window process (stage 0.28.11, E2). The row stays so
   * the console can show the process and its exit code after the window is
   * gone; `kill` on such a row dismisses it.
   */
  markExited(id: string, exit: ExternalSessionExit = {}): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state === "exited") return false;
    this.finish(session, exit.code ?? null, exit.signal ?? null);
    this.capExited();
    this.notify();
    return true;
  }

  /** Moves a session to `exited` and removes what the window owned. */
  private finish(session: StoredSession, code: number | null, signal: string | null): void {
    session.state = "exited";
    session.exitCode = typeof code === "number" ? code : null;
    session.signal = signal;
    session.exitedAt = this.now();
    if (session.runDir) {
      this.cleanup(session.runDir);
      session.runDir = null;
    }
  }

  /** Keeps the finished rows bounded (oldest exited first). */
  private capExited(): void {
    const exited = [...this.sessions.values()]
      .filter((session) => session.state === "exited")
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
    for (let index = 0; index < exited.length - this.maxExited; index += 1) {
      this.sessions.delete(exited[index]!.id);
    }
  }

  /**
   * External sessions, oldest first. A running row whose pid disappeared
   * without an exit event is marked `exited` with an unknown code rather than
   * dropped, so the console never loses a process silently.
   */
  list(): ExternalSessionInfo[] {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.state === "exited") continue;
      if (this.isAlive(session.pid)) continue;
      this.finish(session, null, null);
      changed = true;
    }
    if (changed) {
      this.capExited();
      this.notify();
    }
    return [...this.sessions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ runDir: _runDir, ...info }) => info);
  }

  get(id: string): ExternalSessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.state === "running" && !this.isAlive(session.pid)) {
      this.finish(session, null, null);
      this.capExited();
      this.notify();
    }
    const { runDir: _runDir, ...info } = session;
    return info;
  }

  /**
   * Stops the window and its run directory; false when the id is unknown. On
   * a finished row it only removes the row (nothing left to signal).
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.state === "running") {
      try {
        this.signal(session.pid, "SIGTERM");
      } catch {
        // Already gone: still clean up and report success, the goal is reached.
      }
    }
    if (session.runDir) this.cleanup(session.runDir);
    this.sessions.delete(id);
    this.notify();
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
