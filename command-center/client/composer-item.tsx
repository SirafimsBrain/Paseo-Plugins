import { useCallback } from "react";
import { useComposer, useRpc } from "@getpaseo/plugin/client";
import { Action, useToast } from "@getpaseo/plugin/client/ui";
import { saveCommand } from "../shared/commands";

/**
 * Composer control: "Save as command" (0.13.0, Paseo 0.16.0 `addComposerItem`).
 *
 * The shortest path from a prompt that just worked to a reusable Command Center
 * command: it takes the composer's current text, saves it as a prompt command in
 * the `Inbox` category, and says so. `{{input:…}}` tokens already in the text
 * are discovered by the editor on the next open, so nothing is rewritten here;
 * the command can be renamed, categorised and given a provider later.
 *
 * The host renders the pending state and reports a rejection as a toast, so a
 * failed save is never silent.
 */

/** Enough of the first line to recognise the command in the library. */
const NAME_LENGTH = 48;

function nameFor(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? "Composer prompt";
  const trimmed = firstLine.trim().replace(/\s+/g, " ");
  return trimmed.length <= NAME_LENGTH ? trimmed : `${trimmed.slice(0, NAME_LENGTH - 1)}…`;
}

export function CommandCenterComposerItem() {
  const composer = useComposer();
  const saveRpc = useRpc(saveCommand);
  const toast = useToast();

  const prompt = composer.prompt;
  const disabled = prompt.trim().length === 0;

  const onPress = useCallback(async () => {
    const template = composer.prompt;
    if (template.trim().length === 0) return;
    const now = new Date().toISOString();
    const result = await saveRpc({
      command: {
        id: `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: nameFor(template),
        type: "prompt",
        template,
        variables: [],
        steps: [],
        scope: "global",
        category: "Inbox",
        favorite: false,
        createdAt: now,
        updatedAt: now,
        useCount: 0,
      },
    });
    if (!result.saved) {
      throw new Error(result.error ?? "The command could not be saved.");
    }
    toast.show(`Saved to Command Center → Inbox: ${nameFor(template)}`, { variant: "success" });
  }, [composer, saveRpc, toast]);

  return (
    <Action
      title="Save this prompt as a Command Center command"
      icon="BookmarkPlus"
      disabled={disabled}
      onPress={onPress}
    />
  );
}
