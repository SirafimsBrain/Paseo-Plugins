import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../shared/settings";
import { settingsMirrorPath } from "./paths";

/**
 * Mirrors the host's settings store into a file the spawned MCP server can
 * read. The host owns the store; the plugin process is the only writer of this
 * file, and it writes atomically (temp file + rename) so a concurrently
 * spawning agent never reads a half-written document.
 */
export function writeSettingsMirror(values: RuntimeSettings, filePath?: string): string {
  const target = filePath ?? settingsMirrorPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = JSON.stringify({ values, writtenAt: new Date().toISOString() }, null, 2);
  const temp = `${target}.${process.pid}.tmp`;
  // 0600: the document carries the Local REST API key when enrichment is on.
  fs.writeFileSync(temp, body, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
  return target;
}

export { settingsMirrorPath };
