import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings of the plugin. Every field carries a default, because
 * Paseo parses the stored document (an empty object on a fresh install) with
 * this schema before the client ever sees it.
 */
export const settingsSchema = z.object({
  /**
   * Age threshold used by the "cleanup due" hint in the panel. `0` disables the
   * hint: the plugin never deletes anything on its own.
   */
  cleanupDays: z.union([z.literal(0), z.literal(30), z.literal(90)]).default(30),
  /** Default order of the session list: oldest first suits cleanup work. */
  sortOldestFirst: z.boolean().default(true),
  /** Pre-select "Export before delete" in the confirmation block. */
  exportBeforeDelete: z.boolean().default(false),
});

export type SessionManagerSettings = z.infer<typeof settingsSchema>;

export const sessionManagerSettings = defineSettings({
  id: "session-manager",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const DEFAULT_SETTINGS: SessionManagerSettings = settingsSchema.parse({});

export const CLEANUP_DAY_OPTIONS = [
  { label: "Off", value: "0" },
  { label: "Older than 30 days", value: "30" },
  { label: "Older than 90 days", value: "90" },
] as const;

/** Converts the settings value of `cleanupDays` to the number the panel uses. */
export function cleanupDaysOf(value: string): 0 | 30 | 90 {
  return value === "0" ? 0 : value === "90" ? 90 : 30;
}
