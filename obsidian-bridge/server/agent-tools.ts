import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { RuntimeSettings } from "../shared/settings";
import { CONTRACT_SENTENCE, dispatchTool, type ToolOutcome } from "./mcp-tools";

/**
 * Attached agent tools (Paseo `defineAgentTool`).
 *
 * The MCP server reaches an agent through Paseo's MCP injection, which fails for
 * providers without MCP support and is refused when the agent's saved
 * configuration cannot be read. These tools are contributed by the plugin
 * process on every session open and delivered through Paseo's own tool
 * transport, so such an agent still gets the same three read operations.
 *
 * Names carry the `obsidian_bridge_` prefix so they can never collide with a
 * Paseo built-in, another plugin's tool, or the MCP tool names of this server.
 */

export type RuntimeSettingsReader = () => Promise<RuntimeSettings>;

function toResult(outcome: ToolOutcome) {
  return {
    text: outcome.text,
    ...(outcome.structuredContent !== undefined
      ? { structuredContent: outcome.structuredContent }
      : {}),
    ...(outcome.isError ? { isError: true } : {}),
  };
}

export function createObsidianTools(readSettings: RuntimeSettingsReader): AgentToolDefinition[] {
  const search = defineAgentTool({
    name: "obsidian_bridge_search",
    title: "Search the Obsidian vault",
    description: `${CONTRACT_SENTENCE} Hybrid search over notes and headings; returns snippets with note path and heading.`,
    input: z.object({
      query: z.string().describe("What to look for; empty lists the most recent notes."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum hits."),
      folder: z.string().trim().max(512).optional().describe("Restrict to a vault-relative folder."),
      tags: z.string().trim().max(512).optional().describe("Comma-separated required tags."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(
        dispatchTool(
          "obsidian_search",
          { query: input.query, limit: input.limit, folder: input.folder, tags: input.tags },
          settings,
        ),
      );
    },
  });

  const read = defineAgentTool({
    name: "obsidian_bridge_read",
    title: "Read an Obsidian note",
    description: `${CONTRACT_SENTENCE} Reads a note or one heading subtree.`,
    input: z.object({
      path: z.string().min(1).max(1024).describe("Vault-relative note path."),
      heading: z.string().max(512).optional().describe("Optional heading text."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(dispatchTool("obsidian_read", input, settings));
    },
  });

  const status = defineAgentTool({
    name: "obsidian_bridge_status",
    title: "Obsidian vault status",
    description:
      "Reports whether the Obsidian vault is configured, its index counts and freshness, and the read-only state.",
    input: z.object({}),
    async execute(_input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(dispatchTool("obsidian_status", {}, settings));
    },
  });

  return [search, read, status];
}
