// SSH launcher (stages D3/D4).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Connection } from "../../shared/connections";
import type { LaunchContext, SpawnSpec } from "./registry";

export interface SshLaunchOptions {
  identityFilePath?: string;
  askpassPath?: string;
  passwordSecret?: string;
}

export function buildSshArgv(connection: Connection, options: SshLaunchOptions = {}): string[] {
  const payload = (connection.payload ?? {}) as Record<string, unknown>;
  const port = connection.port ?? 22;
  const argv: string[] = ["ssh"];
  if (port !== 22) argv.push("-p", String(port));
  if (options.identityFilePath) {
    argv.push("-i", options.identityFilePath, "-o", "IdentitiesOnly=yes");
  }
  const extra = Array.isArray(payload.extraArgs) ? (payload.extraArgs as string[]) : [];
  for (const arg of extra) argv.push(String(arg));
  const strict = payload.strictHostKeyChecking;
  if (typeof strict === "boolean") {
    argv.push("-o", `StrictHostKeyChecking=${strict ? "yes" : "no"}`);
  }
  const target = connection.username && connection.username.length > 0
    ? `${connection.username}@${connection.host}`
    : connection.host;
  argv.push(target);
  return argv;
}

export function materializeIdentity(runDir: string, secretValue: string): string {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(runDir, "id");
  fs.writeFileSync(filePath, secretValue.endsWith("\n") ? secretValue : `${secretValue}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
  return filePath;
}

export function createAskpassHelper(runDir: string, password: string): string {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(runDir, "askpass.sh");
  // The helper prints the password to stdout. It is invoked by ssh with
  // SSH_ASKPASS_REQUIRE=force; the secret never enters argv or env.
  const script = `#!/bin/sh\nprintf '%s\\n' ${shellQuote(password)}\n`;
  fs.writeFileSync(filePath, script, { mode: 0o700 });
  try {
    fs.chmodSync(filePath, 0o700);
  } catch {
    // ignore
  }
  return filePath;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function cleanupRunDir(runDir: string): void {
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export interface SshLaunchPreparation {
  spec: SpawnSpec;
  runDir: string;
}

export async function prepareSshLaunch(
  ctx: LaunchContext,
  vault: { get: (name: string) => Promise<string> },
): Promise<SshLaunchPreparation> {
  const runDir = ctx.runDir;
  const secretRefs = ctx.connection.secretRefs ?? {};
  const options: SshLaunchOptions = {};

  const identitySecret = secretRefs.identitySecret ?? secretRefs.identity;
  if (identitySecret) {
    try {
      const value = await vault.get(identitySecret);
      options.identityFilePath = materializeIdentity(runDir, value);
    } catch {
      // ignore — launch without identity
    }
  }

  const passwordSecret = secretRefs.passwordSecret ?? secretRefs.password;
  let askpassPath: string | undefined;
  if (passwordSecret) {
    try {
      const value = await vault.get(passwordSecret);
      askpassPath = createAskpassHelper(runDir, value);
      options.askpassPath = askpassPath;
    } catch {
      // ignore — interactive fallback
    }
  }

  const argv = buildSshArgv(ctx.connection, options);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (askpassPath) {
    env.SSH_ASKPASS = askpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY = env.DISPLAY ?? ":0";
  }
  return { spec: { argv, env, cwd: undefined }, runDir };
}

export function registerSshLauncher(): void {
  // Lazy registration to avoid circular imports; called from index.server.ts.
}
