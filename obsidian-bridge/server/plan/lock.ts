import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pluginDataDir } from "../paths";
import type { PlanRoot } from "./paths";

/**
 * One writer at a time per planning tree (0.21.17).
 *
 * The access model is SQLite's, not a database server's: the plan is a folder
 * of Markdown files, so the unit of concurrency is **one write lock per plan
 * tree**, taken by every mutating `plan_*` call and released when the call
 * returns. That is `BEGIN IMMEDIATE` with `busy_timeout`: a second writer
 * waits, and either the first finishes or the second is told to wait ten
 * seconds and repeat. There is no two-phase commit, no multi-version snapshot,
 * no per-file lock table and no deadlock detector — a plan write is a handful
 * of `rename`s, and a transaction log over several files would cost more than
 * the problem it solves.
 *
 * Why a lock is needed at all: `expected_revision` catches two agents editing
 * the same node, but a move or an archive rewrites *other* files (links, the
 * parent's `children`, the journal) and those rewrites are read-modify-write
 * across a whole project. Two agents doing that at once can each pass their own
 * revision check and still lose one side's link rewrite.
 *
 * ## The lock is a directory
 *
 * `mkdir` is atomic on every platform this plugin runs on: exactly one process
 * gets it, everyone else gets `EEXIST`. Inside, `owner.json` records the pid,
 * the host, the tool and the start time, so a refusal can name the other agent
 * and a crashed holder can be recognised.
 *
 * ## Recovery, not liveness
 *
 * A holder that died left the directory behind. Like SQLite replaying a hot
 * journal, the next writer recovers it: a dead pid on this host is taken over
 * immediately, and any lock older than {@link LOCK_STALE_MS} is taken over even
 * across hosts. A lock is never held across processes longer than one tool call,
 * so the age cap only fires on a crash.
 *
 * Reads take no lock, exactly like a WAL reader: every file is replaced by
 * `rename`, so a read sees the old or the new revision of each file, never a
 * half-written one. A multi-file move can be observed between its files; that
 * window is what `plan_validate` reports and the next read repairs by reading
 * again.
 *
 * Residual risk, stated rather than hidden: recovery trusts the clock and the
 * pid namespace. A tool call that legitimately runs longer than
 * {@link LOCK_STALE_MS} could have its lock taken over, and two machines
 * sharing a vault over a network filesystem are outside this model entirely.
 */

/** How long a second writer waits before it is told to retry (`busy_timeout`). */
export const LOCK_WAIT_MS = 10_000;

/**
 * A lock older than this is treated as left by a crash.
 *
 * Generous on purpose: same-host crashes are detected by pid, so the age cap
 * only covers a holder on another host. A legitimate write is seconds, not
 * minutes.
 */
export const LOCK_STALE_MS = 5 * 60_000;

export interface PlanLockInfo {
  /** Tool taking the lock; named in the other writer's refusal. */
  tool: string;
  /** Actor recorded in the owner file. */
  actor: string;
}

export interface PlanLockOptions {
  /** Total wait before a refusal; defaults to `$OBSIDIAN_BRIDGE_LOCK_WAIT_MS` or 10 s. */
  waitMs?: number;
  /** Age after which a lock is considered abandoned; defaults to 5 minutes. */
  staleMs?: number;
  /** Directory holding lock directories; defaults to the plugin data directory. */
  locksRoot?: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LockOwner {
  pid: number;
  host: string;
  tool: string;
  actor: string;
  started_at: string;
  root: string;
}

export type PlanLockResult =
  | { release: () => void; waitedMs: number }
  | { busy: string; holder: LockOwner | null };

function defaultLocksRoot(): string {
  return path.join(pluginDataDir(), "locks");
}

/**
 * Lock directory of one planning tree.
 *
 * The key covers the vault and the planning root, so two vaults (or a vault
 * with two configured roots) never share a lock, and the plugin data directory
 * keeps the lock out of Obsidian's note tree.
 */
export function planLockPath(root: PlanRoot, locksRoot: string = defaultLocksRoot()): string {
  const key = crypto
    .createHash("sha1")
    .update(`${path.resolve(root.vaultRoot)}\u0000${root.relPath}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(locksRoot, `plan-${key}.lock`);
}

function lockWaitMs(): number {
  const raw = Number(process.env.OBSIDIAN_BRIDGE_LOCK_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : LOCK_WAIT_MS;
}

function readOwner(dir: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const owner = parsed as Partial<LockOwner>;
    if (typeof owner.pid !== "number" || typeof owner.started_at !== "string") return null;
    return {
      pid: owner.pid,
      host: typeof owner.host === "string" ? owner.host : "",
      tool: typeof owner.tool === "string" ? owner.tool : "plan_*",
      actor: typeof owner.actor === "string" ? owner.actor : "agent",
      started_at: owner.started_at,
      root: typeof owner.root === "string" ? owner.root : "",
    };
  } catch {
    return null;
  }
}

/** `kill(pid, 0)` is the portable existence check; `EPERM` means someone else's live pid. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Age of the lock in ms, from the owner file or, if unreadable, the directory's mtime. */
function lockAgeMs(owner: LockOwner | null, dir: string, now: number): number | null {
  if (owner !== null) {
    const started = Date.parse(owner.started_at);
    if (!Number.isNaN(started)) return Math.max(0, now - started);
  }
  try {
    return Math.max(0, now - fs.statSync(dir).mtimeMs);
  } catch {
    return null;
  }
}

/** Whether the holder is gone: dead pid on this host, or older than the cap. */
function isStale(
  owner: LockOwner | null,
  dir: string,
  staleMs: number,
  now: number,
): boolean {
  if (owner !== null && owner.host === os.hostname() && !processAlive(owner.pid)) return true;
  const age = lockAgeMs(owner, dir, now);
  return age !== null && age > staleMs;
}

function busyMessage(owner: LockOwner | null, dir: string, now: number): string {
  let who: string;
  if (owner === null) {
    who = `another process holds \`${dir}\``;
  } else {
    const started = Date.parse(owner.started_at);
    const age = Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000));
    who =
      `\`${owner.tool}\` by ${owner.actor} (pid ${owner.pid}` +
      `${age === null ? "" : `, started ${age}s ago`})`;
  }
  return (
    `Another agent is writing to this plan right now: ${who} holds the planning write lock. ` +
    "Nothing was written. Wait 10 seconds, re-read the node with `plan_read`, and repeat this call."
  );
}

/**
 * Takes the write lock for one planning tree, waiting up to `waitMs`.
 *
 * The caller owns the returned `release` and must call it in a `finally`; a
 * refusal is a normal answer (`{ busy }`), not a thrown error.
 */
export async function acquirePlanWriteLock(
  root: PlanRoot,
  info: PlanLockInfo,
  options: PlanLockOptions = {},
): Promise<PlanLockResult> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = Math.max(0, options.waitMs ?? lockWaitMs());
  const staleMs = Math.max(0, options.staleMs ?? LOCK_STALE_MS);
  const dir = planLockPath(root, options.locksRoot);
  const started = now();

  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch (cause) {
    return {
      busy:
        `Could not create the planning lock directory (${path.dirname(dir)}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Nothing was written.`,
      holder: null,
    };
  }

  for (;;) {
    let acquired = false;
    try {
      fs.mkdirSync(dir);
      acquired = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        return {
          busy:
            `Could not take the planning write lock (${dir}): ` +
            `${cause instanceof Error ? cause.message : String(cause)}. Nothing was written.`,
          holder: null,
        };
      }
    }

    if (acquired) {
      const owner: LockOwner = {
        pid: process.pid,
        host: os.hostname(),
        tool: info.tool,
        actor: info.actor,
        started_at: new Date(now()).toISOString(),
        root: root.relPath,
      };
      try {
        fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
      } catch {
        // The directory itself is the lock; a missing owner file only means the
        // next writer has less to report and falls back to the directory age.
      }
      return { release: () => releasePlanWriteLock(dir), waitedMs: now() - started };
    }

    const holder = readOwner(dir);
    if (isStale(holder, dir, staleMs, now())) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Another waiter recovered it first; the loop re-checks the lock.
      }
      if (!fs.existsSync(dir)) continue;
    }

    if (now() - started >= waitMs) {
      return { busy: busyMessage(holder, dir, now()), holder };
    }
    // A little jitter keeps two waiters from re-checking in lockstep.
    await sleep(100 + Math.floor(Math.random() * 80));
  }
}

/** Releases the lock, unless another process already recovered it as stale. */
function releasePlanWriteLock(dir: string): void {
  const owner = readOwner(dir);
  if (owner !== null && owner.pid !== process.pid) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A missing lock directory is already released.
  }
}
