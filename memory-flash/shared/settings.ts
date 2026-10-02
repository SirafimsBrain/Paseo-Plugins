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
     * Inject the memory-flash MCP server into every agent created through
     * Paseo (via the `agent.create` before-hook). Agents created outside
     * Paseo use the MCP config in their own tool.
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
