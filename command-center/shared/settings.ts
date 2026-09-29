import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

/**
 * Plugin settings (host-scoped, edited in Paseo Settings → Plugins → Command
 * Center). Shared definition object: the server registers it via
 * `server.registerSettings`, the client reads it via `useSettings`.
 */
export const commandCenterSettings = defineSettings({
  id: "command-center",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Max history entries kept in history.json (10–500). */
    historyLimit: z.number().int().min(10).max(500).default(50),
    /** Default provider/model reference prefilled for new prompt commands. */
    defaultProvider: z.string().trim().max(200).default(""),
    /**
     * Automation: run this command (with template defaults) every time an agent
     * turn completes successfully. Empty = disabled. The command must be a
     * prompt command; runs land in the shared history.
     */
    autoRunCommandOnTurnEnd: z.string().trim().max(120).default(""),
    /**
     * Automation: run this command in every newly created workspace (workspace
     * bootstrap: install deps, lint, etc.). Empty = disabled.
     */
    bootstrapCommand: z.string().trim().max(120).default(""),
  }),
});

export type CommandCenterSettings = z.infer<(typeof commandCenterSettings)["schema"]>;
