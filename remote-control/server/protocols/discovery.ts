// Binary discovery shared by the external-window launchers (stage 0.23.10).
//
// `findExecutable` is the small PATH scan used for RDP clients and the VNC
// viewer/tools; `VNC` version fingerprinting lives in `protocols/vnc.ts`
// because it is viewer-specific.

import * as fs from "node:fs";
import * as path from "node:path";

/** Resolves the first executable of `names` found in `pathEnv`. */
export function findExecutable(names: readonly string[], pathEnv = process.env.PATH ?? ""): string | null {
  for (const name of names) {
    for (const dir of pathEnv.split(path.delimiter)) {
      if (dir.length === 0) continue;
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not this entry
      }
    }
  }
  return null;
}

/** True when `file` exists and is executable (used for custom binary paths). */
export function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
