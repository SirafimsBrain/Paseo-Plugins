import type { PluginServerContext } from "@getpaseo/plugin/server";

/**
 * Server entry (daemon subprocess runtime).
 *
 * Stage A1 of PLAN.md: empty contribution that only proves the plugin loads
 * and unloads cleanly. Real contributions arrive in later stages:
 * - B2: SQLite store (store.ts)
 * - D2/D3: stdio MCP server + agent.create injection
 * - E1: plugin RPC handlers
 * - F1: dashboard HTTP server
 */
export default function contribute(_server: PluginServerContext) {
  return () => {};
}
