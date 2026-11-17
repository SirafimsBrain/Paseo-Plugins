import { useCallback } from "react";
import { useComposer, useRpc } from "@getpaseo/plugin/client";
import { Action } from "@getpaseo/plugin/client/ui";
import { citationBlock } from "../shared/citations";
import { searchVaultRpc } from "../shared/contracts";

/**
 * Composer control: "insert note links for this prompt" (0.9.11, Paseo 0.16.0
 * `addComposerItem`).
 *
 * The attachment source attaches a whole note, which is the right gesture when
 * the agent should read one document. Often what a prompt needs is smaller: a
 * citation to the notes the draft is about, so the agent can open exactly the
 * sections it was pointed at. This control searches the draft through the same
 * index the agents use and inserts one `[[note#heading|title]]` line per hit at
 * the cursor — editable text, not an attachment, and nothing is read or written
 * in the vault.
 *
 * It is a plain `Action` from `@getpaseo/plugin/client/ui`: the host renders it
 * with the other composer controls, keeps it pending while the promise settles,
 * and reports a rejection as a toast.
 */

/** Longest draft fragment sent as a query; the search packs far less anyway. */
const MAX_QUERY_LENGTH = 512;

/** How many notes the control offers; a prompt rarely needs more. */
const HIT_LIMIT = 5;

export function ObsidianCiteComposerItem() {
  const composer = useComposer();
  const searchRpc = useRpc(searchVaultRpc);

  const draft = composer.prompt.trim();

  const onPress = useCallback(async () => {
    const query = draft.slice(0, MAX_QUERY_LENGTH);
    if (query.length === 0) return;
    const result = await searchRpc({ query, limit: HIT_LIMIT });
    if (result.hits.length === 0) {
      throw new Error(result.note ?? "No note in the vault matched this prompt.");
    }
    // `insertText` inserts at the cursor, replacing a selection, so the links
    // land where the user was typing rather than at the end of the draft.
    composer.insertText(citationBlock(result.hits));
  }, [composer, draft, searchRpc]);

  return (
    <Action
      title="Insert Obsidian note links for this prompt"
      icon="Link"
      disabled={draft.length === 0}
      onPress={onPress}
    />
  );
}
