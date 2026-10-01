import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolves the Paseo home directory (`$PASEO_HOME`, default
 * `~/.paseo`). Plugin data — settings.json written by the host,
 * the config.json with plugin paths — lives under it.
 */
export function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured
    : path.join(os.homedir(), ".paseo");
}
