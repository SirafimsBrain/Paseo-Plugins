import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Filesystem locations for this plugin.
 *
 * The index deliberately lives outside the vault: it does not pollute the
 * user's note tree, is never synced, and survives plugin updates. One database
 * per vault, keyed by a short hash of the vault path.
 */

/** `$PASEO_HOME` when set, else `~/.paseo` — the same rule the daemon uses. */
export function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured.trim()
    : path.join(os.homedir(), ".paseo");
}

/** `$PASEO_HOME/plugins/obsidian-bridge`. */
export function pluginDataDir(): string {
  return path.join(paseoHome(), "plugins", "obsidian-bridge");
}

/** Settings mirror the MCP bundle and the plugin both read. */
export function settingsMirrorPath(): string {
  return path.join(pluginDataDir(), "settings.json");
}

/**
 * Normalizes the configured directory into an absolute path.
 *
 * `~`, `~/…` and relative paths are resolved against the home directory, so a
 * value typed as `.obsidian/Main/Paseo` works the same for the plugin process
 * and for the MCP server spawned by an agent (which have different working
 * directories). Returns `""` when nothing is configured.
 */
export function resolveVaultRoot(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed === "~") return path.resolve(os.homedir());
  if (trimmed.startsWith("~/")) return path.resolve(os.homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return path.resolve(os.homedir(), trimmed);
}

/** Stable per-vault identifier (12 hex chars of the absolute path's SHA-1). */
export function vaultId(vaultPath: string): string {
  return crypto.createHash("sha1").update(path.resolve(vaultPath)).digest("hex").slice(0, 12);
}

/** Directory holding one vault's index database. */
export function vaultIndexDir(vaultPath: string): string {
  return path.join(pluginDataDir(), "vaults", vaultId(vaultPath));
}

/** SQLite file of one vault's index. */
export function indexPathFor(vaultPath: string): string {
  return path.join(vaultIndexDir(vaultPath), "index.db");
}
