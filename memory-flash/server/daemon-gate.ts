import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";

/**
 * Paseo daemon gate for the bundled stdio MCP server.
 *
 * The MCP server is a plain Node process spawned by whatever agent wants the
 * memory: Paseo's own injected agents, but also Cline, Cursor, Codex CLI, Kimi
 * Code CLI, Pi and anything else the plugin registered itself into. Those
 * "external" agents keep the server in their config permanently, so a spawn
 * happens long after Paseo was closed — and without a running Paseo the memory
 * host is not part of the system any more.
 *
 * Policy: a plugin's stdio MCP server is available only while Paseo (daemon or
 * desktop) runs. When it does not, the server must not silently serve the
 * database and must not leave the agent guessing: it answers every tool call
 * with one sentence saying Paseo is down and MCP is unavailable, so the agent
 * stops instead of retrying, investigating or re-implementing memory itself.
 *
 * Liveness is read from two artifacts, cheapest first:
 *
 * 1. **Plugin heartbeat** — `$PASEO_HOME/plugins/memory-flash/daemon-heartbeat.json`,
 *    rewritten every {@link HEARTBEAT_INTERVAL_MS} by the plugin server, which
 *    runs inside the daemon. This is the precise signal: it exists only while
 *    the memory plugin itself is alive, and its timestamp cannot outlive a
 *    crashed process by more than {@link HEARTBEAT_MAX_AGE_MS}.
 * 2. **Daemon pid file** — `$PASEO_HOME/paseo.pid` (JSON `{pid, …}` or a plain
 *    pid). A live pid covers the first seconds after a daemon start, before the
 *    first heartbeat lands, and hosts where the plugin's data directory is not
 *    writable.
 *
 * `MEMORY_FLASH_DAEMON_GATE=off` disables the gate (development, tests, and a
 * deliberately headless setup). It is documented in __doc.md, never a silent
 * default.
 */

/** Text delivered to an agent whose MCP server starts without a running Paseo. */
export const PASEO_DOWN_MESSAGE =
  "Демон Paseo недоступен, MCP недоступен (Paseo daemon unavailable — MCP unavailable). " +
  "Start Paseo — the daemon or the desktop app — and try again: the memory MCP server is only " +
  "served while Paseo runs. Nothing on the MCP side is broken, so do not retry in a loop, do not " +
  "diagnose the server, and do not read or edit the memory database directly.";

/** File the plugin server rewrites to keep the gate open. */
export const HEARTBEAT_FILE_NAME = "daemon-heartbeat.json";

/** How often the plugin server rewrites the heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** A heartbeat older than this is treated as a stopped daemon. */
export const HEARTBEAT_MAX_AGE_MS = 60_000;

export type PaseoAvailabilitySource = "heartbeat" | "pid" | "disabled" | "none";

export interface PaseoAvailability {
  available: boolean;
  source: PaseoAvailabilitySource;
  /** Human-readable explanation, logged to stderr by the MCP server. */
  reason: string;
}

export interface DaemonGateOptions {
  /** Paseo home; defaults to `$PASEO_HOME` or `~/.paseo`. */
  home?: string;
  /** Clock override for tests. */
  now?: number;
  env?: NodeJS.ProcessEnv;
  readFile?: (file: string) => string;
  isProcessAlive?: (pid: number) => boolean;
}

/** Paseo home, resolved per call (`$PASEO_HOME` wins). */
export function paseoHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured.trim()
    : path.join(os.homedir(), ".paseo");
}

/** Absolute path of the plugin heartbeat file. */
export function heartbeatPath(home: string = paseoHomeDir()): string {
  return path.join(home, "plugins", "memory-flash", HEARTBEAT_FILE_NAME);
}

/** Absolute path of the daemon pid file. */
export function daemonPidPath(home: string = paseoHomeDir()): string {
  return path.join(home, "paseo.pid");
}

/** True when `MEMORY_FLASH_DAEMON_GATE` explicitly turns the gate off. */
export function isGateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MEMORY_FLASH_DAEMON_GATE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no" || raw === "disabled";
}

/** `process.kill(pid, 0)` — alive, and EPERM still means "someone is there". */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads a pid out of `paseo.pid` (JSON `{pid}` or a bare number). */
export function parsePidFile(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** Decides whether the stdio MCP server may serve this agent. */
export function checkPaseoDaemon(options: DaemonGateOptions = {}): PaseoAvailability {
  const env = options.env ?? process.env;
  if (isGateDisabled(env)) {
    return { available: true, source: "disabled", reason: "daemon gate disabled by MEMORY_FLASH_DAEMON_GATE" };
  }

  const home = options.home ?? paseoHomeDir(env);
  const now = options.now ?? Date.now();
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf-8"));
  const alive = options.isProcessAlive ?? isProcessAlive;

  try {
    const raw = JSON.parse(readFile(heartbeatPath(home))) as { updatedAt?: unknown; pid?: unknown };
    const updatedAt =
      typeof raw.updatedAt === "number"
        ? raw.updatedAt
        : typeof raw.updatedAt === "string"
          ? Date.parse(raw.updatedAt)
          : Number.NaN;
    const pidOk = typeof raw.pid !== "number" || alive(raw.pid);
    if (Number.isFinite(updatedAt) && now - updatedAt <= HEARTBEAT_MAX_AGE_MS && pidOk) {
      return {
        available: true,
        source: "heartbeat",
        reason: `plugin heartbeat is ${Math.max(0, Math.round((now - updatedAt) / 1000))}s old`,
      };
    }
  } catch {
    // No heartbeat file, or it is unreadable — try the pid file next.
  }

  try {
    const pid = parsePidFile(readFile(daemonPidPath(home)));
    if (pid !== null && alive(pid)) {
      return { available: true, source: "pid", reason: `Paseo daemon pid ${pid} is running` };
    }
  } catch {
    // No pid file either.
  }

  return {
    available: false,
    source: "none",
    reason: `no fresh heartbeat at ${heartbeatPath(home)} and no live daemon pid at ${daemonPidPath(home)}`,
  };
}

export interface HeartbeatOptions {
  home?: string;
  pid?: number;
  intervalMs?: number;
  /** Version string recorded in the file (diagnostics only). */
  version?: string;
}

/**
 * Writes the heartbeat once. Returns the path, or `null` when the data
 * directory is not writable — the gate then falls back to the pid file.
 */
export function writeDaemonHeartbeat(options: HeartbeatOptions = {}): string | null {
  const target = heartbeatPath(options.home ?? paseoHomeDir());
  const payload = JSON.stringify(
    {
      pid: options.pid ?? process.pid,
      updatedAt: Date.now(),
      version: options.version ?? null,
    },
    null,
    2,
  );
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${payload}\n`, "utf-8");
    fs.renameSync(temp, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Keeps the heartbeat fresh for as long as the plugin server runs. The
 * returned stop function clears the timer and removes the file, so a clean
 * shutdown closes the gate immediately instead of waiting for staleness.
 */
export function startDaemonHeartbeat(options: HeartbeatOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const target = writeDaemonHeartbeat(options);
  if (target === null) return () => undefined;
  const timer = setInterval(() => writeDaemonHeartbeat(options), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    clearInterval(timer);
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // Already gone or not removable — staleness still closes the gate.
    }
  };
}
