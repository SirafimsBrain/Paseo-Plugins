/**
 * Where the running module lives — in an ESM build *and* in a CommonJS one.
 *
 * The host loads the plugin's server code by transpiling its TypeScript, and
 * that build is CommonJS: there `import.meta` is an empty object, so
 * `new URL("../dist/dashboard/", import.meta.url)` throws **"Invalid URL"**
 * and the dashboard never starts. The artifact tests never saw it, because
 * they exercise the ESM bundle (`dist/mcp-server.js`), where `import.meta.url`
 * is there — the daemon runs the CommonJS one. The stage-J2 live-daemon
 * acceptance found it: the plugin installed and reported `running`, while the
 * dashboard logged "Invalid URL" and stayed down.
 *
 * So the location is resolved through both doors: `import.meta.url` in an ESM
 * module, `__dirname` in a CommonJS one. `typeof __dirname` is safe in an ESM
 * bundle (it is a free identifier, and `typeof` on an undeclared name does
 * not throw), so one helper serves every build.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory this module lives in.
 *
 * `process.cwd()` is the last resort — it is wrong in general, but a wrong
 * path is a clearer failure than a thrown "Invalid URL" at the import site.
 */
export function moduleDirectory(): string {
  const meta = import.meta as { url?: string };
  if (typeof meta.url === "string" && meta.url.length > 0) {
    return path.dirname(fileURLToPath(meta.url));
  }
  return typeof __dirname === "string" ? __dirname : process.cwd();
}

/** A path relative to this module's directory. */
export function modulePath(...segments: string[]): string {
  return path.join(moduleDirectory(), ...segments);
}
