// Workspace terminals (stage 0.17.0, ADR-5 rewrite).
//
// remote-control does not own a PTY and does not render a terminal in the
// console web page. Every terminal is a **Paseo workspace terminal**: the
// daemon spawns the PTY and `paseo.terminals.create()` asks it for one, and
// the Paseo app opens that terminal as a workspace tab. That is the same
// model Orca uses for its terminal tabs — host-owned PTY, terminal view owned
// by the app's tab — which is why no terminal emulation code lives here.

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { Connection } from "../shared/connections";
import { cleanupRunDir, prepareSshLaunch, shellQuote } from "./protocols/ssh";
import type { SpawnSpec } from "./protocols/registry";

export type TerminalKind = "local" | "ssh";

export interface TerminalInfo {
  id: string;
  workspaceId: string;
  cwd: string;
  name: string;
  /** What remote-control knows about the terminal; `local` for foreign ones. */
  kind: TerminalKind;
  connectionId: string | null;
  startedAt: number | null;
}

export interface OpenTerminalInput {
  workspaceId?: string | null;
  connectionId?: string | null;
  cwd?: string | null;
  name?: string | null;
}

export interface TerminalServiceOptions {
  /** Paseo API captured from the plugin RPC handler context; null until the first RPC. */
  paseo: () => PaseoApi | null;
  store?: import("./store").Store | null;
  vault?: import("./vault").VaultService | null;
  /** Base directory for per-terminal material (identity files, askpass helpers). */
  runDirBase?: string;
  now?: () => number;
}

interface TerminalMeta {
  kind: TerminalKind;
  connectionId: string | null;
  title: string;
  workspaceId: string;
  startedAt: number;
  runDir: string | null;
}

function defaultRunDirBase(): string {
  const home = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
  return path.join(home, "run");
}

/**
 * Builds the shell wrapper Paseo runs for an ssh launch.
 *
 * The daemon's create-terminal request carries `command`/`args` but no
 * environment, so the variables a launch needs (`SSH_ASKPASS`,
 * `SSH_ASKPASS_REQUIRE`, `DISPLAY`) are exported inside the wrapper, and the
 * per-terminal run directory (identity file, askpass helper) is removed once
 * ssh exits — without `exec`, which would drop that cleanup.
 */
export function buildSshCommand(spec: SpawnSpec, runDir: string): { command: string; args: string[] } {
  const base = process.env as Record<string, string | undefined>;
  const exports: string[] = [];
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (value !== undefined && value !== base[key]) {
      exports.push(`export ${key}=${shellQuote(value)}`);
    }
  }
  const lines = [
    ...exports,
    spec.argv.map(shellQuote).join(" "),
    "rc=$?",
    `rm -rf -- ${shellQuote(runDir)}`,
    "exit $rc",
  ];
  return { command: "/bin/sh", args: ["-c", lines.join("\n")] };
}

export class TerminalService {
  private readonly meta = new Map<string, TerminalMeta>();
  private readonly paseo: () => PaseoApi | null;
  private readonly store: import("./store").Store | null;
  private readonly vault: import("./vault").VaultService | null;
  private readonly runDirBase: string;
  private readonly now: () => number;

  constructor(options: TerminalServiceOptions) {
    this.paseo = options.paseo;
    this.store = options.store ?? null;
    this.vault = options.vault ?? null;
    this.runDirBase = options.runDirBase ?? defaultRunDirBase();
    this.now = options.now ?? (() => Date.now());
  }

  private api(): PaseoApi {
    const paseo = this.paseo();
    if (!paseo) {
      throw new Error(
        "Paseo API is not ready yet: open the Remote Control panel or console once so the plugin can talk to the daemon.",
      );
    }
    return paseo;
  }

  /** A workspace to attach terminals to: the requested one, or the only one available. */
  async resolveWorkspaceId(requested?: string | null): Promise<string> {
    const trimmed = requested?.trim();
    if (trimmed) return trimmed;
    const { entries } = await this.api().workspaces.list();
    if (entries.length === 1) return entries[0].id;
    if (entries.length === 0) throw new Error("No Paseo workspaces are available.");
    throw new Error(
      "workspaceId is required: several workspaces exist. Open the console from a workspace tab in Paseo.",
    );
  }

  async open(input: OpenTerminalInput = {}): Promise<TerminalInfo> {
    const paseo = this.api();
    const workspaceId = await this.resolveWorkspaceId(input.workspaceId);
    const connectionId = input.connectionId?.trim() || null;

    if (connectionId === null) {
      const created = await paseo.terminals.create({
        workspaceId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        name: input.name?.trim() || "remote-control shell",
      });
      const snapshot = created.current();
      this.remember(created.id, {
        kind: "local",
        connectionId: null,
        title: snapshot?.name ?? "shell",
        workspaceId,
        runDir: null,
      });
      return this.info(created.id, workspaceId, snapshot?.cwd ?? input.cwd ?? "", snapshot?.name ?? "shell");
    }

    const connection = this.store?.getConnection(connectionId);
    if (!connection) throw new Error(`Connection not found: ${connectionId}`);
    if (connection.protocol !== "ssh") {
      throw new Error(`Protocol ${connection.protocol} is not launchable yet.`);
    }
    if (!this.vault) throw new Error("Vault unavailable: cannot resolve ssh credentials.");

    const runDir = path.join(this.runDirBase, `term_${randomUUID()}`);
    let command: { command: string; args: string[] };
    try {
      const { spec } = await prepareSshLaunch(
        { connection, secrets: {}, runDir },
        { get: (name) => this.vault!.get(name) },
      );
      command = buildSshCommand(spec, runDir);
    } catch (cause) {
      cleanupRunDir(runDir);
      throw cause;
    }

    try {
      const created = await paseo.terminals.create({
        workspaceId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        name: input.name?.trim() || connection.name,
        command: command.command,
        args: command.args,
      });
      const snapshot = created.current();
      this.remember(created.id, {
        kind: "ssh",
        connectionId,
        title: snapshot?.name ?? connection.name,
        workspaceId,
        runDir,
      });
      return this.info(created.id, workspaceId, snapshot?.cwd ?? input.cwd ?? "", snapshot?.name ?? connection.name);
    } catch (cause) {
      cleanupRunDir(runDir);
      throw cause;
    }
  }

  /** Terminals of a workspace (`workspaceId` omitted = every terminal on the host). */
  async list(workspaceId?: string | null): Promise<TerminalInfo[]> {
    const paseo = this.api();
    const trimmed = workspaceId?.trim();
    const { entries } = await paseo.terminals.list(trimmed ? { workspaceId: trimmed } : {});
    const live = new Set(entries.map((entry) => entry.id));

    // Terminals that ended on their own (user typed `exit`) take their run
    // directory and metadata with them on the next refresh. A scoped listing
    // only proves absence inside its own workspace, so other workspaces'
    // entries are left alone.
    for (const [id, meta] of [...this.meta]) {
      if (live.has(id)) continue;
      if (trimmed && meta.workspaceId !== trimmed) continue;
      if (meta.runDir) cleanupRunDir(meta.runDir);
      this.meta.delete(id);
    }

    return entries.map((entry) => this.info(entry.id, entry.workspaceId, entry.cwd, entry.name));
  }

  async kill(terminalId: string): Promise<boolean> {
    const paseo = this.api();
    try {
      await paseo.terminals.ref(terminalId).kill();
    } catch {
      return false;
    }
    this.forget(terminalId);
    return true;
  }

  /** Removes every run directory this plugin created (plugin cleanup). */
  dispose(): void {
    for (const id of [...this.meta.keys()]) this.forget(id);
  }

  private remember(id: string, meta: Omit<TerminalMeta, "startedAt">): void {
    this.meta.set(id, { ...meta, startedAt: this.now() });
  }

  private forget(id: string): void {
    const meta = this.meta.get(id);
    if (!meta) return;
    if (meta.runDir) cleanupRunDir(meta.runDir);
    this.meta.delete(id);
  }

  private info(id: string, workspaceId: string, cwd: string, name: string): TerminalInfo {
    const meta = this.meta.get(id);
    return {
      id,
      workspaceId,
      cwd,
      name: meta?.title || name,
      kind: meta?.kind ?? "local",
      connectionId: meta?.connectionId ?? null,
      startedAt: meta?.startedAt ?? null,
    };
  }
}
