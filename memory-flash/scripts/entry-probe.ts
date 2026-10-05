/**
 * Prints the launch command the plugin host would inject into an agent.
 *
 * Bundled into a temporary file by `scripts/e2e-entry-resolution.mjs` and run
 * with a `PASEO_HOME` pointing at a throwaway plugin home, so the resolution
 * runs against the real `server/mcp-launch.ts` code instead of a stub.
 */
import { mcpServerCommand } from "../server/mcp-launch";

process.stdout.write(JSON.stringify(mcpServerCommand()));
