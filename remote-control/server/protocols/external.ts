// External-window launchers for RDP and VNC (panel launch path).
//
// SSH opens a Paseo terminal tab; RDP and VNC are graphical protocols, so
// the plugin spawns the desktop client detached and its window appears on
// the user's display like any other application window. Credentials never
// enter argv (nothing shows up in `ps`): FreeRDP reads the password from
// stdin via `/from-stdin:force`, TigerVNC reads a 0600 password file written
// by `vncpasswd -f`, with `VNC_PASSWORD`/`VNC_USERNAME` in the child
// environment as the version-dependent fallback.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Connection } from "../../shared/connections";

export interface ExternalVault {
  get: (name: string) => Promise<string>;
}

export interface ExternalLaunchOptions {
  vault?: ExternalVault | null;
  /** Base directory for per-launch material (VNC password files). */
  runDirBase?: string;
  /** PATH override, mainly for tests. */
  pathEnv?: string;
  log?: (message: string) => void;
}

export interface ExternalLaunchResult {
  protocol: "rdp" | "vnc";
  /** Base name of the binary that was started. */
  binary: string;
  pid: number;
}

/** Candidate client binaries, in preference order (distribution-dependent). */
export const RDP_BINARIES = ["xfreerdp3", "xfreerdp"];
export const VNC_BINARIES = ["vncviewer", "xtigervncviewer"];
export const VNC_PASSWD_BINARIES = ["vncpasswd"];

function defaultRunDirBase(): string {
  const home = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
  return path.join(home, "run");
}

/** Resolves the first executable of `names` found in `pathEnv`. */
export function findExecutable(names: readonly string[], pathEnv = process.env.PATH ?? ""): string | null {
  for (const name of names) {
    for (const dir of pathEnv.split(path.delimiter)) {
      if (dir.length === 0) continue;
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not this entry
      }
    }
  }
  return null;
}

function extraArgs(connection: Connection): string[] {
  const extra = connection.payload?.extraArgs;
  return Array.isArray(extra) ? extra.map(String) : [];
}

/** `host:port` for FreeRDP's `/v:` target. */
export function rdpTarget(connection: Connection): string {
  return `${connection.host}:${connection.port ?? 3389}`;
}

/**
 * FreeRDP argv. `/from-stdin:force` is only added when a password will be
 * piped, so a connection without a stored password keeps FreeRDP's own
 * behaviour. Certificate checks default to `/cert:ignore` because a detached
 * launch has nobody to answer FreeRDP's interactive prompt; a payload `cert`
 * value (e.g. "tofu") or trailing `extraArgs` override it.
 */
export function buildRdpArgs(connection: Connection, options: { withPassword?: boolean } = {}): string[] {
  const payload = connection.payload ?? {};
  const args: string[] = [];
  if (options.withPassword) args.push("/from-stdin:force");
  args.push(`/v:${rdpTarget(connection)}`);
  if (connection.username.length > 0) args.push(`/u:${connection.username}`);
  const cert = typeof payload.cert === "string" && payload.cert.length > 0 ? payload.cert : "ignore";
  args.push(`/cert:${cert}`);
  args.push(...extraArgs(connection));
  return args;
}

/** TigerVNC argv: `host::port` (raw port form) plus an optional passwd file. */
export function buildVncArgs(connection: Connection, options: { passwdFile?: string } = {}): string[] {
  const args: string[] = [`${connection.host}::${connection.port ?? 5900}`];
  if (options.passwdFile) args.push("-passwd", options.passwdFile);
  args.push(...extraArgs(connection));
  return args;
}

/** The stored password of a connection, or null when it has none. */
export async function connectionPassword(
  connection: Connection,
  vault: ExternalVault | null | undefined,
): Promise<string | null> {
  const refs = connection.secretRefs ?? {};
  const name = refs.passwordSecret ?? refs.password;
  if (!name) return null;
  if (!vault) throw new Error("Vault unavailable: cannot resolve the stored password.");
  // Throws "vault is locked" when the vault is locked.
  return await vault.get(name);
}

/** Writes `password` through `vncpasswd -f` into a 0600 TigerVNC passwd file. */
async function writeVncPasswdFile(vncpasswd: string, password: string, runDir: string): Promise<string> {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const output = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(vncpasswd, ["-f"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`vncpasswd -f failed (exit ${code}): ${stderr.trim()}`));
    });
    proc.stdin.end(`${password}\n`);
  });
  const file = path.join(runDir, "vnc.passwd");
  fs.writeFileSync(file, output, { mode: 0o600 });
  return file;
}

function cleanupRunDir(runDir: string): void {
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

interface SpawnPlan {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin and closed immediately (FreeRDP password). */
  stdin?: string;
  /** Removed once the window exits. */
  runDir?: string;
}

function spawnWindow(plan: SpawnPlan, log: (message: string) => void): number {
  const short = path.basename(plan.binary);
  const child = spawn(plan.binary, plan.args, {
    detached: true,
    stdio: [plan.stdin !== undefined ? "pipe" : "ignore", "ignore", "pipe"],
    env: plan.env,
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrTail.length < 8192) stderrTail += chunk.toString("utf8");
  });
  child.on("error", (cause) => {
    log(`[remote-control] ${short} failed to start: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
  child.on("exit", (code) => {
    if (plan.runDir) cleanupRunDir(plan.runDir);
    const tail = stderrTail.trim();
    if (code !== null && code !== 0 && tail.length > 0) {
      log(`[remote-control] ${short} exited with code ${code}: ${tail}`);
    }
  });
  if (plan.stdin !== undefined) child.stdin?.end(plan.stdin);
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`failed to spawn ${short}`);
  }
  return child.pid;
}

/**
 * Opens `connection` in its own desktop window (RDP or VNC) and returns the
 * spawned client. Errors: unknown protocol, missing client binary, locked
 * vault or a vault without the stored password.
 */
export async function launchExternalWindow(
  connection: Connection,
  options: ExternalLaunchOptions = {},
): Promise<ExternalLaunchResult> {
  if (connection.protocol !== "rdp" && connection.protocol !== "vnc") {
    throw new Error(`Protocol ${connection.protocol} does not open an external window.`);
  }
  const log = options.log ?? (() => {});
  const password = await connectionPassword(connection, options.vault);

  if (connection.protocol === "rdp") {
    const binary = findExecutable(RDP_BINARIES, options.pathEnv);
    if (!binary) {
      throw new Error(`RDP client not found (tried ${RDP_BINARIES.join(", ")}): install FreeRDP.`);
    }
    const args = buildRdpArgs(connection, { withPassword: password !== null });
    const pid = spawnWindow(
      {
        binary,
        args,
        env: process.env,
        ...(password !== null ? { stdin: `${password}\n` } : {}),
      },
      log,
    );
    return { protocol: "rdp", binary: path.basename(binary), pid };
  }

  const binary = findExecutable(VNC_BINARIES, options.pathEnv);
  if (!binary) {
    throw new Error(`VNC client not found (tried ${VNC_BINARIES.join(", ")}): install the TigerVNC viewer.`);
  }

  let passwdFile: string | null = null;
  if (password !== null) {
    const vncpasswd = findExecutable(VNC_PASSWD_BINARIES, options.pathEnv);
    if (vncpasswd) {
      const runDir = path.join(options.runDirBase ?? defaultRunDirBase(), `ext_${randomUUID()}`);
      try {
        passwdFile = await writeVncPasswdFile(vncpasswd, password, runDir);
      } catch (cause) {
        cleanupRunDir(runDir);
        log(
          `[remote-control] vncpasswd -f failed, falling back to the VNC_PASSWORD environment: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
  }

  const env = { ...process.env };
  if (password !== null && passwdFile === null) {
    // Version-dependent fallback for TigerVNC builds without -passwd.
    env.VNC_PASSWORD = password;
    if (connection.username.length > 0) env.VNC_USERNAME = connection.username;
  }

  const args = buildVncArgs(connection, passwdFile ? { passwdFile } : {});
  const pid = spawnWindow(
    {
      binary,
      args,
      env,
      ...(passwdFile ? { runDir: path.dirname(passwdFile) } : {}),
    },
    log,
  );
  return { protocol: "vnc", binary: path.basename(binary), pid };
}
