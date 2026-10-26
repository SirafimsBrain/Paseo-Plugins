// Imported Ghostty settings (stage B1, orca PR #1001 scheme).
//
// These are the subset of Ghostty keys the plugin understands and applies to
// the `ghostty-web` terminal runtime (stage B2). Every other key found in the
// user's system config is reported as `ignored` by the mapper rather than
// dropped silently — see server/ghostty-config.ts.

import { z } from "zod";

export const cursorStyleSchema = z.enum(["block", "bar", "underline", "underline-block"]);
export type CursorStyle = z.infer<typeof cursorStyleSchema>;

export const ghosttyPaddingSchema = z.object({
  top: z.number().int().nonnegative().optional(),
  right: z.number().int().nonnegative().optional(),
  bottom: z.number().int().nonnegative().optional(),
  left: z.number().int().nonnegative().optional(),
});
export type GhosttyPadding = z.infer<typeof ghosttyPaddingSchema>;

export const ghosttySettingsSchema = z.object({
  fontFamily: z.string().min(1).optional(),
  fontSize: z.number().positive().optional(),
  theme: z.string().min(1).optional(),
  background: z.string().min(1).optional(),
  foreground: z.string().min(1).optional(),
  palette: z.array(z.string()).optional(),
  cursorStyle: cursorStyleSchema.optional(),
  cursorBlink: z.boolean().optional(),
  cursorColor: z.string().min(1).optional(),
  scrollback: z.number().int().nonnegative().optional(),
  windowPadding: ghosttyPaddingSchema.optional(),
});
export type GhosttySettings = z.infer<typeof ghosttySettingsSchema>;

export const ghosttyImportPreviewSchema = z.object({
  found: z.boolean(),
  path: z.string().nullable(),
  settings: ghosttySettingsSchema,
  ignored: z.array(z.string()),
  errors: z.array(z.string()),
});
export type GhosttyImportPreview = z.infer<typeof ghosttyImportPreviewSchema>;
