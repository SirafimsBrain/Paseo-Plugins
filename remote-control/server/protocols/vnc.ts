// VNC launcher (stage 0.23.10) — the port of vnc-pilot's `__init__.py`.
//
// vnc-pilot is a launcher, not a framebuffer client: it discovers the viewer
// installed on this machine, builds that viewer's argv and lets the viewer
// own the window. This module keeps that split:
//
// - discovery by PATH + version fingerprint (`vncviewer` is shared by
//   TigerVNC / TurboVNC / TightVNC / RealVNC, so an un-fingerprinted shared
//   binary is refused instead of being launched with the wrong flags);
// - per-viewer argv builders (TigerVNC, TurboVNC, TightVNC, RealVNC,
//   Remmina, KRDC, Vinagre, gvncviewer, Custom);
// - password handling: truncate to VNC's 8 characters, convert through
//   `vncpasswd -f` into a 0600 file; when that tool is missing TigerVNC /
//   TurboVNC get the `VNC_PASSWORD` environment fallback, every other viewer
//   prompts itself. The secret never enters argv;
// - target formatting: display number wins over port, embedded `host:port`
//   wins over the connection row, IPv6 literals are bracketed.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Connection } from "../../shared/connections";
import {
  VNC_CLIENT_IDS,
  VNC_CLIENT_LABELS,
  type VncClientId,
} from "../../shared/vnc-fields";
import { findExecutable, isExecutable } from "./discovery";

const execFileAsync = promisify(execFile);

/** VNC challenge/response derives its key from the first 8 characters. */
export const VNC_PASSWORD_MAX = 8;

/** Discovery cache lifetime (vnc-pilot's `_DISCOVERY_TTL_SECONDS`). */
export const VNC_DISCOVERY_TTL_MS = 30_000;

export interface VncClientSpec {
  binaries: readonly string[];
  versionMarkers: readonly string[];
}

/**
 * Viewer definitions from vnc-pilot, in its preference order. The `custom`
 * pseudo-client has no binaries: its path comes from the payload.
 */
export const VNC_CLIENT_SPECS: Record<Exclude<VncClientId, "custom">, VncClientSpec> = {
  tigervnc: { binaries: ["vncviewer", "xtigervncviewer"], versionMarkers: ["TigerVNC"] },
  turbovnc: { binaries: ["vncviewer", "tvncviewer"], versionMarkers: ["TurboVNC"] },
  tightvnc: { binaries: ["vncviewer", "xtightvncviewer"], versionMarkers: ["TightVNC"] },
  realvnc: { binaries: ["vncviewer"], versionMarkers: ["RealVNC"] },
  remmina: { binaries: ["remmina"], versionMarkers: ["Remmina"] },
  krdc: { binaries: ["krdc"], versionMarkers: ["krdc"] },
  vinagre: { binaries: ["vinagre"], versionMarkers: ["vinagre"] },
  gvncviewer: { binaries: ["gvncviewer"], versionMarkers: ["gvncviewer"] },
};

const CLIENT_ORDER = VNC_CLIENT_IDS.filter((id): id is Exclude<VncClientId, "custom"> => id !== "custom");

/** The bare `vncviewer` name must be identified by its version output. */
const SHARED_BINARY_NAMES = new Set(["vncviewer"]);

export interface VncClientInfo {
  clientId: VncClientId;
  binary: string;
  displayName: string;
}

export interface VncDiscoveryOptions {
  pathEnv?: string;
  /** Version probe override, mainly for tests. */
  versionOutput?: (binary: string) => Promise<string>;
  now?: () => number;
  ttlMs?: number;
  /** Set false to bypass the process-wide cache (tests). */
  useCache?: boolean;
}

interface DiscoveryCacheEntry {
  key: string;
  at: number;
  clients: VncClientInfo[];
}

let discoveryCache: DiscoveryCacheEntry | null = null;

/** Drops the discovery cache (tests and fresh-install refresh). */
export function resetVncDiscoveryCache(): void {
  discoveryCache = null;
}

function defaultRunDirBase(): string {
  const home = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
  return path.join(home, "run");
}

// ---------------------------------------------------------------------------
// Target / payload helpers
// ---------------------------------------------------------------------------

/** Strict port parse (vnc-pilot's `_parse_port`): invalid is `null`. */
export function parseVncPort(value: unknown, fallback = 5900): number | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
  }
  if (typeof value === "string") {
    const digits = value.trim();
    if (digits.length === 0) return fallback;
    if (!/^\d+$/.test(digits)) return null;
    const parsed = Number(digits);
    return parsed > 0 && parsed < 65536 ? parsed : null;
  }
  return null;
}

/** Splits an optional `:port` suffix off a host, IPv6-aware. */
export function splitHostPort(host: string): [string, number | null] {
  const value = (host ?? "").trim();
  if (value.length === 0) return ["", null];
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end !== -1) {
      const inner = value.slice(1, end);
      const rest = value.slice(end + 1);
      if (rest.startsWith(":") && /^\d+$/.test(rest.slice(1))) {
        return [inner, Number(rest.slice(1))];
      }
      return [inner, null];
    }
  }
  if (value.split(":").length === 2) {
    const head = value.slice(0, value.indexOf(":"));
    const tail = value.slice(value.indexOf(":") + 1);
    if (/^\d+$/.test(tail)) return [head, Number(tail)];
  }
  return [value, null];
}

/** Host ready for a viewer target — IPv6 literals wrapped in brackets. */
export function formatVncHost(host: string): string {
  if (host.startsWith("[")) return host;
  return host.split(":").length >= 3 ? `[${host}]` : host;
}

function payload(connection: Connection): Record<string, unknown> {
  return connection.payload ?? {};
}

function displayNumber(connection: Connection): number | null {
  const value = payload(connection).display;
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Effective VNC port: display number (5900 + N) > a port embedded in the
 * host field > the connection's port column > 5900.
 */
export function vncPort(connection: Connection): number {
  const display = displayNumber(connection);
  if (display !== null) return 5900 + display;
  const [, embedded] = splitHostPort(connection.host);
  if (embedded !== null && embedded > 0 && embedded < 65536) return embedded;
  return parseVncPort(connection.port ?? null) ?? 5900;
}

/** `host:display` when a display number is set, else `host::port`. */
export function vncTarget(connection: Connection): string {
  const host = (connection.host ?? "").trim();
  if (host.length === 0) return "";
  const [bare] = splitHostPort(host);
  const display = displayNumber(connection);
  if (display !== null) return `${formatVncHost(bare)}:${display}`;
  return `${formatVncHost(bare)}::${vncPort(connection)}`;
}

/** `vnc://host:port` for GUI clients (KRDC, Vinagre, Remmina fallback). */
export function vncUri(connection: Connection): string {
  const host = (connection.host ?? "").trim();
  if (host.length === 0) return "";
  const [bare] = splitHostPort(host);
  return `vnc://${formatVncHost(bare)}:${vncPort(connection)}`;
}

/** vnc-pilot's host validation messages. */
export function validateVncHost(host: string): string | null {
  const value = (host ?? "").trim();
  if (value.length === 0) return "Host is required.";
  if (value.startsWith("-")) return "Host must not start with '-' (it would be parsed as an option).";
  if (/\s/.test(value)) return "Host must not contain whitespace.";
  return null;
}

/** Splits `extra_args` like a shell, falling back to whitespace splitting. */
export function splitExtraArgs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const input = value.trim();
  if (input.length === 0) return [];
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote !== null) return input.split(/\s+/).filter((word) => word.length > 0);
  if (escaped) current += "\\";
  if (current.length > 0) words.push(current);
  return words;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function binaryMatches(binaryName: string, output: string, spec: VncClientSpec): boolean {
  if (output.trim().length > 0) {
    const lowered = output.toLowerCase();
    return spec.versionMarkers.some((marker) => lowered.includes(marker.toLowerCase()));
  }
  return !SHARED_BINARY_NAMES.has(binaryName);
}

/**
 * Runs `--version`-style flags once per binary and caches the output for the
 * duration of one discovery pass. vnc-pilot caches by path for the same
 * reason: several candidate clients share the `vncviewer` binary.
 */
function versionProbe(): (binary: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (binary) => {
    const cached = cache.get(binary);
    if (cached) return cached;
    const probe = (async (): Promise<string> => {
      for (const flag of ["--version", "-version", "-help", "-v"]) {
        try {
          const result = await execFileAsync(binary, [flag], {
            timeout: 1000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
            env: process.env,
          });
          const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
          if (output.trim().length > 0) return output;
        } catch (cause) {
          const error = cause as { stdout?: string; stderr?: string };
          const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
          if (output.trim().length > 0) return output;
        }
      }
      return "";
    })();
    cache.set(binary, probe);
    return probe;
  };
}

/**
 * Discovers installed VNC viewers by scanning PATH and fingerprinting their
 * version output. Results are cached for 30 s (deterministic order: TigerVNC,
 * TurboVNC, TightVNC, RealVNC, Remmina, KRDC, Vinagre, gvncviewer).
 */
export async function discoverVncClients(options: VncDiscoveryOptions = {}): Promise<VncClientInfo[]> {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? VNC_DISCOVERY_TTL_MS;
  const useCache = options.useCache ?? true;
  if (useCache && discoveryCache !== null && discoveryCache.key === pathEnv && now() - discoveryCache.at < ttl) {
    return [...discoveryCache.clients];
  }

  const probe = options.versionOutput ?? versionProbe();
  const results: VncClientInfo[] = [];
  const probed = new Map<string, string>();

  for (const clientId of CLIENT_ORDER) {
    const spec = VNC_CLIENT_SPECS[clientId];
    for (const binaryName of spec.binaries) {
      const binary = findExecutable([binaryName], pathEnv);
      if (binary === null) continue;
      let output = probed.get(binary);
      if (output === undefined) {
        output = await probe(binary);
        probed.set(binary, output);
      }
      if (!binaryMatches(binaryName, output, spec)) continue;
      results.push({ clientId, binary, displayName: VNC_CLIENT_LABELS[clientId] });
      break;
    }
  }

  if (useCache) discoveryCache = { key: pathEnv, at: now(), clients: results };
  return [...results];
}

function resolveCustomBinary(value: string, pathEnv: string | undefined): string {
  const custom = value.trim();
  if (custom.length === 0) throw new Error("No custom VNC client path provided.");
  if (custom.includes(path.sep)) {
    if (!isExecutable(custom)) {
      throw new Error(`Custom VNC client '${custom}' does not exist or is not executable.`);
    }
    return custom;
  }
  const binary = findExecutable([custom], pathEnv);
  if (binary === null) throw new Error(`Custom VNC client '${custom}' was not found on PATH.`);
  return binary;
}

/**
 * Picks the viewer for a connection: `customBinary` > explicit `vncClient`
 * > first installed client (the legacy-row fallback of vnc-pilot). There is
 * deliberately no implicit "auto" value in the form.
 */
export async function resolveVncClient(
  connection: Connection,
  options: VncDiscoveryOptions = {},
): Promise<VncClientInfo> {
  const data = payload(connection);
  const custom = typeof data.customBinary === "string" ? data.customBinary.trim() : "";
  if (custom.length > 0) {
    const binary = resolveCustomBinary(custom, options.pathEnv);
    return { clientId: "custom", binary, displayName: path.basename(binary) || "custom" };
  }

  const selected = typeof data.vncClient === "string" ? data.vncClient.trim() : "";
  const discovered = await discoverVncClients(options);
  if (selected === "custom") {
    throw new Error("Custom binary path is required when 'Custom' is selected.");
  }
  if (selected.length > 0) {
    const match = discovered.find((client) => client.clientId === selected);
    if (match) return match;
    throw new Error(
      `VNC client '${selected}' is not installed on this system. Install it, choose another client, or set a custom binary path for this connection.`,
    );
  }
  if (discovered.length > 0) return discovered[0];
  throw new Error(
    "No VNC client was found on this system. Install one of: TigerVNC, TurboVNC, TightVNC, RealVNC, Remmina, KRDC, Vinagre, gvncviewer - or set a custom binary path for this connection.",
  );
}

// ---------------------------------------------------------------------------
// Password file
// ---------------------------------------------------------------------------

/** VNC passwords are 8 characters by protocol; mirror vncpasswd's truncation. */
export function truncateVncPassword(password: string): string {
  return password.length > VNC_PASSWORD_MAX ? password.slice(0, VNC_PASSWORD_MAX) : password;
}

/** Writes `password` through `vncpasswd -f` into a 0600 VNC passwd file. */
export async function writeVncPasswdFile(vncpasswd: string, password: string, runDir: string): Promise<string> {
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
    // A failing vncpasswd can exit before it reads stdin; without this the
    // EPIPE becomes an unhandled stream error instead of the real failure.
    proc.stdin.on("error", () => {});
    proc.stdin.end(`${truncateVncPassword(password)}\n`);
  });
  const file = path.join(runDir, "vnc.passwd");
  fs.writeFileSync(file, output, { mode: 0o600 });
  return file;
}

/** Removes a per-launch directory (passwd file / Remmina profile). */
export function cleanupVncRunDir(runDir: string): void {
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// argv builders
// ---------------------------------------------------------------------------

export interface VncArgvOptions {
  passwordFile?: string | null;
  /** Temporary `.remmina` profile (Remmina only). */
  profileFile?: string | null;
}

function str(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bool(data: Record<string, unknown>, key: string): boolean | undefined {
  return typeof data[key] === "boolean" ? (data[key] as boolean) : undefined;
}

function remminaQuality(value: string | undefined): number | null {
  if (!value) return null;
  const map: Record<string, number> = { "0": 0, "1": 1, "2": 2, "9": 9 };
  return map[value] ?? 2;
}

function buildRemminaProfile(connection: Connection): string {
  const data = payload(connection);
  const lines = [
    "[remmina]",
    `name=${String(connection.name || "VNC Pilot").replace(/[\r\n]+/g, " ").trim()}`,
    "protocol=VNC",
    `server=${formatVncHost(splitHostPort(connection.host)[0])}:${vncPort(connection)}`,
    `viewonly=${bool(data, "viewOnly") === true ? 1 : 0}`,
    "disablepasswordstoring=0",
  ];
  if (bool(data, "fullscreen") === true) lines.push("viewmode=2");
  const quality = remminaQuality(str(data, "quality"));
  if (quality !== null) lines.push(`quality=${quality}`);
  const colorDepth = str(data, "colorDepth");
  if (colorDepth && ["8", "16", "24", "32"].includes(colorDepth)) {
    lines.push(`colordepth=${Number(colorDepth)}`);
  }
  if (connection.username.length > 0) {
    lines.push(`username=${connection.username.replace(/[\r\n]+/g, " ").trim()}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the temporary Remmina profile next to a launch and returns its path.
 * Remmina reads the password from the profile, so the file is 0600 and the
 * run directory is removed when the window exits.
 */
export function writeRemminaProfile(connection: Connection, password: string | null, runDir: string): string {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, "remote-control.remmina");
  let content = buildRemminaProfile(connection);
  if (password !== null) {
    const value = password.replace(/[\r\n]+/g, " ").trim();
    content += `password=${value}\n`;
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

/**
 * One builder per viewer family, mirroring vnc-pilot's `_build_*_argv`
 * functions. Unknown options are omitted, never guessed.
 */
export function buildVncClientArgs(
  client: VncClientInfo,
  connection: Connection,
  options: VncArgvOptions = {},
): string[] {
  const data = payload(connection);
  const argv: string[] = [];
  const target = vncTarget(connection);

  const id = client.clientId;
  if (id === "remmina") {
    if (options.profileFile) return ["--connect", options.profileFile];
    return ["-c", vncUri(connection)];
  }
  if (id === "krdc") {
    argv.push(vncUri(connection));
    if (bool(data, "fullscreen") === true) argv.push("-f");
    argv.push(...splitExtraArgs(data.extraArgs));
    return argv;
  }
  if (id === "vinagre") {
    argv.push(vncUri(connection));
    if (bool(data, "fullscreen") === true) argv.push("--fullscreen");
    argv.push(...splitExtraArgs(data.extraArgs));
    return argv;
  }
  if (id === "gvncviewer") {
    argv.push(target);
    argv.push(...splitExtraArgs(data.extraArgs));
    return argv;
  }

  argv.push(target);
  const isTurbo = id === "turbovnc";
  const isTiger = id === "tigervnc" || isTurbo;

  if (isTiger) {
    if (bool(data, "viewOnly") === true) argv.push("-ViewOnly");
    if (bool(data, "fullscreen") === true) argv.push("-FullScreen");
    argv.push(bool(data, "shared") === false ? "-Shared=0" : "-Shared");

    const encoding = str(data, "encoding");
    if (encoding) argv.push(isTurbo ? "-Encoding" : "-PreferredEncoding", encoding);

    const quality = str(data, "quality");
    if (quality) {
      if (isTurbo) {
        // TurboVNC's JPEG quality is 1-100; map the 0-9 choice onto it.
        const level = Math.max(1, Math.min(100, Number(quality) * 10 + 5));
        argv.push("-Quality", String(level));
      } else {
        argv.push("-QualityLevel", quality);
      }
    }

    const compress = str(data, "compress");
    if (compress) argv.push("-CompressLevel", compress);

    const colorDepth = str(data, "colorDepth");
    if (colorDepth) {
      if (isTurbo) {
        const colors: Record<string, string> = {
          "8": "256",
          "16": "65536",
          "24": "16777216",
          "32": "16777216",
        };
        if (colors[colorDepth]) argv.push("-Colors", colors[colorDepth]);
      } else if (colorDepth === "8") {
        // TigerVNC has no -colorDepth; 8-bit is its highest reduced level.
        argv.push("-LowColorLevel", "2");
      } else if (colorDepth === "24" || colorDepth === "32") {
        argv.push("-FullColor");
      }
      // 16-bit has no TigerVNC equivalent; AutoSelect decides.
    }

    const geometry = str(data, isTurbo ? "turbovncGeometry" : "tigervncGeometry");
    if (geometry) argv.push(isTurbo ? "-DesktopSize" : "-geometry", geometry);
    const via = str(data, isTurbo ? "turbovncVia" : "tigervncVia");
    if (via) argv.push("-via", via);

    // Clipboard defaults to on, exactly as vnc-pilot's FieldSpec defaults.
    if (bool(data, "acceptClipboard") === false) {
      argv.push(isTurbo ? "-RecvClipboard=0" : "-AcceptClipboard=0");
    }
    if (bool(data, "sendClipboard") === false) argv.push("-SendClipboard=0");

    if (isTurbo) {
      if (bool(data, "turbovncJpeg") === true) argv.push("-JPEG=1");
      argv.push(bool(data, "turbovncLocal") === false ? "-LocalCursor=0" : "-LocalCursor=1");
    }

    argv.push(...splitExtraArgs(data.extraArgs));
    if (options.passwordFile) argv.push("-passwd", options.passwordFile);
    return argv;
  }

  if (id === "tightvnc") {
    if (bool(data, "viewOnly") === true) argv.push("-viewonly");
    if (bool(data, "fullscreen") === true) argv.push("-fullscreen");
    argv.push(bool(data, "shared") === false ? "-noshared" : "-shared");
    const encoding = str(data, "encoding");
    if (encoding) argv.push("-encodings", encoding);
    const quality = str(data, "quality");
    if (quality) argv.push("-quality", quality);
    const compress = str(data, "compress");
    if (compress) argv.push("-compresslevel", compress);
    const colorDepth = str(data, "colorDepth");
    if (colorDepth) argv.push(colorDepth === "8" ? "-bgr233" : "-truecolour");
    argv.push(...splitExtraArgs(data.extraArgs));
    if (options.passwordFile) argv.push("-passwd", options.passwordFile);
    return argv;
  }

  if (id === "realvnc") {
    if (bool(data, "viewOnly") === true) argv.push("-ViewOnly");
    if (bool(data, "fullscreen") === true) argv.push("-FullScreen");
    if (bool(data, "shared") !== false) argv.push("-Shared");
    const encoding = str(data, "encoding");
    // RealVNC documents only ZRLE / Hextile / Raw.
    if (encoding && encoding !== "Tight") argv.push("-PreferredEncoding", encoding);
    const via = str(data, "tigervncVia") ?? str(data, "turbovncVia");
    if (via) argv.push("-via", via);
    argv.push(...splitExtraArgs(data.extraArgs));
    if (options.passwordFile) argv.push("-passwd", options.passwordFile);
    return argv;
  }

  // custom: host::port + raw extra args + a TigerVNC-style passwd option.
  argv.push(...splitExtraArgs(data.extraArgs));
  if (options.passwordFile) argv.push("-passwd", options.passwordFile);
  return argv;
}

/**
 * Backward-compatible TigerVNC argv helper used by older callers/tests:
 * `host::port` target plus an optional passwd file.
 */
export function buildVncArgs(connection: Connection, options: { passwdFile?: string } = {}): string[] {
  return buildVncClientArgs(
    { clientId: "tigervnc", binary: "vncviewer", displayName: "TigerVNC" },
    connection,
    { passwordFile: options.passwdFile },
  );
}

// ---------------------------------------------------------------------------
// Launch preparation
// ---------------------------------------------------------------------------

const PASSWORD_FILE_CLIENTS = new Set<VncClientId>(["tigervnc", "turbovnc", "tightvnc", "realvnc", "custom"]);

export interface VncLaunchOptions extends VncDiscoveryOptions {
  /** Base directory for per-launch material (passwd file, Remmina profile). */
  runDirBase?: string;
  log?: (message: string) => void;
}

export interface PreparedVncLaunch {
  client: VncClientInfo;
  binary: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Directory removed when the window exits; null when nothing was written. */
  runDir: string | null;
}

/**
 * Resolves the viewer, prepares its password material and returns everything
 * `spawnWindow` needs. The caller owns the run directory and must remove it
 * when the process exits (done by the launcher's exit handler).
 */
export async function prepareVncLaunch(
  connection: Connection,
  password: string | null,
  options: VncLaunchOptions = {},
): Promise<PreparedVncLaunch> {
  const log = options.log ?? (() => {});
  const client = await resolveVncClient(connection, options);
  const env: NodeJS.ProcessEnv = { ...process.env };
  let runDir: string | null = null;
  let passwordFile: string | null = null;
  let profileFile: string | null = null;

  const ensureRunDir = (): string => {
    if (runDir === null) {
      runDir = path.join(options.runDirBase ?? defaultRunDirBase(), `ext_${randomUUID()}`);
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    }
    return runDir;
  };

  if (password !== null && password.length > 0) {
    if (client.clientId === "remmina") {
      profileFile = writeRemminaProfile(connection, password, ensureRunDir());
    } else if (PASSWORD_FILE_CLIENTS.has(client.clientId)) {
      const vncpasswd = findExecutable(["vncpasswd"], options.pathEnv);
      if (vncpasswd !== null) {
        try {
          passwordFile = await writeVncPasswdFile(vncpasswd, password, ensureRunDir());
        } catch (cause) {
          log(
            `[remote-control] vncpasswd -f failed, falling back to the viewer prompt: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
      if (passwordFile === null && (client.clientId === "tigervnc" || client.clientId === "turbovnc")) {
        // Current TigerVNC builds read these variables; the viewer's own
        // dialog is the last fallback when even that is unsupported.
        env.VNC_PASSWORD = truncateVncPassword(password);
        if (connection.username.length > 0) env.VNC_USERNAME = connection.username;
        log(
          "[remote-control] vncpasswd was not found; passing the password through VNC_PASSWORD instead (install TigerVNC tools for the passwd file).",
        );
      } else if (passwordFile === null) {
        log(
          `[remote-control] ${client.displayName} cannot take the stored password without vncpasswd; the viewer will prompt for it.`,
        );
      }
    }
  }

  const argv = buildVncClientArgs(client, connection, { passwordFile, profileFile });
  return { client, binary: client.binary, argv, env, runDir };
}
