import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OpenCode shared-service detection (0.40.8, `__doc.md` §10.11 item 1).
 *
 * Paseo 0.15.0 (#7435) lets the `opencode` provider reuse a **running** v2
 * service instead of owning one process per agent. That reuse is incompatible
 * with a session-level MCP contribution: `requiresDedicatedV2Server()` is true
 * for any agent whose config carries `mcpServers`, and the host then refuses
 * the agent outright — `Custom OpenCode MCP servers or process environment
 * require an isolated server and cannot be used with a shared OpenCode
 * service.` Both hooks of this plugin add MCP servers, so on such a host an
 * `opencode` agent can be neither created nor opened.
 *
 * The host's discovery rule, as recorded in `__doc.md` §10.10.4: it reads
 * `$XDG_STATE_HOME/opencode/service.json` (default
 * `~/.local/state/opencode/service.json`), and for a *local* host on a
 * compatible `2.x` service it returns `kind: "discovered"` — shared.
 * `PASEO_OPENCODE_SERVER_URL`, when set, points at an external service the
 * same way.
 *
 * This module mirrors that rule so the decision can be made **before** the
 * contribution: when a shared service is found the hooks contribute nothing
 * over MCP and the native `luck_tree_upsert_leaf` tool is attached instead
 * (`server/session-open.ts`), so the agent keeps the tree instead of failing
 * to open.
 *
 * Deliberate asymmetries, both chosen to fail safe:
 *
 * - Only the `opencode` provider is inspected; no other provider goes through
 *   `V2Runtime`.
 * - A discovery document we cannot read is **not** treated as a shared
 *   service: the guard degrades behaviour (no MCP, native tool only), so an
 *   unreadable file must not silently downgrade every agent. The host error
 *   stays visible in that case instead of being masked.
 * - A `2.x` document is enough on its own; the URL is only used to *exclude*
 *   a clearly remote service (`isLoopbackUrl`). A document whose URL field we
 *   do not recognise still counts as shared, because fail-closed keeps the
 *   agent usable.
 */

/** What the hooks need to know, plus one line for `paseo plugin logs`. */
export interface OpenCodeServiceProbe {
  /** The host will route this open through a service it does not own. */
  shared: boolean;
  /** Human-readable reason, safe to log (no credentials are involved). */
  why: string;
  /** Discovery file the answer came from, when there was one. */
  path: string | null;
  /** `version` of the discovery document, when it was readable. */
  version: string | null;
}

/** The provider whose runtime can reuse a service. */
export const OPEN_CODE_PROVIDER = "opencode";

/** Environment variable the host honours as an explicit service endpoint. */
export const OPEN_CODE_SERVICE_URL_ENV = "PASEO_OPENCODE_SERVER_URL";

/**
 * Where the host looks for the discovery document:
 * `$XDG_STATE_HOME/opencode/service.json`, else
 * `~/.local/state/opencode/service.json`. Exported so the tests and the docs
 * name one path.
 */
export function opencodeServiceDiscoveryPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const stateHome = (env.XDG_STATE_HOME ?? "").trim();
  const base = stateHome.length > 0 ? stateHome : join(home, ".local", "state");
  return join(base, "opencode", "service.json");
}

/** Result of reading one discovery document. */
export interface DiscoveryDocumentVerdict {
  version: string | null;
  shared: boolean;
  why: string;
}

/** `2`, `2.2.5` — the compatible major version the host accepts. */
function isCompatibleVersion(version: string): boolean {
  return /^2(\.|$)/.test(version);
}

function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "::"
  );
}

/** The URL field of a discovery document, tolerating the common spellings. */
function serviceUrl(document: Record<string, unknown>): string | null {
  for (const key of ["url", "baseUrl", "serverUrl", "endpoint", "origin"]) {
    const value = document[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const nested = document.service;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return serviceUrl(nested as Record<string, unknown>);
  }
  return null;
}

/**
 * The host's rule applied to one JSON document, pure and unit-testable:
 * a `2.x` version marks a shared service unless the document names a service
 * that is clearly not local.
 */
export function parseOpenCodeServiceDocument(text: string): DiscoveryDocumentVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { version: null, shared: false, why: "discovery document is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { version: null, shared: false, why: "discovery document is not an object" };
  }
  const document = parsed as Record<string, unknown>;
  const rawVersion = document.version ?? document.serviceVersion;
  const version =
    typeof rawVersion === "string"
      ? rawVersion.trim()
      : typeof rawVersion === "number"
        ? String(rawVersion)
        : null;
  if (version === null || version.length === 0) {
    return { version: null, shared: false, why: "discovery document carries no version" };
  }
  if (!isCompatibleVersion(version)) {
    return {
      version,
      shared: false,
      why: `discovered OpenCode service is version ${version}, not 2.x`,
    };
  }
  const url = serviceUrl(document);
  if (url !== null && !isLoopbackUrl(url)) {
    return {
      version,
      shared: false,
      why: `discovered OpenCode service is not local (${url})`,
    };
  }
  return {
    version,
    shared: true,
    why: `OpenCode ${version} service discovered${url === null ? "" : ` at ${url}`}`,
  };
}

export interface OpenCodeServiceProbeOptions {
  /** Provider of the agent being created or opened (`request.config.provider`). */
  provider: string;
  /** Environment of the daemon process the plugin inherited. */
  env?: NodeJS.ProcessEnv;
  /** Home directory used when `XDG_STATE_HOME` is unset. */
  home?: string;
  /** File reader; `null` means "missing". Overridden by the tests. */
  readFile?: (path: string) => string | null;
}

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Whether an `opencode` agent carrying custom MCP servers would be rejected
 * on this host. Every other provider answers `shared: false` immediately —
 * the probe costs one `existsSync` at most.
 */
export function probeOpenCodeService(
  options: OpenCodeServiceProbeOptions,
): OpenCodeServiceProbe {
  const env = options.env ?? process.env;
  if (options.provider !== OPEN_CODE_PROVIDER) {
    return {
      shared: false,
      why: `provider '${options.provider}' does not reuse an OpenCode service`,
      path: null,
      version: null,
    };
  }

  const explicit = (env[OPEN_CODE_SERVICE_URL_ENV] ?? "").trim();
  if (explicit.length > 0) {
    return {
      shared: true,
      why: `${OPEN_CODE_SERVICE_URL_ENV} is set (${explicit})`,
      path: null,
      version: null,
    };
  }

  const path = opencodeServiceDiscoveryPath(env, options.home ?? homedir());
  const read = options.readFile ?? readFileOrNull;
  const text = read(path);
  if (text === null) {
    return {
      shared: false,
      why: `no OpenCode service discovery at ${path}`,
      path,
      version: null,
    };
  }
  const verdict = parseOpenCodeServiceDocument(text);
  return { shared: verdict.shared, why: verdict.why, path, version: verdict.version };
}
