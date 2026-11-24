import * as path from "node:path";
import { pluginDataDir } from "./paths";

/**
 * Whether a stdio launch belongs to this plugin.
 *
 * The MCP server is registered under a name (`obsidian-bridge`) and with an
 * absolute path into the plugin's own data directory. A rename of the server
 * or of its tool namespace changes the name the next version writes, but the
 * registration a previous version made keeps its old name — which the new
 * version would never find by name alone. The launch path still says whose
 * entry it is, so removal can follow the path instead of the key.
 *
 * Anything outside `$PASEO_HOME/plugins/obsidian-bridge` is never considered
 * this plugin's, so a user's own server is not touched even if it happens to
 * be called `obsidian-bridge`.
 */
export function isPluginOwnedLaunch(
  command: string | null | undefined,
  args: readonly (string | null | undefined)[] | null | undefined,
): boolean {
  const root = path.resolve(pluginDataDir());
  for (const candidate of [command, ...(args ?? [])]) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    const resolved = path.resolve(candidate);
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}
