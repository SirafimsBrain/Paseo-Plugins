/**
 * Provenance instruction for agents a prompt command created (0.14.4).
 *
 * Paseo 0.17.x lets `agent.open.before` append instructions to one session
 * (`appendSystemPrompt`) without saving them on the agent. A prompt command hands an
 * agent a rendered template as its first message, and from inside the session that
 * message has no visible origin: nothing says a saved Command Center command produced
 * it, so an agent cannot tell "this is the task the user queued" from an ordinary
 * first prompt. The instruction names the command and the run, using the stamp the
 * plugin already writes into the agent's metadata.
 *
 * Pure and client-safe so the text is unit-tested and the server does not grow another
 * string constant.
 */

/** What the instruction needs from the run stamp. */
export interface ProvenanceInput {
  commandId: string;
  commandName: string;
  runId: string;
  at?: string;
}

/**
 * Builds the instruction, or `null` when there is no run to describe.
 *
 * `commandId` is the only required part: old stamps without a name fall back to the
 * id, and the run id is omitted when an old stamp has none.
 */
export function provenanceInstruction(stamp: ProvenanceInput | null): string | null {
  if (!stamp || stamp.commandId.trim().length === 0) return null;
  const name = stamp.commandName.trim() || stamp.commandId.trim();
  const run = stamp.runId.trim();
  const runPart = run.length > 0 ? ` (run \`${run}\`)` : "";
  return (
    `This agent was created by the Command Center command “${name}”` +
    `${runPart}. Its first message is that command's rendered template: treat it as the ` +
    "task you were started for, and keep the rest of the conversation about it unless " +
    "the user asks for something else."
  );
}
