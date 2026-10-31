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
import { findExecutable } from "./discovery";
import { prepareVncLaunch } from "./vnc";
import type { ExternalSessionRegistry } from "../sessions";

export { findExecutable } from "./discovery";
export { buildVncArgs } from "./vnc";

export interface ExternalVault {
  get: (name: string) => Promise<string>;
}

export interface ExternalLaunchOptions {
  vault?: ExternalVault | null;
  /** Base directory for per-launch material (VNC password files). */
  runDirBase?: string;
  /** PATH override, mainly for tests. */
  pathEnv?: string;
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

/** Candidate RDP client binaries, in preference order (distribution-dependent). */
export const RDP_BINARIES = ["xfreerdp3", "xfreerdp"];

function extraArgs(connection: Connection): string[] {
  const extra = connection.payload?.extraArgs;
  return Array.isArray(extra) ? extra.map(String) : [];
}

/** Host ready for FreeRDP's `/v:` — IPv6 literals wrapped in brackets. */
function formatRdpHost(host: string): string {
  if (host.startsWith("[")) return host;
  return host.split(":").length >= 3 ? `[${host}]` : host;
}

/** `host:port` for FreeRDP's `/v:` target. */
export function rdpTarget(connection: Connection): string {
  return `${formatRdpHost(connection.host)}:${connection.port ?? 3389}`;
}

/**
 * Quotes a value only for FreeRDP's comma-separated sub-option parser
 * (`/kbd:` and friends): those run through a whitespace/quote-aware
 * tokenizer, while plain scalar options (`/u:`, `/t:`, `/d:`) are taken
 * verbatim and quotes would become part of the value. Port of rdp-pilot's
 * `_csv_value`.
 */
export function rdpCsvValue(value: string): string {
  if (!value || !/[ \t,"'\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * FreeRDP 3 argv, ported from rdp-pilot's `build_spawn()`: target, title,
 * domain, then the option groups in the Python order (display, performance,
 * redirection, security, keyboard, network, codecs), `extraArgs` last.
 * `/from-stdin:force` is only added when a password will be piped, so a
 * connection without a stored password keeps FreeRDP's own behaviour and no
 * secret ever reaches argv. Certificates default to `/cert:ignore` because a
 * detached launch has nobody to answer FreeRDP's interactive prompt; a
 * payload `cert` value (e.g. "tofu") overrides it. Fields absent from the
 * payload emit nothing, so rows created before stage 0.22.10 launch exactly
 * as they did before (stage 0.22.10).
 */
export function buildRdpArgs(connection: Connection, options: { withPassword?: boolean } = {}): string[] {
  const payload = connection.payload ?? {};
  const str = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const bool = (key: string): boolean | undefined =>
    typeof payload[key] === "boolean" ? payload[key] : undefined;

  const args: string[] = [];
  if (options.withPassword) args.push("/from-stdin:force");
  args.push(`/v:${rdpTarget(connection)}`);
  if (connection.username.length > 0) args.push(`/u:${connection.username}`);
  // Window title = connection name, so several open windows stay tellable
  // instead of all showing the host FreeRDP picks by default.
  const title = connection.name.trim();
  if (title.length > 0) args.push(`/t:${title}`);
  const domain = str("domain");
  if (domain) args.push(`/d:${domain}`);

  // Display
  if (bool("dynamicResolution") === true) args.push("+dynamic-resolution");
  if (bool("fullscreen") === true) {
    args.push("/f");
  } else if (typeof payload.width === "number" && typeof payload.height === "number") {
    args.push(`/size:${payload.width}x${payload.height}`);
  }
  const bpp = str("bpp");
  if (bpp) args.push(`/bpp:${bpp}`);
  if (bool("workarea") === true) args.push("/workarea");
  if (bool("multimon") === true) args.push("/multimon");

  // Performance
  const fonts = bool("fonts");
  if (fonts !== undefined) args.push(fonts ? "+fonts" : "-fonts");
  if (bool("aero") === true) args.push("+aero");
  if (bool("windowDrag") === true) args.push("+window-drag");
  if (bool("menuAnims") === true) args.push("+menu-anims");
  const themes = bool("themes");
  if (themes !== undefined) args.push(themes ? "+themes" : "-themes");
  const wallpaper = bool("wallpaper");
  if (wallpaper !== undefined) args.push(wallpaper ? "+wallpaper" : "-wallpaper");
  const gdi = str("gdi");
  if (gdi) args.push(`/gdi:${gdi}`);

  // Redirection
  const clipboard = bool("clipboard");
  if (clipboard !== undefined) args.push(clipboard ? "+clipboard" : "-clipboard");
  if (bool("drives") === true) args.push("+drives");
  if (bool("homeDrive") === true) args.push("+home-drive");
  if (bool("printers") === true) args.push("/printer");
  if (bool("smartcards") === true) args.push("/smartcard");
  const serial = str("serial");
  if (serial) args.push(`/serial:${serial}`);
  const sound = str("sound");
  if (sound) {
    // rdp-pilot's audio-mode: "0" play on this computer, "1" play on the
    // remote one, "2" do not play (then /sound is pointless).
    if (sound !== "2") args.push("/sound");
    args.push(`/audio-mode:${sound}`);
  }
  if (bool("microphone") === true) args.push("/microphone");

  // Security
  const sec = str("sec");
  if (sec) args.push(`/sec:${sec}`);
  const cert = str("cert");
  if (cert) {
    args.push(`/cert:${cert}`);
  } else {
    if (bool("certIgnore") !== false) args.push("/cert:ignore");
    const certName = str("certName");
    if (certName) args.push(`/cert:name:${certName}`);
  }

  // Keyboard — FreeRDP 3 compound option, CSV values quoted when needed.
  const kbdLayout = str("kbdLayout");
  const kbdType = str("kbdType");
  if (kbdLayout || kbdType) {
    const parts: string[] = [];
    if (kbdLayout) parts.push(`layout:${rdpCsvValue(kbdLayout)}`);
    if (kbdType) parts.push(`type:${kbdType}`);
    args.push(`/kbd:${parts.join(",")}`);
  }

  // Network
  const network = str("network");
  if (network) args.push(`/network:${network}`);
  if (bool("compression") === false) args.push("-compression");

  // Codecs
  if (bool("rfx") === true) args.push("/rfx");
  if (bool("nsc") === true) args.push("/nsc");
  if (bool("jpeg") === true) args.push("/jpeg");
  const jpegQuality = str("jpegQuality");
  if (jpegQuality) args.push(`/jpeg-quality:${jpegQuality}`);

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
