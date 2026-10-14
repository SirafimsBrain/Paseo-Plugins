import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

/**
 * Plugin settings (host-scoped, edited in Paseo Settings → Plugins →
 * Luck Planner once the settings screen lands in stage E4; until then the
 * schema defaults apply and the server registers the values so the
 * `agent.create` hook can read them live).
 */
export const luckPlannerSettings = defineSettings({
  id: "luck-planner",
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * Inject the luck-planner MCP server into every agent created through
     * Paseo (via the `agent.create` before-hook). Agents created outside
     * Paseo use the MCP config in their own tool.
     */
    injectIntoAgents: z.boolean().default(true),
    /**
     * Server name the injected stdio server reports in `initialize`
     * (delivered through the MCP config's `env` as `LUCK_PLANNER_SERVER_NAME`;
     * the config key under which the server is registered stays
     * `luck-planner`, so tool-name prefixes never change).
     */
    mcpServerName: z.string().trim().min(1).max(60).default("luck-planner"),
  }),
});

export type LuckPlannerSettings = z.infer<(typeof luckPlannerSettings)["schema"]>;

/** Schema defaults — used when settings are not `ready` yet (e.g. hook races). */
export function defaultSettings(): LuckPlannerSettings {
  return luckPlannerSettings.schema.parse({});
}
