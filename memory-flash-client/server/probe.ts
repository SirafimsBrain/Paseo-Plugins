import type { ConnectionCheck } from "../shared/contracts";
import { normalizeUrl } from "./connections";
import type { RequestIdentity } from "./identity";

/**
 * Connection probe for a remote memory host.
 *
 * A memory host is considered reachable only when all three steps pass —
 * the same sequence a real agent performs:
 *   1. `GET /healthz` — the memory-flash liveness endpoint (no auth).
 *   2. `POST /mcp` `initialize` — the MCP handshake, authenticated with
 *      `Authorization: Bearer <key>`.
 *   3. `POST /mcp` `tools/list` — proves the key is not just valid but
 *      granted access to the memory tools.
 *
 * Step 3 doubles as a scope check: a read-only key sees only the
 * read-only tools, which is reported through `toolCount`.
 *
 * The probe never logs the secret, and 401/403 answers are translated
 * into an actionable message ("the API key was rejected") without
 * revealing anything about the memory host's store.
 */

/** Whole-probe budget; a hung host must not block the UI. */
const PROBE_TIMEOUT_MS = 8000;
/** JSON-RPC ids used by the two MCP calls. */
const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;

const PROTOCOL_VERSION = "2024-11-05";

function headers(secret: string, identity: RequestIdentity | null): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
  };
  if (identity) {
    result["X-Memory-Flash-Client-Id"] = identity.clientId;
    result["X-Memory-Flash-Host"] = identity.host;
  }
  return result;
}

/** Combines a caller-supplied timeout with the whole-probe budget. */
function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // `unref` keeps the timer from holding the process open in the daemon.
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Health URL derived from the MCP URL: same origin, `/healthz`. */
export function healthUrlFor(mcpUrl: string): string {
  try {
    const url = new URL(normalizeUrl(mcpUrl));
    url.pathname = "/healthz";
    url.search = "";
    return url.toString();
  } catch {
    return mcpUrl.replace(/\/mcp\/?$/, "/healthz");
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Probes one connection. `identity` is optional so a draft check works
 * before settings are saved. Returns a structured result; it never
 * throws.
 */
export async function probeConnection(
  url: string,
  secret: string,
  identity: RequestIdentity | null,
): Promise<ConnectionCheck> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const mcpUrl = normalizeUrl(url);
  const fail = (error: string, latencyMs: number | null = Date.now() - startedAt): ConnectionCheck => ({
    ok: false,
    status: "error",
    latencyMs,
    error,
    serverName: null,
    toolCount: null,
    checkedAt,
  });

  // --- 1. liveness ----------------------------------------------------------
  const health = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(healthUrlFor(mcpUrl), {
      method: "GET",
      signal: health.signal,
    });
    if (!response.ok) {
      return fail(
        `The memory host answered /healthz with HTTP ${response.status}. Is the memory-flash HTTP endpoint enabled?`,
      );
    }
  } catch (cause) {
    return fail(describeNetworkError(cause, healthUrlFor(mcpUrl)));
  } finally {
    health.done();
  }

  // --- 2. MCP initialize ----------------------------------------------------
  const init = withTimeout(PROBE_TIMEOUT_MS);
  let serverName: string | null = null;
  try {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: headers(secret, identity),
      signal: init.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "memory-flash-client", version: "0.1.0" },
        },
      }),
    });
    if (response.status === 401 || response.status === 403) {
      return fail(
        "The memory host rejected the API key. Generate a new key in memory-flash → Remote access and update this connection.",
      );
    }
    if (!response.ok) {
      return fail(`MCP initialize failed with HTTP ${response.status}.`);
    }
    const body = await readJson(response);
    if (body?.error) {
      return fail(`MCP initialize returned an error: ${describeRpcError(body.error)}.`);
    }
    const result = body?.result as { serverInfo?: { name?: unknown } } | undefined;
    const name = result?.serverInfo?.name;
    serverName = typeof name === "string" ? name : null;
    if (serverName === null) {
      return fail("MCP initialize answered without serverInfo — is this really a memory-flash endpoint?");
    }
  } catch (cause) {
    return fail(describeNetworkError(cause, mcpUrl));
  } finally {
    init.done();
  }

  // --- 3. tools/list --------------------------------------------------------
  const tools = withTimeout(PROBE_TIMEOUT_MS);
  let toolCount: number | null = null;
  try {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: headers(secret, identity),
      signal: tools.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: TOOLS_LIST_ID, method: "tools/list", params: {} }),
    });
    if (response.status === 401 || response.status === 403) {
      return fail("The memory host rejected the API key on tools/list.");
    }
    if (!response.ok) {
      return fail(`tools/list failed with HTTP ${response.status}.`);
    }
    const body = await readJson(response);
    if (body?.error) {
      return fail(`tools/list returned an error: ${describeRpcError(body.error)}.`);
    }
    const result = body?.result as { tools?: unknown } | undefined;
    if (!Array.isArray(result?.tools)) {
      return fail("tools/list answered without a tools array.");
    }
    toolCount = result.tools.length;
  } catch (cause) {
    return fail(describeNetworkError(cause, mcpUrl));
  } finally {
    tools.done();
  }

  return {
    ok: true,
    status: "ok",
    latencyMs: Date.now() - startedAt,
    error: null,
    serverName,
    toolCount,
    checkedAt,
  };
}

/** Short, actionable network error text (timeout, refused, DNS, TLS). */
function describeNetworkError(cause: unknown, target: string): string {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return `No answer from ${target} within ${PROBE_TIMEOUT_MS / 1000}s.`;
  }
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "ECONNREFUSED") return `Connection refused by ${target}.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Host in ${target} could not be resolved.`;
  const message = cause instanceof Error ? cause.message : String(cause);
  return `Cannot reach ${target}: ${message}`;
}

function describeRpcError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
