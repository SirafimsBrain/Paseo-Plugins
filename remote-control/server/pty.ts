import * as fs from "node:fs";
import * as path from "node:path";

function provisionNativeBinary(): void {
  try {
    const source = path.join(__dirname, "prebuilds", "linux-x64", "pty.node");
    if (!fs.existsSync(source)) return;
    const targetDir = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds", "linux-x64");
    const target = path.join(targetDir, "pty.node");
    if (fs.existsSync(target)) return;
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, target);
  } catch {
    // best effort
  }
}

function loadNodePty(): any {
  provisionNativeBinary();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node-pty");
}

// PTY layer (stage B3). Spawns a shell via node-pty, keeps a ring
// buffer of recent output for `attach` after a tab reload, and exposes
// write/resize/kill plus data/exit events.

export interface PtyOptions {
  cols?: number;
  rows?: number;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  bufferBytes?: number;
}

export interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

export interface PtyHandle {
  readonly id: string;
  readonly pid: number;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (info: PtyExitInfo) => void): () => void;
  snapshot(): Uint8Array;
  dispose(): void;
}

const DEFAULT_BUFFER_BYTES = 64 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Fixed-capacity byte ring buffer. `snapshot()` returns the buffered bytes
 * in chronological order (oldest first), capped at capacity.
 */
export class RingBuffer {
  private readonly capacity: number;
  private chunks: Uint8Array[] = [];
  private total = 0;

  constructor(capacity: number = DEFAULT_BUFFER_BYTES) {
    this.capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.total;
  }

  get cap(): number {
    return this.capacity;
  }

  append(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    // Drop oldest chunks until there is room.
    let incoming = data;
    if (incoming.byteLength > this.capacity) {
      incoming = incoming.subarray(incoming.byteLength - this.capacity);
    }
    // Make room.
    while (this.total + incoming.byteLength > this.capacity && this.chunks.length > 0) {
      const oldest = this.chunks[0];
      const overflow = this.total + incoming.byteLength - this.capacity;
      if (overflow >= oldest.byteLength) {
        this.chunks.shift();
        this.total -= oldest.byteLength;
      } else {
        this.chunks[0] = oldest.subarray(overflow);
        this.total -= overflow;
      }
    }
    this.chunks.push(new Uint8Array(incoming));
    this.total += incoming.byteLength;
  }

  snapshot(): Uint8Array {
    if (this.chunks.length === 0) return new Uint8Array(0);
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}

export class Pty implements PtyHandle {
  readonly id: string;
  private readonly ptyProcess: any;
  private readonly buffer: RingBuffer;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(info: PtyExitInfo) => void>();
  private disposed = false;

  constructor(id: string, options: PtyOptions = {}) {
    this.id = id;
    this.buffer = new RingBuffer(options.bufferBytes ?? DEFAULT_BUFFER_BYTES);
    const shell =
      options.shell ??
      process.env.SHELL ??
      (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    this.ptyProcess = loadNodePty().spawn(shell, options.args ?? [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? (process.env as Record<string, string>),
    });
    this.ptyProcess.onData((data: string) => {
      const bytes = new TextEncoder().encode(data);
      this.buffer.append(bytes);
      for (const listener of this.dataListeners) listener(data);
    });
    this.ptyProcess.onExit((event: { exitCode: number; signal?: number }) => {
      for (const listener of this.exitListeners) {
        listener({ exitCode: event.exitCode, signal: event.signal });
      }
    });
  }

  get pid(): number {
    return this.ptyProcess.pid;
  }

  write(data: string | Uint8Array): void {
    if (this.disposed) return;
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.ptyProcess.write(text);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols < 1 || rows < 1) return;
    this.ptyProcess.resize(cols, rows);
  }

  kill(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.ptyProcess.kill();
    } catch {
      // ignore
    }
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (info: PtyExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  snapshot(): Uint8Array {
    return this.buffer.snapshot();
  }

  dispose(): void {
    this.kill();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

export function spawnPty(id: string, options?: PtyOptions): Pty {
  return new Pty(id, options);
}
