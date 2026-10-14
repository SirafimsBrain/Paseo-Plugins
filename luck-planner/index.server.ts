import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveMcpEntry } from "./server/mcp-launch";

/**
 * Server entry (daemon subprocess runtime).
 *
 * Contributions by stage (PLAN.md):
 * - D2 (done): publish the stdio MCP bundle at its revision-independent path
 * - D3: inject the MCP server into created agents + skill installer
 * - E1: plugin RPC handlers
 * - F1: dashboard HTTP server
 */
export default function contribute(_server: PluginServerContext) {
  // Publish the bundle at its revision-independent path on every plugin
  // load, not only when an agent is created: agents created before an
  // update hold that path in their config and re-spawn from it on every
  // turn, so it has to be current before the first turn of the day. This is
  // the memory-flash 0.7.1 lesson — see `server/mcp-launch.ts`.
  const entry = resolveMcpEntry();
  console.log(`[luck-planner] MCP entry: ${entry}`);

  return () => {};
}
