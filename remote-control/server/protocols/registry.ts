// Protocol launchers (stage D1/D3). Each protocol implements buildLaunch(),
// which returns a SpawnSpec the session registry turns into a PTY session.

import type { Connection } from "../../shared/connections";
import { getProtocol } from "../../shared/protocols";

export interface LaunchContext {
  connection: Connection;
  /** Resolved secret values (decrypted) keyed by secret field name. */
  secrets: Record<string, string>;
  /** Directory for per-session material (identity files, askpass, etc.). */
  runDir: string;
}

export interface SpawnSpec {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ProtocolLauncher {
  readonly id: string;
  buildLaunch(ctx: LaunchContext): SpawnSpec;
  /** Optional binary discovery; returns the resolved binary path or null. */
  discover?(): string | null;
}

const launchers = new Map<string, ProtocolLauncher>();

export function registerLauncher(launcher: ProtocolLauncher): void {
  launchers.set(launcher.id, launcher);
}

export function getLauncher(id: string): ProtocolLauncher | undefined {
  return launchers.get(id);
}

export function listLaunchers(): ProtocolLauncher[] {
  return [...launchers.values()];
}

export function buildLaunchFor(connection: Connection, ctx: Omit<LaunchContext, "connection">): SpawnSpec {
  const launcher = launchers.get(connection.protocol);
  if (!launcher) throw new Error(`no launcher registered for protocol ${connection.protocol}`);
  return launcher.buildLaunch({ connection, ...ctx });
}

// Validate that the connection's protocol is known.
export function isKnownProtocol(id: string): boolean {
  return getProtocol(id) !== undefined;
}
