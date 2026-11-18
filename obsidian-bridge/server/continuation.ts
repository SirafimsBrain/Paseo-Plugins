import { continuationSchema, type Continuation } from "../shared/continuation";

/**
 * Helpers for the truncation protocol.
 *
 * The protocol is transport-independent: every tool builds the same structured
 * continuation, and both MCP and Paseo's attached tools append the same text
 * marker. A client that renders only `text` therefore sees the exact next call,
 * and a client that renders only `structuredContent` sees the same object.
 */

/** Tools an `obsidian_continue` call is allowed to re-run. Kept explicit so a
 * continuation can never become a general tool-caller. */
export const CONTINUATION_TARGETS: ReadonlySet<string> = new Set([
  "obsidian_search",
  "obsidian_read",
  "obsidian_list",
  "plan_validate",
]);

export interface OutcomeLike {
  text: string;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ContinuationOutcome {
  text: string;
  structuredContent: Record<string, unknown>;
}

export function makeContinuation(
  call: Continuation["call"],
  reason: Continuation["reason"],
  omitted: number,
  hint: string,
): Continuation {
  return { call, reason, omitted: Math.max(0, omitted), hint };
}

/** The exact call an agent has to make, printed into the text channel too. */
export function continuationLine(continuation: Continuation): string {
  const payload = JSON.stringify({ continuation });
  return `[TRUNCATED] ${continuation.hint} Next call: obsidian_continue ${payload}`;
}

/** Attaches truncation metadata to a tool result. */
export function withTruncation(
  value: Record<string, unknown>,
  continuation: Continuation | null,
  textOverride?: string,
): ContinuationOutcome {
  const structuredContent: Record<string, unknown> = {
    ...value,
    truncated: continuation !== null,
    continuation,
  };
  const base = textOverride ?? JSON.stringify(structuredContent, null, 2);
  const text = base + (continuation ? `\n\n${continuationLine(continuation)}` : "");
  return { text, structuredContent };
}

/**
 * Normalizes an outcome at the transport boundary: when a tool produced a
 * continuation but its text channel does not carry the marker, append it.
 * This is what makes the protocol work for clients that only show `text`.
 */
export function normalizeTruncation<T extends OutcomeLike>(outcome: T): T {
  const structured = outcome.structuredContent;
  if (!structured || typeof structured !== "object") return outcome;
  const candidate = (structured as Record<string, unknown>).continuation;
  if (candidate === undefined || candidate === null) return outcome;
  const parsed = continuationSchema.safeParse(candidate);
  if (!parsed.success || outcome.text.includes("[TRUNCATED]")) return outcome;
  return { ...outcome, text: `${outcome.text}\n\n${continuationLine(parsed.data)}` };
}

export interface TextWindow {
  text: string;
  omittedBefore: number;
  omittedAfter: number;
}

/** Character window for a large note body, with monotonic offsets. */
export function windowText(text: string, charOffset: number, maxChars: number | null): TextWindow {
  const start = Math.max(0, Math.min(text.length, Math.trunc(charOffset)));
  const end = maxChars === null ? text.length : Math.min(text.length, start + Math.max(1, Math.trunc(maxChars)));
  return {
    text: text.slice(start, end),
    omittedBefore: start,
    omittedAfter: text.length - end,
  };
}
