import { useCallback } from "react";
import { useComposer, useRpc } from "@getpaseo/plugin/client";
import { Action } from "@getpaseo/plugin/client/ui";
import { runSearch } from "../shared/contracts";

/**
 * Composer control: "search the draft" (0.7.5, Paseo 0.16.0 `addComposerItem`).
 *
 * A user typing "why does vitest fail with ESM ..." often wants one specific
 * thing before sending: an actual answer from the web. This control takes the
 * prompt the user already typed, runs it through the configured provider, and
 * inserts the formatted results into the composer — so the agent starts from
 * real sources instead of its own memory, and the user can read and edit what
 * was added before sending.
 *
 * It is a plain `Action` from `@getpaseo/plugin/client/ui`: the host renders it
 * with the other composer controls, keeps it pending while the promise settles
 * and reports a rejection (a provider error) as a toast. The prompt is sent
 * as-is, capped so a huge draft does not become a search query.
 */

/** Longest draft fragment sent as a query; providers truncate far below this. */
const MAX_QUERY_LENGTH = 512;

export function BunnySearchComposerItem() {
  const composer = useComposer();
  const searchRpc = useRpc(runSearch);

  const draft = composer.prompt.trim();

  const onPress = useCallback(async () => {
    const query = draft.slice(0, MAX_QUERY_LENGTH);
    if (query.length === 0) return;
    const result = await searchRpc({ query });
    if (!result.ok || !result.text) {
      throw new Error(result.error ?? "Search failed (see plugin logs).");
    }
    // `insertText` inserts at the cursor, replacing a selection, so the results
    // land where the user was typing rather than at the end of the draft.
    composer.insertText(`\n${result.text}\n`);
  }, [composer, draft, searchRpc]);

  return (
    <Action
      title="Search the web for this draft"
      icon="Search"
      disabled={draft.length === 0}
      onPress={onPress}
    />
  );
}
