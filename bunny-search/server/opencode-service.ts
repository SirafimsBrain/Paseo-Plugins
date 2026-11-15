/**
 * Detection of a *shared* OpenCode v2 service, matching Paseo 0.15.0's service
 * selection (`@getpaseo/server` → `agent/providers/opencode/v2/service-selection.js`).
 *
 * Why this exists: `requiresDedicatedV2Server()` is true for any agent whose
 * config carries `mcpServers`, and the host refuses to open such an agent on a
 * *shared* OpenCode service with
 * `Custom OpenCode MCP servers or process environment require an isolated server
 * and cannot be used with a shared OpenCode service.` An injected MCP server is
 * exactly that case, so on such a host the injection is not an improvement — it
 * makes agent creation and every reopen fail (#7435). The plugin therefore
 * reproduces the host's rule from local state only, so a hook can decide to
 * degrade instead of breaking the open.
 *
 * The rule, read out of the installed 0.15.0 host:
 * 1. `V2Runtime` reads the OpenCode connection from
 *    `{...process.env, ...agents.providers.opencode.env}` — the provider env in
 *    `$PASEO_HOME/config.json` is overlaid on the daemon's own environment, so a
 *    setting wins over the shell.
 * 2. `PASEO_OPENCODE_SERVER_URL` set → selection `explicit` → shared.
 * 3. Otherwise `service-selection.js` resolves the state directory as
 *    `providerEnv.XDG_STATE_HOME ?? process.env.XDG_STATE_HOME ??
 *    ~/.local/state` and reads `<state>/opencode/service.json`; when its
 *    `version` is a compatible `2.x` (at least `2.0.10`) and its `url` points at
 *    this host, selection is `discovered` → shared. The host additionally probes
 *    that URL; this module substitutes a pid liveness check, which is local and
 *    cheap and covers the common stale-file case (a `service.json` left behind
 *    by a crashed service).
 * 4. Everything else → the host owns its own server, and MCP injection is fine.
 *
 * Diagnostics only: detection never throws and never writes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SharedOpenCodeService {
  /** True when Paseo would connect to a shared service instead of owning one. */
  shared: boolean;
  /** Evidence kept for the log line. */
  detail: string;
  /** Discovery file that was inspected, when one was. */
  path: string | null;
}

export type EnvRecord = Record<string, string | undefined>;

export interface DetectionOptions {
  /** Environment to start from (defaults to `process.env`). */
  env?: EnvRecord;
  /**
   * `agents.providers.opencode.env` from `$PASEO_HOME/config.json`. The host
   * overlays it on its own environment, so it is applied the same way here.
   */
  providerEnv?: EnvRecord | null;
  /** Overrides the discovery path; `null` means "pretend there is no file". */
  file?: string | null;
  /** Liveness probe for the recorded pid (tests). */
  isProcessAlive?: (pid: number) => boolean;
}

/** `$PASEO_HOME`, as the daemon resolves it (`~` expanded). */
export function paseoHome(env: EnvRecord = process.env): string {
  const raw = env.PASEO_HOME?.trim() || "~/.paseo";
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

/**
 * `agents.providers.<id>.env` from `$PASEO_HOME/config.json` — the same map the
 * daemon overlays on its environment before choosing an OpenCode service.
 * Missing, unreadable or malformed state resolves to an empty map: a broken
 * config must never look like a shared service.
 */
export function readProviderConfigEnv(
  providerId: string,
  options: {
    paseoHome?: string;
    env?: EnvRecord;
    readFile?: (file: string) => string;
  } = {},
): EnvRecord {
  const home = options.paseoHome ?? paseoHome(options.env ?? process.env);
  const file = path.join(home, "config.json");
  const read = options.readFile ?? ((target: string) => fs.readFileSync(target, "utf8"));

  let raw: string;
  try {
    raw = read(file);
  } catch {
    return {};
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return {};
  }

  const providers = (config as { agents?: { providers?: unknown } })?.agents?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  const entry = (providers as Record<string, unknown>)[providerId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  const env = (entry as { env?: unknown }).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};

  const out: EnvRecord = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * `<state>/opencode/service.json`, where the state directory follows the host:
 * provider setting first, then the daemon environment, then `~/.local/state`.
 * `??` rather than a blank-string fallback, because the host treats a set-but-
 * empty value as set.
 */
export function openCodeServiceFile(mergedEnv: EnvRecord = process.env): string {
  const state = mergedEnv.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(state, "opencode", "service.json");
}

/** Paseo's `compatibleVersion`: major 2, and at least 2.0.10. */
export function isCompatibleOpenCodeServiceVersion(version: string): boolean {
  const match = /^2\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 10));
}

function isLocalOpenCodeHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const local = Object.values(os.networkInterfaces()).flatMap((items) =>
      (items ?? []).map((item) => item.address),
    );
    return ["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", ...local].includes(hostname);
  } catch {
    return false;
  }
}

/** `kill(pid, 0)`: alive unless the kernel says the pid is gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function detectSharedOpenCodeService(
  options: DetectionOptions = {},
): SharedOpenCodeService {
  // The host merges the provider's own env over the daemon env (`explicit` and
  // the `XDG_STATE_HOME` lookup both read that merged map).
  const merged: EnvRecord = { ...(options.env ?? process.env), ...(options.providerEnv ?? {}) };

  const explicit = merged.PASEO_OPENCODE_SERVER_URL?.trim();
  if (explicit) {
    return {
      shared: true,
      detail: `PASEO_OPENCODE_SERVER_URL points at ${explicit}`,
      path: null,
    };
  }

  const file = options.file === undefined ? openCodeServiceFile(merged) : options.file;
  if (file === null) {
    return { shared: false, detail: "no OpenCode service file configured", path: null };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { shared: false, detail: `no OpenCode service file at ${file}`, path: file };
  }

  let info: { version?: unknown; url?: unknown; pid?: unknown };
  try {
    info = JSON.parse(raw) as typeof info;
  } catch {
    return { shared: false, detail: `unreadable OpenCode service file at ${file}`, path: file };
  }

  const url = typeof info.url === "string" ? info.url.trim() : "";
  if (!url) {
    return { shared: false, detail: `OpenCode service file at ${file} has no url`, path: file };
  }
  const version = typeof info.version === "string" ? info.version.trim() : "";
  if (!isCompatibleOpenCodeServiceVersion(version)) {
    return {
      shared: false,
      detail: `OpenCode service ${version || "(no version)"} at ${url} is not a compatible 2.x`,
      path: file,
    };
  }
  if (!isLocalOpenCodeHost(url)) {
    return { shared: false, detail: `OpenCode service ${url} is not on this host`, path: file };
  }
  const pid = typeof info.pid === "number" && Number.isInteger(info.pid) ? info.pid : null;
  const alive = options.isProcessAlive ?? processAlive;
  if (pid !== null && !alive(pid)) {
    return { shared: false, detail: `OpenCode service pid ${pid} is gone (stale file)`, path: file };
  }

  return {
    shared: true,
    detail: `OpenCode ${version} service at ${url} (pid ${pid ?? "unknown"})`,
    path: file,
  };
}

/**
 * Why MCP contributions must be withheld for this provider, or `null` when they
 * are safe. Paseo only enforces the isolation rule on the `opencode` provider —
 * every other provider reads MCP servers from the agent session as usual.
 */
export function sharedOpenCodeMcpBlock(
  provider: string,
  service: SharedOpenCodeService,
): string | null {
  if (provider !== "opencode" || !service.shared) return null;
  return (
    `shared OpenCode service ${service.detail} (Paseo 0.15.0 #7435) — ` +
    "an injected MCP server would fail the open"
  );
}

/**
 * Hook-facing convenience: reads the provider env from Paseo's config the way
 * the host does, then answers whether this provider must not receive MCP.
 * Non-opencode providers return `null` without touching the filesystem.
 */
export function sharedOpenCodeMcpBlockFor(
  provider: string,
  options: {
    env?: EnvRecord;
    paseoHome?: string;
    file?: string | null;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): string | null {
  if (provider !== "opencode") return null;
  const providerEnv = readProviderConfigEnv("opencode", {
    paseoHome: options.paseoHome,
    env: options.env,
  });
  return sharedOpenCodeMcpBlock(
    provider,
    detectSharedOpenCodeService({
      env: options.env,
      providerEnv,
      file: options.file,
      isProcessAlive: options.isProcessAlive,
    }),
  );
}
