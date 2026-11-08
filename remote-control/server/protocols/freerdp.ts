// FreeRDP 3 launcher support (stage 0.27.11, stage E1).
//
// Ported from rdp-pilot's `FreeRdpBackend`: binary discovery (PATH, the
// `REMOTE_CONTROL_RDP_BIN` override and the explicit client from the plugin
// settings), a FreeRDP 3 gate, and the argv constructor for the option groups
// of the Python original. FreeRDP 2 is deliberately unsupported: its
// `/x:`-style option conversions are absent from this file, and a v2 binary is
// rejected with an explicit error instead of being half-translated (ADR-8).
//
// Discovery order and the Wayland preference are rdp-pilot's rule; the
// version fingerprint follows the VNC discovery in `protocols/vnc.ts` and is
// cached for 30 s because every launch would otherwise spawn `--version`.

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { Connection } from "../../shared/connections";
import { findExecutable, isExecutable } from "./discovery";

/** Override rdp-pilot used for an explicit client (wins over PATH). */
export const RDP_BINARY_ENV = "REMOTE_CONTROL_RDP_BIN";

/**
 * Candidate client names. FreeRDP 3 ships one binary per display server;
 * `xfreerdp` is the legacy name kept as the last candidate because several
 * distributions symlink it to `xfreerdp3` — the version gate below decides
 * whether it really is FreeRDP 3.
 */
export const RDP_BINARIES = ["wlfreerdp3", "xfreerdp3", "xfreerdp"] as const;

/** Discovery cache lifetime (matches the VNC viewers' 30 s cache). */
const VERSION_TTL_MS = 30_000;

interface CachedVersion {
  at: number;
  version: string | null;
}

const versionCache = new Map<string, CachedVersion>();

/** Drops the version cache (tests and a fresh client installation). */
export function clearRdpDiscoveryCache(): void {
  versionCache.clear();
}

/**
 * Reads `--version` from a client. A client that cannot be probed (custom
 * wrapper, unusual build) yields null; the name suffix then decides whether it
 * counts as FreeRDP 3, and a reported v2 is always rejected.
 */
export function probeRdpVersion(binary: string): string | null {
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const text = output.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** FreeRDP major version from a `--version` line, or null when unknown. */
export function freerdpMajor(version: string | null): number | null {
  if (!version) return null;
  const match = /FreeRDP\s+version\s+(\d+)/i.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : null;
}

/** Candidates in the order rdp-pilot used for the display server in play. */
export function rdpBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const wayland = (env.WAYLAND_DISPLAY ?? "").trim().length > 0;
  return wayland ? ["wlfreerdp3", "xfreerdp3", "xfreerdp"] : ["xfreerdp3", "wlfreerdp3", "xfreerdp"];
}

export interface RdpDiscoveryOptions {
  /** PATH used for the scan (tests). */
  pathEnv?: string;
  /** Environment for the Wayland ordering and the override variable. */
  env?: NodeJS.ProcessEnv;
  /** Explicit client from the plugin settings; wins over the environment. */
  binary?: string | null;
  /** Version probe, injectable for tests. */
  probe?: (binary: string) => string | null;
  now?: () => number;
  ttlMs?: number;
  useCache?: boolean;
}

export interface RdpClientInfo {
  binary: string;
  /** Raw `--version` output; null when the client could not be probed. */
  version: string | null;
  source: "settings" | "env" | "path";
}

function notFreeRdp3(binary: string, version: string | null): Error {
  const major = freerdpMajor(version);
  const found = major === null ? "an unknown FreeRDP" : `FreeRDP ${major}`;
  return new Error(
    `${path.basename(binary)} is ${found} (${version ?? "no --version output"}), but remote-control needs FreeRDP 3: ` +
      `install xfreerdp3/wlfreerdp3, or point ${RDP_BINARY_ENV} / the RDP client override in Settings at a FreeRDP 3 client.`,
  );
}

/**
 * Resolves the RDP client for a launch. Settings > `REMOTE_CONTROL_RDP_BIN` >
 * PATH candidates, and every candidate must report FreeRDP 3 (or carry the
 * `3` name suffix when it cannot be probed). Throws with the tried names when
 * nothing suitable exists, so the panel shows an actionable error instead of a
 * window that interprets options differently.
 */
export function discoverRdpClient(options: RdpDiscoveryOptions = {}): RdpClientInfo {
  const env = options.env ?? process.env;
  const pathEnv = options.pathEnv ?? env.PATH ?? "";
  const probe = options.probe ?? probeRdpVersion;
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? VERSION_TTL_MS;
  const useCache = options.useCache ?? true;

  const versionOf = (binary: string): string | null => {
    if (useCache) {
      const hit = versionCache.get(binary);
      if (hit && now() - hit.at < ttl) return hit.version;
    }
    const version = probe(binary);
    if (useCache) versionCache.set(binary, { at: now(), version });
    return version;
  };

  const configured = options.binary?.trim() ?? "";
  if (configured.length > 0) {
    if (!isExecutable(configured)) {
      throw new Error(`the configured RDP client is not executable: ${configured} (check the plugin settings)`);
    }
    const version = versionOf(configured);
    const major = freerdpMajor(version);
    if (major !== null && major !== 3) throw notFreeRdp3(configured, version);
    return { binary: configured, version, source: "settings" };
  }

  const override = (env[RDP_BINARY_ENV] ?? "").trim();
  if (override.length > 0) {
    if (!isExecutable(override)) {
      throw new Error(`$${RDP_BINARY_ENV} points at ${override}, which is not executable`);
    }
    const version = versionOf(override);
    const major = freerdpMajor(version);
    if (major !== null && major !== 3) throw notFreeRdp3(override, version);
    return { binary: override, version, source: "env" };
  }

  let rejected: { binary: string; version: string | null } | null = null;
  for (const name of rdpBinaryCandidates(env)) {
    const found = findExecutable([name], pathEnv);
    if (!found) continue;
    const version = versionOf(found);
    const major = freerdpMajor(version);
    if (major !== null && major !== 3) {
      // A FreeRDP 2 client is not a fallback: it is skipped, and reported
      // only when no genuine FreeRDP 3 client exists.
      rejected ??= { binary: found, version };
      continue;
    }
    return { binary: found, version, source: "path" };
  }

  if (rejected) throw notFreeRdp3(rejected.binary, rejected.version);
  throw new Error(
    `RDP client not found (tried ${rdpBinaryCandidates(env).join(", ")}): install FreeRDP 3 or set ${RDP_BINARY_ENV}.`,
  );
}

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
 * `/gateway:...` value (stage 0.29.11, E3), or null when no gateway is set.
 * FreeRDP parses the value as CSV sub-options, so each value is quoted the
 * same way `/kbd:` values are. `p:` is deliberately absent: the gateway
 * password arrives on stdin, never in argv.
 */
export function rdpGatewayOption(connection: Connection): string | null {
  const payload = connection.payload ?? {};
  const host = typeof payload.gatewayHost === "string" ? payload.gatewayHost.trim() : "";
  if (host.length === 0) return null;

  const port = typeof payload.gatewayPort === "number" ? payload.gatewayPort : null;
  const target = port === null ? formatRdpHost(host) : `${formatRdpHost(host)}:${port}`;
  const parts = [`g:${rdpCsvValue(target)}`];

  const user = typeof payload.gatewayUser === "string" ? payload.gatewayUser.trim() : "";
  if (user.length > 0) parts.push(`u:${rdpCsvValue(user)}`);
  const domain = typeof payload.gatewayDomain === "string" ? payload.gatewayDomain.trim() : "";
  if (domain.length > 0) parts.push(`d:${rdpCsvValue(domain)}`);
  const usage = typeof payload.gatewayUsageMethod === "string" ? payload.gatewayUsageMethod : "";
  if (usage === "direct" || usage === "detect") parts.push(`usage-method:${usage}`);

  return `/gateway:${parts.join(",")}`;
}

/**
 * True when the gateway logs in with its own user/domain instead of reusing
 * the connection credentials. FreeRDP only asks stdin for a gateway password
 * in that case (`GatewayUseSameCredentials` is cleared by `u:`/`d:`), which is
 * why the launcher sends two lines exactly then.
 */
export function gatewayNeedsSeparateCredentials(connection: Connection): boolean {
  const payload = connection.payload ?? {};
  const host = typeof payload.gatewayHost === "string" ? payload.gatewayHost.trim() : "";
  if (host.length === 0) return false;
  const user = typeof payload.gatewayUser === "string" ? payload.gatewayUser.trim() : "";
  const domain = typeof payload.gatewayDomain === "string" ? payload.gatewayDomain.trim() : "";
  return user.length > 0 || domain.length > 0;
}

/**
 * Bytes for FreeRDP's stdin under `/from-stdin:force`. FreeRDP 3.15 reads the
 * target password first and, when the gateway has separate credentials, the
 * gateway password second (`client/common/cmdline.c`), so this order is part
 * of the contract. Returns null when there is no password to pipe, which also
 * means `/from-stdin:force` must not be emitted.
 */
export function rdpStdinPayload(input: {
  password: string | null;
  gatewayPassword: string | null;
  gatewaySeparate: boolean;
}): string | null {
  // Without a target password there is nothing FreeRDP would read first, so
  // a gateway password alone cannot be piped (the launcher refuses instead).
  if (input.password === null) return null;
  const lines = [input.password];
  if (input.gatewaySeparate) lines.push(input.gatewayPassword ?? "");
  return `${lines.join("\n")}\n`;
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
 * as they did before.
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

  // RD Gateway — after the security group, in rdp-pilot's order.
  const gateway = rdpGatewayOption(connection);
  if (gateway !== null) args.push(gateway);

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
