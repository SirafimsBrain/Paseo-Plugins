// "Copy key to server" (stage 0.25.11, H3).
//
// Deploys an existing public key into the remote `authorized_keys` with
// ssh-copy-id semantics, over the same ssh launch path the plugin already uses
// for terminals and the connection test: explicit identity when the connection
// has one, the stored password through the askpass helper when it has that, and
// a fail-fast BatchMode when it has neither. Nothing is written locally, no
// secret enters argv, and the remote side only ever appends the one public key
// line — deployment is idempotent because the key is grepped first.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Connection } from "../shared/connections";
import {
  buildSshArgv,
  cleanupRunDir,
  createAskpassHelper,
  materializeIdentity,
} from "./protocols/ssh";
import type { VaultService } from "./vault";

export interface SshExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

export interface SshExecOptions {
  env: Record<string, string | undefined>;
  input?: string;
  timeoutMs: number;
}

export type SshExec = (argv: string[], options: SshExecOptions) => Promise<SshExecResult>;

export interface CopyKeyResult {
  ok: boolean;
  message: string;
  keyType?: string;
  fingerprint?: string;
  added?: boolean;
  source?: string;
}

export interface CopyKeyOptions {
  vault?: VaultService | null;
  runDirBase?: string;
  connectTimeoutSec?: number;
  attemptTimeoutMs?: number;
  /** Injected by tests; the real default spawns the process. */
  exec?: SshExec;
  /** Where to look for a default public key; `~/.ssh` unless overridden. */
  sshDir?: string;
}

/** Appends the key unless it is already there; prints what it did. */
const REMOTE_SCRIPT = [
  "umask 077",
  'mkdir -p "$HOME/.ssh" || exit 1',
  'chmod 700 "$HOME/.ssh" || exit 1',
  'touch "$HOME/.ssh/authorized_keys" || exit 1',
  'chmod 600 "$HOME/.ssh/authorized_keys" || exit 1',
  'key="$(cat)"',
  'if [ -z "$key" ]; then echo "remote-control: empty key" >&2; exit 2; fi',
  'if grep -qxF "$key" "$HOME/.ssh/authorized_keys" 2>/dev/null; then echo REMOTE_CONTROL_PRESENT;',
  'else printf \'%s\\n\' "$key" >> "$HOME/.ssh/authorized_keys" && echo REMOTE_CONTROL_ADDED; fi',
].join("\n");

const ASKPASS_VARS = ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "DISPLAY"];

function defaultRunDirBase(): string {
  const home = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
  return path.join(home, "run");
}

/** SHA256 fingerprint of an OpenSSH public-key line (`SHA256:<base64, no = >`). */
export function publicKeyFingerprint(line: string): string | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  let blob: Buffer;
  try {
    blob = Buffer.from(parts[1], "base64");
  } catch {
    return null;
  }
  if (blob.length === 0) return null;
  return `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export function isPublicKeyLine(value: string): boolean {
  const first = value.trim().split(/\s+/)[0] ?? "";
  return /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/.test(first);
}

const defaultExec: SshExec = (argv, options) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      env: options.env as NodeJS.ProcessEnv,
      stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (result: SshExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 65_536) stdout = stdout.slice(-65_536);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, timedOut: false, spawnError: cause.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut, spawnError: null });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

interface CandidateKey {
  line: string;
  source: string;
}

/**
 * The key to deploy, in priority order: the connection's explicit
 * `payload.publicKeyPath`, its `payload.identityFile` + `.pub`, the public
 * half of its stored identity (derived with `ssh-keygen -y`), then the
 * user's default keys. An agent key is never touched.
 */
async function resolvePublicKey(
  connection: Connection,
  options: CopyKeyOptions,
  runDir: string,
  exec: SshExec,
  timeoutMs: number,
): Promise<CandidateKey> {
  const payload = connection.payload ?? {};
  const explicit = typeof payload.publicKeyPath === "string" ? payload.publicKeyPath.trim() : "";
  if (explicit.length > 0) {
    const file = explicit.startsWith("~/")
      ? path.join(os.homedir(), explicit.slice(2))
      : explicit;
    const text = fs.readFileSync(file, "utf8");
    const line = text.split("\n").find((entry) => entry.trim().length > 0)?.trim() ?? "";
    if (!isPublicKeyLine(line)) throw new Error(`${file} does not contain an OpenSSH public key`);
    return { line, source: file };
  }

  const identityFile = typeof payload.identityFile === "string" ? payload.identityFile.trim() : "";
  if (identityFile.length > 0) {
    const pub = `${identityFile}.pub`;
    try {
      const text = fs.readFileSync(pub, "utf8");
      const line = text.split("\n").find((entry) => entry.trim().length > 0)?.trim() ?? "";
      if (isPublicKeyLine(line)) return { line, source: pub };
    } catch {
      // fall through: an identity without its .pub is derived below
    }
  }

  const refs = connection.secretRefs ?? {};
  const identitySecret = refs.identitySecret ?? refs.identity;
  if (identitySecret && options.vault?.isUnlocked()) {
    try {
      const privatePath = materializeIdentity(runDir, await options.vault.get(identitySecret));
      const derived = await exec(["ssh-keygen", "-y", "-f", privatePath], {
        env: { ...process.env },
        timeoutMs,
      });
      const line = derived.stdout.trim();
      if (derived.code === 0 && isPublicKeyLine(line)) {
        return { line, source: "the identity stored in the secret storage" };
      }
    } catch {
      // fall through to the default keys
    }
  }

  const sshDir = options.sshDir ?? path.join(os.homedir(), ".ssh");
  for (const name of ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]) {
    const file = path.join(sshDir, name);
    try {
      const text = fs.readFileSync(file, "utf8");
      const line = text.split("\n").find((entry) => entry.trim().length > 0)?.trim() ?? "";
      if (isPublicKeyLine(line)) return { line, source: file };
    } catch {
      // try the next default
    }
  }

  throw new Error(
    "no public key found: set payload.publicKeyPath or payload.identityFile on the connection, store an identity in the secret storage, or create ~/.ssh/id_ed25519.pub",
  );
}

function summarizeFailure(result: SshExecResult): string {
  if (result.spawnError) return `ssh could not be started: ${result.spawnError}`;
  if (result.timedOut) return "the key deployment timed out";
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = lines.length > 0 ? lines[lines.length - 1] : "";
  if (tail.length > 0) return tail;
  return `ssh exited with code ${result.code ?? "unknown"}`;
}

export async function copyPublicKey(
  connection: Connection,
  options: CopyKeyOptions = {},
): Promise<CopyKeyResult> {
  if (connection.protocol !== "ssh") {
    return {
      ok: false,
      message: `copying a key supports ssh connections only (this one is ${connection.protocol})`,
    };
  }

  const exec = options.exec ?? defaultExec;
  const connectTimeoutSec = options.connectTimeoutSec ?? 10;
  const timeoutMs = options.attemptTimeoutMs ?? (connectTimeoutSec + 15) * 1000;
  const runDir = path.join(options.runDirBase ?? defaultRunDirBase(), `keycopy_${crypto.randomUUID()}`);

  try {
    let key: CandidateKey;
    try {
      key = await resolvePublicKey(connection, options, runDir, exec, timeoutMs);
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }

    const refs = connection.secretRefs ?? {};
    const identitySecret = refs.identitySecret ?? refs.identity;
    const passwordSecret = refs.passwordSecret ?? refs.password;
    const sshOptions: { identityFilePath?: string } = {};
    if (identitySecret && options.vault?.isUnlocked()) {
      try {
        sshOptions.identityFilePath = materializeIdentity(runDir, await options.vault.get(identitySecret));
      } catch {
        // launch without the explicit identity; the default agent keys still count
      }
    }

    const argv = buildSshArgv(connection, sshOptions);
    const target = argv.pop() ?? connection.host;
    argv.push("-o", `ConnectTimeout=${connectTimeoutSec}`);
    const env: Record<string, string | undefined> = { ...process.env };

    if (passwordSecret && options.vault?.isUnlocked()) {
      try {
        const askpass = createAskpassHelper(runDir, await options.vault.get(passwordSecret));
        env.SSH_ASKPASS = askpass;
        env.SSH_ASKPASS_REQUIRE = "force";
        env.DISPLAY = env.DISPLAY ?? ":0";
        argv.push("-o", "NumberOfPasswordPrompts=1");
      } catch {
        // no helper: fall through to a fail-fast BatchMode attempt
      }
    }
    if (env.SSH_ASKPASS === undefined) {
      for (const name of ASKPASS_VARS) delete env[name];
      argv.push("-o", "BatchMode=yes");
    }
    const strict = (connection.payload ?? {}).strictHostKeyChecking;
    if (typeof strict !== "boolean") argv.push("-o", "StrictHostKeyChecking=accept-new");
    argv.push(target, REMOTE_SCRIPT);

    const result = await exec(argv, { env, input: `${key.line}\n`, timeoutMs });
    const fingerprint = publicKeyFingerprint(key.line) ?? undefined;
    const keyType = key.line.trim().split(/\s+/)[0];

    if (result.code !== 0) {
      return {
        ok: false,
        message: summarizeFailure(result),
        ...(keyType ? { keyType } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        source: key.source,
      };
    }

    const added = result.stdout.includes("REMOTE_CONTROL_ADDED");
    const present = result.stdout.includes("REMOTE_CONTROL_PRESENT");
    return {
      ok: true,
      added,
      message: added
        ? "the public key was added to authorized_keys"
        : present
          ? "the public key is already in authorized_keys"
          : "the key was deployed (the remote shell printed no marker)",
      ...(keyType ? { keyType } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      source: key.source,
    };
  } finally {
    cleanupRunDir(runDir);
  }
}
