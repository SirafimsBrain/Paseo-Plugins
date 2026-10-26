// Session registry (stage B3/B4). In-memory, lives as long as the daemon.
// Tracks local (and later ssh/rdp/vnc) sessions with a unified shape and
// emits `session-updated` events for the SSE feed.

import { spawnPty, type Pty, type PtyExitInfo } from "./pty";
import type { TransportConnection } from "./transport";

export type SessionKind = "local" | "ssh" | "rdp" | "vnc";
export type SessionState = "starting" | "running" | "exited" | "failed";

export interface Session {
  id: string;
  kind: SessionKind;
  title: string;
  state: SessionState;
  pid: number | null;
  exitCode: number | null;
  signal: number | null;
  startedAt: number;
  endedAt: number | null;
  lastError: string | null;
  connectionId: string | null;
}

export type SessionEvent =
  | { type: "session-updated"; session: Session }
  | { type: "session-removed"; sessionId: string };

export interface SessionRegistryOptions {
  onEvent?: (event: SessionEvent) => void;
  now?: () => number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly ptys = new Map<string, Pty>();
  private readonly attachments = new Map<string, Set<TransportConnection>>();
  private onEvent: (event: SessionEvent) => void;
  private readonly now: () => number;

  constructor(options: SessionRegistryOptions = {}) {
    this.onEvent = options.onEvent ?? (() => {});
    this.now = options.now ?? (() => Date.now());
  }

  private emit(event: SessionEvent): void {
    this.onEvent(event);
  }

  setOnEvent(listener: (event: SessionEvent) => void): void {
    this.onEvent = listener;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getPty(id: string): Pty | undefined {
    return this.ptys.get(id);
  }

  createLocal(options: { title?: string; cols?: number; rows?: number } = {}): Session {
    const id = cryptoRandomId();
    const session: Session = {
      id,
      kind: "local",
      title: options.title ?? "local shell",
      state: "starting",
      pid: null,
      exitCode: null,
      signal: null,
      startedAt: this.now(),
      endedAt: null,
      lastError: null,
      connectionId: null,
    };
    this.sessions.set(id, session);
    this.emit({ type: "session-updated", session: { ...session } });

    try {
      const pty = spawnPty(id, { cols: options.cols, rows: options.rows });
      this.ptys.set(id, pty);
      session.pid = pty.pid;
      session.state = "running";
      pty.onExit((info) => {
        const current = this.sessions.get(id);
        if (!current) return;
        current.state = "exited";
        current.exitCode = info.exitCode;
        current.signal = info.signal ?? null;
        current.endedAt = this.now();
        this.emit({ type: "session-updated", session: { ...current } });
      });
      this.emit({ type: "session-updated", session: { ...session } });
    } catch (cause) {
      session.state = "failed";
      session.lastError = cause instanceof Error ? cause.message : String(cause);
      session.endedAt = this.now();
      this.emit({ type: "session-updated", session: { ...session } });
    }
    return { ...session };
  }

  kill(id: string): boolean {
    const pty = this.ptys.get(id);
    const session = this.sessions.get(id);
    if (!session) return false;
    if (pty) {
      pty.kill();
      this.ptys.delete(id);
    }
    if (session.state === "running" || session.state === "starting") {
      session.state = "exited";
      session.endedAt = session.endedAt ?? this.now();
      this.emit({ type: "session-updated", session: { ...session } });
    }
    return true;
  }

  reconnect(id: string): Session | null {
    const previous = this.sessions.get(id);
    if (!previous) return null;
    // Tear down the old pty but keep the session id and seed the new buffer
    // from the old snapshot so history survives.
    const oldPty = this.ptys.get(id);
    const snapshot = oldPty ? oldPty.snapshot() : new Uint8Array(0);
    if (oldPty) {
      oldPty.kill();
      this.ptys.delete(id);
    }
    previous.state = "exited";
    previous.endedAt = previous.endedAt ?? this.now();
    this.emit({ type: "session-updated", session: { ...previous } });

    // New session with a fresh id, seeded title, new pty.
    const next = this.createLocal({ title: previous.title });
    const newPty = this.ptys.get(next.id);
    // Seed the ring buffer by writing the snapshot back as input? Simpler:
    // store the snapshot on the new session's pty is not possible post-spawn.
    // Instead, expose the seeded bytes via a side channel used by attach().
    if (newPty && snapshot.byteLength > 0) {
      // Replay happens at attach time from the new pty's own (empty) buffer;
      // to preserve history we stash the seed on the session's pty via a
      // marker property. The attach path checks `seededSnapshot`.
      (newPty as unknown as { seededSnapshot?: Uint8Array }).seededSnapshot = snapshot;
    }
    return this.sessions.get(next.id) ? { ...this.sessions.get(next.id)! } : null;
  }

  attach(connection: TransportConnection, sessionId: string): boolean {
    const pty = this.ptys.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!pty || !session) return false;
    // Replay buffered output.
    const seed = (pty as unknown as { seededSnapshot?: Uint8Array }).seededSnapshot;
    const snapshot = seed ?? pty.snapshot();
    if (snapshot.byteLength > 0) {
      connection.sendBinary(snapshot);
      if (seed) delete (pty as unknown as { seededSnapshot?: Uint8Array }).seededSnapshot;
    }
    // Wire live data.
    const unsubscribeData = pty.onData((data) => {
      connection.sendBinary(new TextEncoder().encode(data));
    });
    const unsubscribeExit = pty.onExit((info) => {
      connection.sendControl({ t: "exit", exitCode: info.exitCode, signal: info.signal });
    });
    const set = this.attachments.get(sessionId) ?? new Set<TransportConnection>();
    set.add(connection);
    this.attachments.set(sessionId, set);
    connection.onClose(() => {
      unsubscribeData();
      unsubscribeExit();
      const s = this.attachments.get(sessionId);
      if (s) {
        s.delete(connection);
        if (s.size === 0) this.attachments.delete(sessionId);
      }
    });
    // Route incoming binary from this connection to the pty.
    connection.onBinary((data) => {
      pty.write(data);
    });
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const pty = this.ptys.get(sessionId);
    if (!pty) return false;
    pty.resize(cols, rows);
    return true;
  }

  dispose(): void {
    for (const pty of this.ptys.values()) pty.dispose();
    this.ptys.clear();
    this.sessions.clear();
    this.attachments.clear();
  }
}

function cryptoRandomId(): string {
  return `sess_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}
