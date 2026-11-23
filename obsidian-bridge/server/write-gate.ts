import { readOnlyHint } from "./paths";

/**
 * The one write gate.
 *
 * `readOnly` and `maxWriteChars` are cross-cutting settings: the document tools
 * and the planning tools must refuse for the same reasons with the same
 * wording. Keeping the check in one function means a new write path cannot
 * forget it, and a message change happens once.
 */

export interface WriteLimits {
  readOnly: boolean;
  maxWriteChars: number;
}

/** Human- and agent-readable refusal, or `null` when the write may proceed. */
export function writeRefusal(limits: WriteLimits, chars: number): string | null {
  if (limits.readOnly) {
    return (
      `Writes are disabled (readOnly is on). Ask the user to turn them off: ${readOnlyHint()}`
    );
  }
  if (chars > limits.maxWriteChars) {
    return (
      `The content is ${chars} characters; the configured limit is ${limits.maxWriteChars}. ` +
      "Split it into sections."
    );
  }
  return null;
}
