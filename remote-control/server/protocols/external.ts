// External-window launchers for RDP and VNC (panel launch path).
//
// SSH opens a Paseo terminal tab; RDP and VNC are graphical protocols, so
// the plugin spawns the desktop client detached and its window appears on
// the user's display like any other application window. Credentials never
// enter argv (nothing shows up in `ps`): FreeRDP reads the password from
// stdin via `/from-stdin:force`, TigerVNC reads a 0600 password file written
// by `vncpasswd -f`, with `VNC_PASSWORD`/`VNC_USERNAME` in the child
// environment as the version-dependent fallback.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Connection } from "../../shared/connections";
import { buildRdpArgs, discoverRdpClient } from "./freerdp";
import { prepareVncLaunch } from "./vnc";
import type { ExternalSessionRegistry } from "../sessions";

export { findExecutable } from "./discovery";
export { buildVncArgs } from "./vnc";
// The RDP argv/discovery moved to `protocols/freerdp.ts` in stage 0.27.11
// (E1); the re-exports keep the launcher's public surface where callers and
// the earlier test suite expect it.
export { buildRdpArgs, rdpCsvValue, rdpTarget, RDP_BINARIES, RDP_BINARY_ENV } from "./freerdp";

export interface ExternalVault {
  get: (name: string) => Promise<string>;
}

export interface ExternalLaunchOptions {
  vault?: ExternalVault | null;
  /** Base directory for per-launch material (VNC password files). */
  runDirBase?: string;
  /** PATH override, mainly for tests. */
  pathEnv?: string;
  /** Explicit RDP client from the plugin settings (stage 0.25.11, G2). */
  rdpBinary?: string | null;
  /** Environment used for RDP discovery (`REMOTE_CONTROL_RDP_BIN`, Wayland). */
  discoveryEnv?: NodeJS.ProcessEnv;
  /** Explicit VNC viewer from the plugin settings; per-connection choices win. */
  vncBinary?: string | null;
  /** Session registry: RDP/VNC windows become killable "Sessions" rows. */
  sessions?: ExternalSessionRegistry | null;
  log?: (message: string) => void;
}

export interface ExternalLaunchResult {
  protocol: "rdp" | "vnc";
  /** Base name of the binary that was started. */
  binary: string;
  pid: number;
  /** Registry id of the window; absent when no registry was supplied. */
  sessionId?: string;
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
    const client = discoverRdpClient({
      ...(options.pathEnv !== undefined ? { pathEnv: options.pathEnv } : {}),
      ...(options.discoveryEnv !== undefined ? { env: options.discoveryEnv } : {}),
      binary: options.rdpBinary ?? null,
    });
    const binary = client.binary;
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
    const session = options.sessions?.register({
      connection,
      protocol: "rdp",
      pid,
      binary: path.basename(binary),
    });
    return { protocol: "rdp", binary: path.basename(binary), pid, ...(session ? { sessionId: session.id } : {}) };
  }

  // VNC (stage 0.23.10): vnc-pilot's discovery + per-viewer argv. The
  // prepared run directory holds the passwd file or Remmina profile and is
  // removed by the exit handler below.
  const prepared = await prepareVncLaunch(connection, password, {
    pathEnv: options.pathEnv,
    runDirBase: options.runDirBase,
    ...(options.vncBinary?.trim() ? { binaryOverride: options.vncBinary.trim() } : {}),
    log,
  });
  const pid = spawnWindow(
    {
      binary: prepared.binary,
      args: prepared.argv,
      env: prepared.env,
      ...(prepared.runDir ? { runDir: prepared.runDir } : {}),
    },
    log,
  );
  const binary = path.basename(prepared.binary);
  const session = options.sessions?.register({
    connection,
    protocol: "vnc",
    pid,
    binary,
    runDir: prepared.runDir,
  });
  return { protocol: "vnc", binary, pid, ...(session ? { sessionId: session.id } : {}) };
}
