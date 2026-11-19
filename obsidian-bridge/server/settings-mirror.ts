import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../shared/settings";
import { settingsMirrorPath } from "./paths";

import { MIRROR_MARKER_KEY, MIRROR_MARKER_VALUE } from "./settings-file";

/**
 * Mirrors the host's settings store into a file the spawned MCP server can
 * read. The host owns the store; the plugin process is the only writer of this
 * file, and it writes atomically (temp file + rename) so a concurrently
 * spawning agent never reads a half-written document.
 *
 * The document is a **record of values**, not an order: it carries the marker
 * `writtenBy: "obsidian-bridge"`, and the reader (`server/settings-file.ts`)
 * accepts only a regular, user-owned, non-group-writable file with that marker.
 * Any other JSON at the same path is ignored as a whole (0.20.13).
 */
export function writeSettingsMirror(values: RuntimeSettings, filePath?: string): string {
  const target = filePath ?? settingsMirrorPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = JSON.stringify(
    { [MIRROR_MARKER_KEY]: MIRROR_MARKER_VALUE, values, writtenAt: new Date().toISOString() },
    null,
    2,
  );
  const temp = `${target}.${process.pid}.tmp`;
  // 0600: the document carries the Local REST API key when enrichment is on.
  // 0600 is also what the reader requires: user-owned, not group/other writable.
  fs.writeFileSync(temp, body, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
  return target;
}

export { settingsMirrorPath };
