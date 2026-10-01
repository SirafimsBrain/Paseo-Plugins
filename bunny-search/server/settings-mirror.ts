import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Mirrors the host's plugin settings into the file the spawned MCP
 * server process reads (`server/settings-file.ts`).
 *
 * Why this exists: the Paseo host owns the storage behind
 * `defineSettings` and only exposes it through the plugin API
 * (`settings.read()` / `settings.subscribe()`). The MCP server is
 * spawned by agent providers — outside the plugin host — so it
 * cannot use that API. It reads the same JSON file instead. The
 * plugin host therefore writes the file whenever settings change,
 * keeping the UI, the plugin RPC handlers and every agent on one
 * configuration.
 *
 * Layout: `$PASEO_HOME/plugins/bunny-search/settings.json`,
 * written as `{ revision, values }` (the layout the MCP server
 * expects). Writes are atomic (temp file + rename).
 */

export function settingsMirrorPath(): string {
  const configured = process.env.PASEO_HOME;
  const home =
    configured && configured.trim().length > 0 ? configured : path.join(os.homedir(), ".paseo");
  return path.join(home, "plugins", "bunny-search", "settings.json");
}

/**
 * Persists the effective settings values for the MCP server
 * process. Failures are the caller's to decide upon; the mirror
 * is best-effort by design (the MCP server falls back to its own
 * defaults when the file is missing).
 */
export function writeSettingsMirror(
  values: Record<string, unknown>,
  filePath: string = settingsMirrorPath(),
  revision: string = new Date().toISOString(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify({ revision, values }, null, 2);
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, payload, "utf-8");
  fs.renameSync(temp, filePath);
}
