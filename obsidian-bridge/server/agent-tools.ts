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
 * transport, so such an agent still gets the same operations.
 *
 * Names carry the `obsidian_bridge_` prefix so they cannot collide with a Paseo
 * built-in, another plugin's tool, or this server's own MCP tool names.
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
  const directories = defineAgentTool({
    name: "obsidian_bridge_directories",
    title: "Obsidian directories",
    description: `${CONTRACT_SENTENCE} Returns which directory is the workspace, which holds incoming sources, which is for authored documents and which is for scratch work.`,
    input: z.object({}),
    async execute(_input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_directories", {}, settings));
    },
  });

  const search = defineAgentTool({
    name: "obsidian_bridge_search",
    title: "Search the Obsidian vault",
    description: `${CONTRACT_SENTENCE} Hybrid search over notes and headings; returns snippets with note path, heading and directory role.`,
    input: z.object({
      query: z.string().describe("What to look for; empty lists the most recent notes."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum hits."),
      folder: z.string().trim().max(512).optional().describe("Restrict to a folder."),
      tags: z.string().trim().max(512).optional().describe("Comma-separated required tags."),
      scope: z.enum(["all", "workspace", "inbox", "out", "raw"]).optional().describe("Directory role filter."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_search", input, settings));
    },
  });

  const read = defineAgentTool({
    name: "obsidian_bridge_read",
    title: "Read an Obsidian note",
    description: `${CONTRACT_SENTENCE} Reads a note or one heading subtree.`,
    input: z.object({
      path: z.string().min(1).max(1024).describe("Path relative to the configured directory."),
      heading: z.string().max(512).optional().describe("Optional heading text."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_read", input, settings));
    },
  });

  const writeDocument = defineAgentTool({
    name: "obsidian_bridge_write_document",
    title: "Write an authored Obsidian document",
    description: `${CONTRACT_SENTENCE} Appends a section to a document in the out directory, creating it when missing.`,
    input: z.object({
      name: z.string().min(1).max(200).describe("File name inside the out directory."),
      title: z.string().max(200).optional().describe("Section title."),
      body: z.string().min(1).describe("Markdown to append."),
      create: z.boolean().optional().describe("Create the document when missing (default true)."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_write_document", input, settings));
    },
  });

  const writeScratch = defineAgentTool({
    name: "obsidian_bridge_write_scratch",
    title: "Write a scratch Obsidian note",
    description: `${CONTRACT_SENTENCE} Appends to a note in the raw directory for intermediate material, clarifications and notes that lose value after the work.`,
    input: z.object({
      name: z.string().min(1).max(200).describe("File name inside the raw directory."),
      title: z.string().max(200).optional().describe("Section title."),
      body: z.string().min(1).describe("Markdown to append."),
      create: z.boolean().optional().describe("Create the note when missing (default true)."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_write_scratch", input, settings));
    },
  });

  const appendInbox = defineAgentTool({
    name: "obsidian_bridge_append_inbox",
    title: "Append to the Obsidian inbox",
    description: `${CONTRACT_SENTENCE} Appends to an explicitly named note in the inbox directory — only when the user asked to add material there.`,
    input: z.object({
      name: z.string().min(1).max(200).describe("Note to append to, inside the inbox directory."),
      title: z.string().max(200).optional().describe("Section title."),
      body: z.string().min(1).describe("Markdown to append."),
      create: z.boolean().optional().describe("Create the note when missing (default true)."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_append_inbox", input, settings));
    },
  });

  const diagnose = defineAgentTool({
    name: "obsidian_bridge_diagnose",
    title: "Measure Obsidian retrieval quality",
    description: `${CONTRACT_SENTENCE} Measures recall@k of lexical versus hybrid retrieval over cases you supply.`,
    input: z.object({
      cases: z
        .array(
          z.object({
            query: z.string().min(1).max(1000),
            expected_paths: z.array(z.string()).default([]),
          }),
        )
        .max(50)
        .optional()
        .describe("Cases: a query and the note paths that must appear in the top k."),
      k: z.number().int().min(1).max(20).optional().describe("Recall cut-off."),
      semantic: z.boolean().optional().describe("Force the semantic signal on/off."),
    }),
    async execute(input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_diagnose", input, settings));
    },
  });

  const status = defineAgentTool({
    name: "obsidian_bridge_status",
    title: "Obsidian vault status",
    description:
      "Reports the configured directory and role map, index counts and freshness, and whether writes are enabled.",
    input: z.object({}),
    async execute(_input, { signal }) {
      if (signal.aborted) return { text: "Cancelled.", isError: true };
      const settings = await readSettings();
      return toResult(await dispatchTool("obsidian_status", {}, settings));
    },
  });

  return [directories, search, read, writeDocument, writeScratch, appendInbox, diagnose, status];
}
