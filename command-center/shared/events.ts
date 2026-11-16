import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Live activity feed (Paseo 0.16.0 `defineSubscription`, plugin 0.13.0).
 *
 * The Command Center knows when something happened — a run was dispatched, a
 * schedule was created/paused/run/deleted, an agent session was provisioned —
 * but until now the screen only saw it on the next manual reload. This contract
 * turns those moments into a push: the History and Schedules tabs refresh
 * themselves, and the dashboard shows a small "live activity" list.
 *
 * Every event carries the whole current feed, so a subscriber that missed an
 * event (a reconnect, a screen opened after the fact) is still correct after the
 * next one.
 */
export const commandEventKindSchema = z.enum(["run", "schedule", "provisioning"]);

export type CommandEventKind = z.infer<typeof commandEventKindSchema>;

export const commandEventSchema = z.object({
  id: z.string(),
  kind: commandEventKindSchema,
  at: z.string(),
  /** Short headline: the command or schedule name, or the agent id. */
  title: z.string(),
  /** One line of context: target, action, or the provisioning reason. */
  detail: z.string(),
  /** `true`/`false` for a run or provisioning decision, `null` when N/A. */
  ok: z.boolean().nullable(),
});

export type CommandEvent = z.infer<typeof commandEventSchema>;

/** How many events the feed keeps (and sends on every push). */
export const EVENT_FEED_LIMIT = 20;

export const eventsStream = defineSubscription({
  name: "command-center.events",
  input: z.object({}),
  event: z.object({
    at: z.string(),
    /** The event that just happened; null for the snapshot sent on subscribe. */
    event: commandEventSchema.nullable(),
    /** Newest-first feed, at most {@link EVENT_FEED_LIMIT} entries. */
    recent: z.array(commandEventSchema),
  }),
});
