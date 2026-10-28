// SSH connection test (stage 0.21.10).
//
// The test answers the question the plugin needs before choosing how to
// connect: does this host already accept the public key, or does it still
// only take the stored password? Two attempts, in priority order:
//
//   1. key only      — BatchMode=yes, no askpass in the env: ssh cannot fall
//                      back to prompting, so exit 0 means real key auth;
//   2. stored password — SSH_ASKPASS helper from the secret storage (same
//                      mechanism as a terminal launch), one prompt max.
//
// Success records `payload.auth` ("key" or "password"; default stays
// "unknown") so later stages — first of all the public-key copy — know the
// actual state of the host. A failed probe never clears a known flag: a
// transient network error must not erase a previously proven method.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Connection } from "../shared/connections";
import {
  buildSshArgv,
  cleanupRunDir,
  createAskpassHelper,
  materializeIdentity,
} from "./protocols/ssh";
import type { VaultService } from "./vault";

export interface SshProbeResult {
  ok: boolean;
  auth: "key" | "password" | "unknown";
  message: string;
}

export interface ProbeOptions {
  vault?: VaultService | null;
  /** Base directory for the per-probe run directory (identity + askpass). */
  runDirBase?: string;
  /** ssh `-o ConnectTimeout` per attempt. */
  connectTimeoutSec?: number;
  /** Hard kill deadline per attempt. */
  attemptTimeoutMs?: number;
}

/** Injected by tests; the real default is `testSshConnection`. */
export type SshProbe = (
  connection: Connection,
  vault: VaultService | null,
) => Promise<SshProbeResult>;

interface AttemptOutcome {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

/** Askpass variables must be absent for the key-only attempt. */
const ASKPASS_VARS = ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "DISPLAY"];

function defaultRunDirBase(): string {
  const home = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
  return path.join(home, "run");
}

/**
 * Probe argv: options must precede the destination, so the target that
 * `buildSshArgv` appended last is re-pushed after the probe options.
 * `accept-new` keeps a first contact (unknown host) from failing the probe
 * outright — the same trust-on-first-use a human would accept interactively —
 * unless the connection pins its own StrictHostKeyChecking value.
 */
function probeArgv(
  connection: Connection,
  options: { identityFilePath?: string },
  connectTimeoutSec: number,
  batchMode: boolean,
): string[] {
  const argv = buildSshArgv(connection, options);
  const target = argv.pop() ?? connection.host;
  argv.push("-o", `ConnectTimeout=${connectTimeoutSec}`);
  if (batchMode) {
    argv.push("-o", "BatchMode=yes");
  } else {
    argv.push("-o", "NumberOfPasswordPrompts=1");
  }
  const strict = (connection.payload ?? {}).strictHostKeyChecking;
  if (typeof strict !== "boolean") {
    argv.push("-o", "StrictHostKeyChecking=accept-new");
  }
  argv.push(target);
  return argv;
}

function runSsh(
  argv: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (outcome: AttemptOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      done({ code: null, stderr, timedOut: false, spawnError: cause.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stderr, timedOut, spawnError: null });
    });
  });
}

function summarize(outcome: AttemptOutcome, connectTimeoutSec: number): string {
  if (outcome.spawnError) return `ssh could not be started: ${outcome.spawnError}`;
  if (outcome.timedOut) return `connection timed out after ${connectTimeoutSec}s`;
  const lines = outcome.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = lines.length > 0 ? lines[lines.length - 1] : "";
  if (tail.length > 0) return tail;
  return `ssh exited with code ${outcome.code ?? "unknown"}`;
}

export async function testSshConnection(
  connection: Connection,
  options: ProbeOptions = {},
): Promise<SshProbeResult> {
  if (connection.protocol !== "ssh") {
    return {
      ok: false,
      auth: "unknown",
      message: `the connection test supports ssh only (this connection is ${connection.protocol})`,
    };
  }

  const vault = options.vault ?? null;
  const connectTimeoutSec = options.connectTimeoutSec ?? 6;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? (connectTimeoutSec + 6) * 1000;
  const runDir = path.join(options.runDirBase ?? defaultRunDirBase(), `probe_${randomUUID()}`);

  try {
    const refs = connection.secretRefs ?? {};

    // --- attempt 1: public key only ---------------------------------------
    let identityFilePath: string | undefined;
    const identityRef = refs.identitySecret ?? refs.identity;
    if (identityRef && vault?.isUnlocked()) {
      try {
        identityFilePath = materializeIdentity(runDir, await vault.get(identityRef));
      } catch {
        // ignore — probe without an explicit identity (agent keys still count)
      }
    }
    const keyEnv: Record<string, string | undefined> = { ...process.env };
    for (const name of ASKPASS_VARS) delete keyEnv[name];
    const keyArgv = probeArgv(
      connection,
      identityFilePath ? { identityFilePath } : {},
      connectTimeoutSec,
      true,
    );
    const keyOutcome = await runSsh(keyArgv, keyEnv, attemptTimeoutMs);
    if (keyOutcome.code === 0) {
      return { ok: true, auth: "key", message: "the host accepted the public key" };
    }
    const keyError = summarize(keyOutcome, connectTimeoutSec);

    // --- attempt 2: the stored password -----------------------------------
    const passwordRef = refs.passwordSecret ?? refs.password;
    if (!passwordRef) {
      return { ok: false, auth: "unknown", message: keyError };
    }
    if (!vault?.isUnlocked()) {
      return {
        ok: false,
        auth: "unknown",
        message: `${keyError}; the stored password is unavailable — unlock the secret storage in the Remote Control panel`,
      };
    }
    let password: string;
    try {
      password = await vault.get(passwordRef);
    } catch (cause) {
      return {
        ok: false,
        auth: "unknown",
        message: `${keyError}; the stored password could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    const askpassPath = createAskpassHelper(runDir, password);
    const passwordEnv: Record<string, string | undefined> = {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY ?? ":0",
    };
    const passwordArgv = probeArgv(connection, {}, connectTimeoutSec, false);
    const passwordOutcome = await runSsh(passwordArgv, passwordEnv, attemptTimeoutMs);
    if (passwordOutcome.code === 0) {
      return {
        ok: true,
        auth: "password",
        message: "the public key was refused, the stored password authenticated",
      };
    }
    return {
      ok: false,
      auth: "unknown",
      message: `${keyError}; password attempt: ${summarize(passwordOutcome, connectTimeoutSec)}`,
    };
  } finally {
    cleanupRunDir(runDir);
  }
}
