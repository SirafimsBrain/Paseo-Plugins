import { randomUUID } from "node:crypto";
import * as os from "node:os";

/**
 * Client identity for memory-flash-client.
 *
 * Every request to a memory host carries two advisory headers:
 * - `X-Memory-Flash-Client-Id` — a stable UUID generated once per client
 *   installation (stored in plugin settings, never regenerated silently);
 * - `X-Memory-Flash-Host` — a human-readable host name (settings override
 *   or `os.hostname()`).
 *
 * The memory host records them in its audit log so several clients — the
 * same plugin installed on different machines — can be told apart. They
 * grant no authority: authentication is the API key alone.
 */

/** Generates a fresh client UUID (v4). */
export function generateClientId(): string {
  return randomUUID();
}

/** Whether a stored value looks like a usable client id. */
export function isValidClientId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The host label to announce: the settings override when set, otherwise
 * the machine's OS hostname. Falls back to "unknown-host" in the unlikely
 * case `os.hostname()` is empty.
 */
export function resolveIdentityHost(hostnameOverride: string): string {
  const override = hostnameOverride.trim();
  if (override.length > 0) return override;
  const fromOs = os.hostname().trim();
  return fromOs.length > 0 ? fromOs : "unknown-host";
}

/** The identity pair to send on each request. */
export interface RequestIdentity {
  clientId: string;
  host: string;
}
