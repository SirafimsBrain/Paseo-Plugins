import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

/**
 * Plugin settings (host-scoped, edited in Paseo Settings → Plugins →
 * Memory Flash).
 */
export const memoryFlashSettings = defineSettings({
  id: "memory-flash",
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * Inject the memory-flash MCP server into every agent Paseo opens.
     * `agent.create` writes it into the agent's saved configuration once;
     * `agent.session_open` (0.9.4) re-contributes it on every open — create,
     * resume, refresh, import — whenever the saved configuration does not
     * already carry the name. Agents created outside Paseo use the MCP config
     * in their own tool.
     */
    injectIntoAgents: z.boolean().default(true),
    /** Server name reported in the MCP `initialize` result. */
    mcpServerName: z.string().trim().min(1).max(60).default("memory-flash"),
    /** Keep at most this many content revisions per memory (10–200). */
    historyPerMemory: z.number().int().min(10).max(200).default(50),
    /** Agent id recorded on memories created via MCP when the client omits it. */
    defaultAgentId: z.string().trim().max(120).default(""),
    /**
     * Serve the MCP server over HTTP (Streamable HTTP: POST JSON-RPC
     * at `/mcp`). Remote clients authenticate with an API key
     * (`Authorization: Bearer …`); local agents keep using stdio.
     */
    httpEnabled: z.boolean().default(false),
    /** Interface to bind the HTTP MCP endpoint to. Default: loopback only. */
    httpHost: z.string().trim().min(1).max(64).default("127.0.0.1"),
    /** Port for the HTTP MCP endpoint. */
    httpPort: z.number().int().min(1).max(65535).default(8787),
  }),
});

export type MemoryFlashSettings = z.infer<(typeof memoryFlashSettings)["schema"]>;
