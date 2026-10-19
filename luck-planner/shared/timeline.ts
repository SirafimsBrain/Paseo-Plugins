import { z } from "zod";
import { actorSchema, idSchema, projectKeySchema, timestampSchema } from "./tree";

/**
 * Agent timeline rows (PLAN.md stage H2, `__doc.md` §6).
 *
 * The plugin daemon pushes a row into an agent's timeline with
 * `paseo.agents.ref(id).timeline.append(...)`, and the app draws it with the
 * renderer registered under the same `kind`/`version` and validated by the
 * same schema — that pairing is what keeps the row from rendering as
 * "Plugin timeline item unavailable".
 *
 * Contract rules inherited from the SDK (plugin reference → "Append a
 * timeline row from the daemon"):
 * - `data` is capped at **64 KiB serialized** and rejected above that, so
 *   {@link buildTimelineItem} clamps every field and measures the finished
 *   JSON in bytes (UTF-8, escapes included) before returning.
 * - Re-appending under the same `id` replaces the earlier row, so the id is
 *   derived from the audit fact itself (`event + entity + revision`): the
 *   same transition never duplicates, a later transition gets a new row.
 * - The daemon stamps `pluginId`; only plugin code can append.
 *
 * Client/server neutral: zod, plain values, no Node, no React (the `shared/`
 * import-boundary test enforces this).
 */

/** Renderer `kind` — must match `client.addTimelineRenderer` exactly. */
export const LUCK_PLANNER_TIMELINE_KIND = "luck-planner-event";

/** Renderer `version` — bump together with a breaking `timelineDataSchema`. */
export const LUCK_PLANNER_TIMELINE_VERSION = 1;

/** SDK hard limit for one row's `data`, serialized. */
export const MAX_TIMELINE_DATA_BYTES = 64 * 1024;

/**
 * What happened. Two facts only (PLAN.md H2): a goal crossed the approval
 * gate, and a leaf reached `done`.
 */
export const timelineEventSchema = z.enum(["goal-approved", "leaf-done"]);
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

/**
 * One row's payload. Fields are always present (an absent note is `""`) so
 * the JSON shape stays flat and the renderer never meets an `undefined`.
 */
export const timelineDataSchema = z.object({
  event: timelineEventSchema,
  projectKey: projectKeySchema,
  entityId: idSchema,
  /** Entity display name — node name or goal formal text (clamped). */
  name: z.string(),
  /** Audit actor of the fact: an agent id, or `user`. */
  actor: actorSchema,
  /** When the fact happened (epoch ms, the audit row's timestamp). */
  at: timestampSchema,
  /** Short context: `in_progress → done`, `3 steps`. */
  note: z.string(),
});
export type TimelineData = z.infer<typeof timelineDataSchema>;

/**
 * What {@link buildTimelineItem} returns — structurally the `plugin` timeline
 * item the SDK's `timeline.append` accepts (minus the `pluginId` the daemon
 * stamps itself).
 */
export interface TimelineItem {
  type: "plugin";
  id: string;
  kind: string;
  version: number;
  data: TimelineData;
}

export interface TimelineRowInput {
  event: TimelineEvent;
  projectKey: string;
  entityId: string;
  revision: number;
  name: string;
  actor: string;
  at: number;
  note: string;
}

/**
 * Per-field clamps, in bytes of UTF-8. Their sum is the proof the cap holds:
 * JSON escaping turns one character into at most six ASCII bytes (`\u0000`),
 * so the five fields below serialize to at most
 * (2048 + 1024 + 512 + 256 + 128) × 6 ≈ 24 KiB — under half the 64 KiB the
 * SDK rejects above, on the worst input a node name can carry. The adversarial
 * case in `tests/timeline.test.ts` measures the real number.
 */
const FIELD_LIMITS = {
  projectKey: 1024,
  entityId: 128,
  name: 2048,
  actor: 256,
  note: 512,
} as const;

/** UTF-8 byte length of a string, surrogate pairs counted as one code point. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Cuts `text` to at most `maxBytes` of UTF-8 without splitting a code point.
 * An empty budget yields an empty string; `maxBytes` below 0 behaves the same.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let cut = "";
  for (const char of text) {
    const size = utf8ByteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    cut += char;
  }
  return cut;
}

/** Serialized size of a row's `data` in bytes — the SDK's 64 KiB measure. */
export function timelineDataBytes(data: TimelineData): number {
  return utf8ByteLength(JSON.stringify(data));
}

/**
 * Builds one timeline row, guaranteed to fit the SDK's data cap.
 *
 * Every field is measured in bytes before it enters the payload (see
 * {@link FIELD_LIMITS} for the arithmetic), so the result is deterministic:
 * a real name survives intact up to 2 KiB and a monstrous one is cut, never
 * rejected — a row that never arrives is worse than a short one.
 */
export function buildTimelineItem(input: TimelineRowInput): TimelineItem {
  const data: TimelineData = {
    event: input.event,
    projectKey: truncateToBytes(input.projectKey, FIELD_LIMITS.projectKey),
    entityId: truncateToBytes(input.entityId, FIELD_LIMITS.entityId),
    name: truncateToBytes(input.name, FIELD_LIMITS.name),
    actor: truncateToBytes(input.actor, FIELD_LIMITS.actor),
    at: input.at,
    note: truncateToBytes(input.note, FIELD_LIMITS.note),
  };
  return {
    type: "plugin",
    // Lowercase letters, digits and hyphens only — the id is stored by the
    // daemon next to host-generated ids.
    id: `lp-${input.event}-${input.entityId}-r${input.revision}`,
    kind: LUCK_PLANNER_TIMELINE_KIND,
    version: LUCK_PLANNER_TIMELINE_VERSION,
    data,
  };
}

/**
 * `2026-10-19 09:12` in the renderer's local time. Deliberately not
 * `toLocaleString`: the app bundle has no locale guarantee and mobile
 * runtimes vary, while the row only needs a readable minute-level stamp.
 */
export function formatTimelineTime(at: number): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = new Date(at);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// ── Row view-model (rendered by `client/timeline-row.tsx`) ─────────────
//
// Wording lives here, not in the component, for the same reason
// `shared/panel.ts` holds the panel's labels: the tests must be able to read
// what a row says without importing React Native (vitest cannot load the
// Flow-typed `react-native` package).

/** Headline per event — the only place event wording lives. */
export const TIMELINE_EVENT_LABELS: Record<TimelineEvent, string> = {
  "goal-approved": "Goal approved",
  "leaf-done": "Leaf done",
};

/** Emoji glyph per event; the text label carries the meaning on its own. */
export const TIMELINE_EVENT_GLYPHS: Record<TimelineEvent, string> = {
  "goal-approved": "🎯",
  "leaf-done": "✅",
};

export interface TimelineRowText {
  glyph: string;
  /** `Goal approved` */
  label: string;
  /** `retry failed charges` — the entity's name. */
  name: string;
  /** `2026-10-19 09:12 · by you · in_progress → done` */
  meta: string;
}

/**
 * Pure text behind one rendered row: the event spelled out (never color
 * alone), the entity name, and a stamp line that names the actor as the
 * reader knows themselves (`user` → "you").
 */
export function timelineRowText(data: TimelineData): TimelineRowText {
  const actor = data.actor === "user" ? "you" : data.actor;
  const stamp = formatTimelineTime(data.at);
  return {
    glyph: TIMELINE_EVENT_GLYPHS[data.event],
    label: TIMELINE_EVENT_LABELS[data.event],
    name: data.name,
    meta: `${stamp} · by ${actor}${data.note === "" ? "" : ` · ${data.note}`}`,
  };
}
