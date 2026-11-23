import * as crypto from "node:crypto";
import * as fs from "node:fs";
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

/**
 * Root of a standalone installation (0.23.18).
 *
 * `obsidian-bridge-install.sh` installs the bundled server outside Paseo, into
 * `~/.agents/obsidian-bridge-mcp` by default, and sets `OBSIDIAN_BRIDGE_HOME`
 * to that directory. The settings file, the model cache and the per-vault
 * indexes then live under the installation, so a standalone server never
 * creates or writes a Paseo home that the user may not even have.
 *
 * The variable is optional: a bundle that sits next to an `install.json` — the
 * layout the installer writes — is recognised by its own path, so an agent
 * configuration that forgets the variable still resolves the right home. A
 * Paseo installation satisfies neither condition and keeps its locations
 * exactly as they were.
 */
export function bridgeHome(): string {
  const configured = (process.env.OBSIDIAN_BRIDGE_HOME ?? "").trim();
  if (configured.length > 0) return path.resolve(configured);
  return standaloneHomeFromEntry() ?? pluginDataDir();
}

/** True when this process serves a standalone installation, not the Paseo plugin. */
export function isStandaloneBridge(): boolean {
  if ((process.env.OBSIDIAN_BRIDGE_HOME ?? "").trim().length > 0) return true;
  return standaloneHomeFromEntry() !== null;
}

/**
 * Where generated data lives: `<bridgeHome>/data` standalone, `<bridgeHome>`
 * itself under Paseo (whose data directory already is a plugin-private folder).
 */
export function bridgeDataDir(): string {
  return isStandaloneBridge() ? path.join(bridgeHome(), "data") : bridgeHome();
}

/**
 * Installation root inferred from the running bundle (`dist/mcp-server.js`),
 * or `null`. Only a directory the installer created carries `install.json`.
 */
function standaloneHomeFromEntry(): string | null {
  const entry = process.argv[1];
  if (!entry) return null;
  const home = path.dirname(path.dirname(path.resolve(entry)));
  try {
    return fs.statSync(path.join(home, "install.json")).isFile() ? home : null;
  } catch {
    return null;
  }
}

/**
 * Where embedding models are cached.
 *
 * Deliberately under plugin data, never inside the checkout:
 * `transformers.js` defaults to `node_modules/@huggingface/transformers/.cache`,
 * which `paseo plugin update` replaces, so every update would re-download the
 * model (118 MB for e5-small q8).
 */
export function modelsDir(): string {
  return path.join(bridgeDataDir(), "models");
}

/**
 * Settings file the MCP bundle reads.
 *
 * Under Paseo it is the mirror the plugin writes; standalone it is the
 * installation's own `settings.json`, in the same format and with the same
 * `writtenBy` marker, so one reader serves both.
 */
export function settingsMirrorPath(): string {
  return path.join(bridgeHome(), "settings.json");
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
  return path.join(bridgeDataDir(), "vaults", vaultId(vaultPath));
}

/** SQLite file of one vault's index. */
export function indexPathFor(vaultPath: string): string {
  return path.join(vaultIndexDir(vaultPath), "index.db");
}
