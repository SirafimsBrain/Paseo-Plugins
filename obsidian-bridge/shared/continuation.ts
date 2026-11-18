import { z } from "zod";

/**
 * Truncation contract shared by the MCP server, attached Paseo tools and the UI.
 *
 * A tool that cannot return everything it found returns `truncated: true` and a
 * `continuation` object. The object is a ready-made call: the agent copies it
 * into `obsidian_continue` unchanged, so a shorter answer never turns into a
 * guess about offsets, paths or file access.
 */
export const continuationSchema = z.object({
  call: z.object({
    /** Exact tool name to re-run; always one of CONTINUATION_TARGETS. */
    tool: z.string().min(1),
    /** Exact arguments for that tool, already normalized by the plugin. */
    arguments: z.record(z.string(), z.unknown()),
  }),
  /** Why this result was cut; explains the extra call to the agent. */
  reason: z.enum(["char_budget", "max_results", "note_window", "list_window", "issue_window"]),
  /** How many items or characters were not shown. */
  omitted: z.number().int().nonnegative(),
  /** One-line explanation included in both the text and the structured result. */
  hint: z.string().min(1),
});

export type Continuation = z.infer<typeof continuationSchema>;

/** Fields added to a tool result that can be truncated. */
export interface TruncationFields {
  truncated: boolean;
  continuation: Continuation | null;
}
