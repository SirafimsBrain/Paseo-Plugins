import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Composer attachment source: attach one vault note to a prompt as a text
 * snapshot. This is the most explicit way to pull vault content into an agent
 * turn — the user picks the note, Paseo sends the text, and nothing is read
 * opportunistically.
 */
export const searchNotesForAttachment = defineRpc({
  name: "obsidian-bridge.attachment-search",
  input: z.object({ query: z.string().trim().max(500) }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export const notesAttachmentSource = defineAttachmentSource({
  id: "obsidian-note",
  title: "Obsidian note",
  icon: "BookOpen",
  pickerTitle: "Attach an Obsidian note",
  searchPlaceholder: "Search notes, plans, research…",
  search: searchNotesForAttachment,
});
