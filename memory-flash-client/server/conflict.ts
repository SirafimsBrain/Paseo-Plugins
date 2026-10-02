import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConflictCheck } from "../shared/contracts";

/**
 * Coexistence check between memory-flash-client and memory-flash.
 *
 * The two plugins are not mutually exclusive: a machine may act as a
 * memory host (memory-flash) and simultaneously connect to *other*
 * memory hosts (memory-flash-client). The check therefore reports the
 * situation explicitly rather than treating it as an error, so a user
 * who installed both understands why two plugins are active.
 *
 * A *real* conflict would be the same MCP server name being injected into
 * one agent twice, or two memory-flash instances sharing one database.
 * Neither happens with the current design (the host plugin injects a
 * stdio server, the client injects HTTP servers under its own names), so
 * `conflict` is currently always false — it is computed here rather than
 * hard-coded so a future overlap has a place to surface.
 *
 * Detection is filesystem-based (no daemon RPC needed): the Paseo config
 * lists the plugins registered on this host, and each plugin keeps its
 * data under `$PASEO_HOME/plugins/<id>`.
 */

/** The one plugin id that may own a memory database on a host. */
const MEMORY_FLASH_ID = "memory-flash";

function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured
    : path.join(os.homedir(), ".paseo");
}

/** Reads the Paseo config file (`$PASEO_HOME/config.json`). */
function readPaseoConfig(): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(paseoHome(), "config.json"), "utf-8"),
    );
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when the memory-flash plugin is registered and enabled on this host. */
function isMemoryFlashRegistered(): boolean {
  const config = readPaseoConfig();
  if (!config) return false;
  const plugins = config.plugins as Record<string, { enabled?: unknown }> | undefined;
  if (!plugins || typeof plugins !== "object") return false;
  const entry = plugins[MEMORY_FLASH_ID];
  return entry !== undefined && entry.enabled !== false;
}

/** True when this host also holds a memory-flash data directory. */
function hasMemoryFlashData(): boolean {
  try {
    return fs.existsSync(path.join(paseoHome(), "plugins", MEMORY_FLASH_ID));
  } catch {
    return false;
  }
}

/**
 * Reports whether memory-flash is present on this host next to the
 * client, and whether that is a real conflict (it is not today).
 */
export function checkConflict(): ConflictCheck {
  const installed = isMemoryFlashRegistered() || hasMemoryFlashData();
  return {
    conflict: false,
    memoryFlashInstalled: installed,
    singleMemoryHost: true,
    note: installed
      ? "memory-flash and memory-flash-client run on this host — this is allowed. " +
        "Agents here get the local stdio memory server; the client adds remote HTTP memory hosts alongside it."
      : "memory-flash is not installed on this host — this installation only connects to remote memory hosts.",
  };
}
