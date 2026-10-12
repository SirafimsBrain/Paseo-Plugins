import type { PluginClientContext } from "@getpaseo/plugin/client";

/**
 * Client entry (Paseo app runtime).
 *
 * Stage A1 of PLAN.md: empty contribution that only proves the plugin loads
 * and unloads cleanly. Real contributions arrive in later stages:
 * - E2: workspace panel (tree outline)
 * - E3: Command Center items and slash commands
 * - E4: settings screen
 * - F2: "Open dashboard" action
 */
export default function contribute(_client: PluginClientContext) {
  return () => {};
}
