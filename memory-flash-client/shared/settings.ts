import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Plugin settings for memory-flash-client (host-scoped, edited in
 * Paseo Settings → Plugins → Memory Flash Client).
 *
 * Only the *client identity* lives in settings; the list of memory hosts
 * and their API keys lives in a `connections.json` file next to the
 * plugin data (see `server/connections.ts`) so that the file-per-connection
 * model matches memory-flash's `hosts.json` and a single user can be
 * granted the UI without exposing the settings store.
 *
 * Identity = UUID + hostname. The UUID is generated once (first startup
 * or via the "Regenerate" action in the UI) and never changes unless the
 * user asks; the hostname defaults to `os.hostname()` and can be
 * overridden (e.g. "studio-laptop").
 */
export const memoryFlashClientSettings = defineSettings({
  id: "memory-flash-client",
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * Inject the remote memory MCP server(s) into every agent created
     * through Paseo (via the `agent.create` before-hook). When off, the
     * connections are only reachable from the surface.
     */
    injectIntoAgents: z.boolean().default(true),
    /**
     * Stable client UUID sent as `X-Memory-Flash-Client-Id` on every
     * remote request. Generated once and then kept stable; the identity
     * lets the memory host tell several clients apart in its audit log.
     */
    clientId: z.string().trim().min(8).max(64).default(""),
    /**
     * Human-readable host name sent as `X-Memory-Flash-Host`. Defaults
     * to the machine's `os.hostname()` on first run.
     */
    hostname: z.string().trim().min(1).max(80).default(""),
    /**
     * MCP server name prefix used when injecting the remote memory
     * servers into agents. With a single connection the name is exactly
     * this value (e.g. `memory-flash`); with several it becomes
     * `<prefix>-<connectionId>`, so a host can talk to more than one
     * memory server without name collisions.
     */
    mcpServerName: z.string().trim().min(1).max(60).default("memory-flash"),
    /**
     * Send the identity headers on requests. Disable only to silence a
     * memory host that does not understand them; the API key alone is
     * always sufficient for authentication.
     */
    sendIdentityHeaders: z.boolean().default(true),
  }),
});

export type MemoryFlashClientSettings = z.infer<
  (typeof memoryFlashClientSettings)["schema"]
>;
